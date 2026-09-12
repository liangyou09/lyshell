import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import type { SessionConfig, PaneNode, QuickCommand, TerminalEncoding } from '@shared/types'
import { TERMINAL_WEBFONT_FAMILY, TERMINAL_ENCODINGS } from '@shared/constants'
import { useSessionStore } from '../../stores/session-store'
import { usePaneStore, findPane } from '../../stores/pane-store'
import SessionDialog from '../SessionDialog/SessionDialog'
import ExportImportDialog from '../ExportImportDialog/ExportImportDialog'
import FileManagerPanel from '../FileManager/FileManagerPanel'
import QuickCommandsPanel from '../QuickCommands/QuickCommandsPanel'
import TerminalSize, { BarRule } from './TerminalSize'
import { TOPBAR_HEIGHT } from './topbar-metrics'
import { IconBtn, IconPlus } from './IconBtn'
import { evaluateStatusbarCompact, type StatusbarCompactState } from './statusbar-compact'
import { useQuickCommandsStore } from '../../stores/quick-commands-store'
import { useUiStore } from '../../stores/ui-store'
import { useDismiss } from '../../hooks'
import i18n from '../../i18n'

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

interface SessionsPanelProps {
  onConnect?: (sessionId: string, config: SessionConfig) => void
  /** 快捷命令派发：写入活动分屏的活动会话（由 MainWindow 提供,规则见 utils/dispatch-command） */
  onExecuteCommand?: (cmd: QuickCommand) => void
  /** dsh web 接管活动分屏时置灰键帽、禁发（F 键侧由 MainWindow 监听器拦截） */
  quickCommandsDisabled?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

const getHostIP = (config: SessionConfig) => {
  if (!config) return 'unknown'
  if (config.ssh) return config.ssh.host
  if (config.telnet) return config.telnet.host
  if (config.serial) return config.serial.path
  if (config.local) return config.local.cwd || 'local'
  return 'unknown'
}

// 子网分组键 —— IPv4 主机折成 /24,其余(主机名 / 串口路径 / local cwd)保持原值各自成组
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/
const getGroupKey = (config: SessionConfig): string => {
  const host = getHostIP(config)
  const m = host.match(IPV4_RE)
  if (m) return `${m[1]}.${m[2]}.${m[3]}.0/24`
  return host
}

// 状态栏字体栈 —— Maple 优先(圆角等宽、笔画粗,12px 小字号读数清晰),与终端 webfont 同源。
// 状态栏容器与编码选择菜单两处共用一份:菜单是 portal 挂 body 的(不随容器继承),
// 字面量复制两份会漂移 —— 菜单值必须和读数同字形才读得出"选的就是显示的这个"
const STATUSBAR_FONT_STACK = `'${TERMINAL_WEBFONT_FAMILY}', 'Cascadia Mono', Consolas, 'Microsoft YaHei', monospace`

// 四种协议的展示元信息 —— label / 完整 tailwind class(必须是字面量,Tailwind 才能扫到)
type ProtoKind = 'ssh' | 'telnet' | 'serial' | 'local'
const PROTO_KINDS: ProtoKind[] = ['ssh', 'telnet', 'serial', 'local']
const PROTO_LABEL: Record<ProtoKind, string> = {
  ssh: 'SSH', telnet: 'TEL', serial: 'SER', local: 'LOC'
}
// 会话行内的协议标签文字色 —— 全饱和,跟左侧色条配合,文字本身也读得出"这是什么协议"
const PROTO_TEXT_CLS: Record<ProtoKind, string> = {
  ssh:    'text-[var(--proto-ssh)]',
  telnet: 'text-[var(--proto-tel)]',
  serial: 'text-[var(--proto-ser)]',
  local:  'text-[var(--proto-loc)]',
}
// 筛选 chip = LED 通道条。状态 100% 由 LED 承载,文字恒定不随状态变色——
// 这样"选中亮 / 未选中暗"的振荡止于 LED,标签与计数在两态下同等可读。
// 注意:Tailwind 对 var(--x)/N 斜杠透明度静默不生成,故全部改用 color-mix 任意值整包写法。
// 选中:无 flood(透明底) + 满色 border-2(协议色)——用 border 而非 ring,与未选中同位置同占位,尺寸一致
const PROTO_ACTIVE_CLS: Record<ProtoKind, string> = {
  ssh:    'bg-transparent border-[color-mix(in_srgb,var(--proto-ssh)_100%,transparent)]',
  telnet: 'bg-transparent border-[color-mix(in_srgb,var(--proto-tel)_100%,transparent)]',
  serial: 'bg-transparent border-[color-mix(in_srgb,var(--proto-ser)_100%,transparent)]',
  local:  'bg-transparent border-[color-mix(in_srgb,var(--proto-loc)_100%,transparent)]',
}
// 未选中:透明底 + 协议色边框(32%)——和选中同不填充,纯靠边框深浅区分;hover 边框提到 50%
const PROTO_IDLE_CLS: Record<ProtoKind, string> = {
  ssh:    'bg-transparent border-[color-mix(in_srgb,var(--proto-ssh)_32%,transparent)] hover:border-[color-mix(in_srgb,var(--proto-ssh)_50%,transparent)]',
  telnet: 'bg-transparent border-[color-mix(in_srgb,var(--proto-tel)_32%,transparent)] hover:border-[color-mix(in_srgb,var(--proto-tel)_50%,transparent)]',
  serial: 'bg-transparent border-[color-mix(in_srgb,var(--proto-ser)_32%,transparent)] hover:border-[color-mix(in_srgb,var(--proto-ser)_50%,transparent)]',
  local:  'bg-transparent border-[color-mix(in_srgb,var(--proto-loc)_32%,transparent)] hover:border-[color-mix(in_srgb,var(--proto-loc)_50%,transparent)]',
}
// LED 点亮态:满色 + 静态光晕(color-mix 取 50% 协议色;无脉冲——LIVE 段才呼吸)
const PROTO_LED_LIT_CLS: Record<ProtoKind, string> = {
  ssh:    'bg-[var(--proto-ssh)] shadow-[0_0_6px_color-mix(in_srgb,var(--proto-ssh)_50%,transparent)]',
  telnet: 'bg-[var(--proto-tel)] shadow-[0_0_6px_color-mix(in_srgb,var(--proto-tel)_50%,transparent)]',
  serial: 'bg-[var(--proto-ser)] shadow-[0_0_6px_color-mix(in_srgb,var(--proto-ser)_50%,transparent)]',
  local:  'bg-[var(--proto-loc)] shadow-[0_0_6px_color-mix(in_srgb,var(--proto-loc)_50%,transparent)]',
}
// LED 待机态:协议色 35%,暗但可见——未选中不再是"关掉",而是"待机"
const PROTO_LED_DIM_CLS: Record<ProtoKind, string> = {
  ssh:    'bg-[color-mix(in_srgb,var(--proto-ssh)_35%,transparent)]',
  telnet: 'bg-[color-mix(in_srgb,var(--proto-tel)_35%,transparent)]',
  serial: 'bg-[color-mix(in_srgb,var(--proto-ser)_35%,transparent)]',
  local:  'bg-[color-mix(in_srgb,var(--proto-loc)_35%,transparent)]',
}
// 选中态文字色:协议色满色——选中后铭牌+读数也"点亮"
const PROTO_TEXT_LIT_CLS: Record<ProtoKind, string> = {
  ssh:    'text-[var(--proto-ssh)]',
  telnet: 'text-[var(--proto-tel)]',
  serial: 'text-[var(--proto-ser)]',
  local:  'text-[var(--proto-loc)]',
}

const getPort = (config: SessionConfig): string => {
  if (!config) return ''
  if (config.ssh) return String(config.ssh.port)
  if (config.telnet) return String(config.telnet.port)
  return ''
}

const mapProtocol = (type: string): 'ssh' | 'telnet' | 'serial' | 'local' => {
  if (type === 'ssh' || type === 'telnet' || type === 'serial' || type === 'local') return type
  return 'ssh'
}

const formatMeta = (config: SessionConfig): string => {
  if (config.ssh) {
    const u = config.ssh.username ? `${config.ssh.username}@` : ''
    return `${u}${config.ssh.host}:${config.ssh.port}`
  }
  if (config.telnet) return `${config.telnet.host}:${config.telnet.port}`
  if (config.serial) return `${config.serial.path} ${config.serial.baudRate}`
  if (config.local) return config.local.shell || 'local'
  return ''
}

/**
 * 视觉状态：把"运行时 live 状态"与"TCP 可达性探测结果"折叠成一个符号 + 一个颜色 + 一句 tooltip。
 *
 * 优先级：live 状态盖过 reachability — 当前已连接就一定通；正在握手 / 失败 都显示 live 信号。
 * 只有当没有任何 live session 时，才显示 reachability 探测结果（可达 = 灰白 ◎，不可达 = 暗红 ⊘）。
 */
interface VisualStatus {
  tooltip: string
  borderColor: string
}

const isTcpProto = (proto: string): boolean => proto === 'ssh' || proto === 'telnet'

const computeVisualStatus = (status: string, reachable: boolean | undefined, proto: string): VisualStatus => {
  // 活动连接覆盖一切
  if (status === 'connected') {
    return { borderColor: 'var(--live)', tooltip: i18n.t('sidebar.statusConnected') }
  }
  if (status === 'connecting' || status === 'reconnecting') {
    return { borderColor: 'var(--amber)', tooltip: i18n.t('sidebar.statusConnecting') }
  }
  if (status === 'error') {
    return { borderColor: 'var(--error-rack)', tooltip: i18n.t('sidebar.statusConnectionFailed') }
  }

  // 非 TCP 协议（serial/local）不做可达性探测，永远显示中性
  if (!isTcpProto(proto)) {
    return { borderColor: 'var(--text-rack-dim)', tooltip: i18n.t('sidebar.statusNotConnected') }
  }

  // 离线 + 可达性已知
  if (reachable === true) {
    return { borderColor: 'var(--reachable)', tooltip: i18n.t('sidebar.statusTcpReachable') }
  }
  if (reachable === false) {
    return { borderColor: 'var(--error-rack)', tooltip: i18n.t('sidebar.statusTcpUnreachable') }
  }

  // 还没探过
  return { borderColor: 'var(--text-rack-faint)', tooltip: i18n.t('sidebar.statusProbing') }
}

const protoStripBg = (proto: string): string => {
  switch (proto) {
    case 'ssh':    return 'bg-[var(--proto-ssh)]'
    case 'telnet': return 'bg-[var(--proto-tel)]'
    case 'serial': return 'bg-[var(--proto-ser)]'
    case 'local':  return 'bg-[var(--proto-loc)]'
    default:       return 'bg-[var(--text-rack-dim)]'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG 图标
// ─────────────────────────────────────────────────────────────────────────────

const IconDownload = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"><path d="M7 2v8M3 7l4 4 4-4M2 12h10"/></svg>
)
const IconEdit = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 9l1-3 5-5 2 2-5 5z"/></svg>
)
const IconCopy = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><rect x="3" y="3" width="6" height="6"/><path d="M2 7V2h5"/></svg>
)
const IconStar = ({ filled }: { filled?: boolean }) => (
  filled
    ? <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor"><path d="M5.5 0L6.8 3.85H11L7.6 6.3L8.9 10.15L5.5 7.7L2.1 10.15L3.4 6.3L0 3.85H4.2L5.5 0Z"/></svg>
    : <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M5.5 0.5L6.7 3.85H10.5L7.5 6.2L8.6 9.7L5.5 7.5L2.4 9.7L3.5 6.2L0.5 3.85H4.3L5.5 0.5Z"/></svg>
)
const IconX = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 2l7 7M9 2l-7 7"/></svg>
)
const IconRack = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x=".5" y=".5" width="9" height="9"/><path d="M0 3.5h10M0 6.5h10M3.5 0v10M6.5 0v10"/></svg>
)
const IconCaret = () => (
  <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg>
)
const IconLive = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><circle cx="5" cy="5" r="2.5"/></svg>
)
const IconPower = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d="M5.5 1.5v3.5"/>
    <path d="M3.3 3.2a3 3 0 1 0 4.4 0"/>
  </svg>
)

// ─────────────────────────────────────────────────────────────────────────────
// 内联子组件
// ─────────────────────────────────────────────────────────────────────────────

const StripRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="grid grid-cols-[52px_1fr] items-center gap-2 px-3 py-1.5 bg-[var(--bg-strip)] border-b border-[var(--rule-soft)]">
    {/* 区段标签与头条铭牌同字体(设备徽章的「厂牌丝印」sans),不再是等宽栈 */}
    <span
      className="font-bold text-[12px] text-[var(--text-rack)]"
      style={{ fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif' }}
    >
      {label}
    </span>
    <div className="flex items-center gap-1 min-w-0 overflow-x-auto scrollbar-hide">
      {children}
    </div>
  </div>
)

const ShellPill: React.FC<{
  shell: 'cmd' | 'ps' | 'ps7' | 'ps+'
  glyph: string
  onClick: () => void
  children: React.ReactNode
}> = ({ shell, glyph, onClick, children }) => {
  const borderHover = {
    cmd: 'hover:border-[var(--text-rack-dim)]',
    ps:  'hover:border-[var(--proto-ssh)]',
    ps7: 'hover:border-[var(--proto-loc)]',
    'ps+': 'hover:border-[var(--error-rack)]'
  }[shell]
  const glyphColor = {
    cmd: 'text-[var(--text-rack-data)]',
    ps:  'text-[var(--proto-ssh)]',
    ps7: 'text-[var(--proto-loc)]',
    'ps+': 'text-[var(--error-rack)]'
  }[shell]
  return (
    <button
      onClick={onClick}
      title={shell}
      className={cn(
        'inline-flex items-center gap-[5px] flex-shrink-0 px-2.5 py-[4px] rounded-[3px] cursor-pointer whitespace-nowrap',
        'text-[13px] font-medium text-[var(--text-rack)] bg-transparent border border-[var(--rule)]',
        'hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)] transition-colors',
        borderHover
      )}
    >
      <span className={cn('[font-family:inherit] text-[12.5px] w-[12px] inline-flex justify-center', glyphColor)}>{glyph}</span>
      <span>{children}</span>
    </button>
  )
}

const GroupHeader: React.FC<{
  icon: React.ReactNode
  label: string
  count: number
  amber?: boolean
  tone?: 'amber' | 'live' | 'reach'
  monoLabel?: boolean
  /** 可折叠时传入；undefined 表示不可折叠 */
  collapsed?: boolean
  onToggle?: () => void
  /** 右侧可选 action 按钮(LIVE 段的 close-all 用) */
  action?: React.ReactNode
}> = ({ icon, label, count, amber, tone, monoLabel, collapsed, onToggle, action }) => {
  const collapsible = typeof collapsed === 'boolean' && !!onToggle
  const effectiveTone = tone ?? (amber ? 'amber' : undefined)
  const iconColorClass =
    effectiveTone === 'amber' ? 'text-[var(--amber)]' :
    effectiveTone === 'live'  ? 'text-[var(--live)]' :
    effectiveTone === 'reach' ? 'text-[var(--reachable)]' :
    'text-[var(--text-rack-dim)]'
  return (
    <div
      onClick={collapsible ? onToggle : undefined}
      className={cn(
        'flex items-center gap-2.5 px-3 py-1.5 text-[10px] text-[var(--text-rack-mute)]',
        // 与 row 同 bg,通过 typography + flex-1 hairline 当分隔符,不再当 rail
        'bg-[var(--bg-rack)] border-b border-[var(--rule-soft)]',
        collapsible && 'cursor-pointer hover:bg-[var(--bg-slot)]'
      )}
    >
      {collapsible && (
        <span
          className={cn(
            'inline-flex transition-transform text-[var(--text-rack-dim)]',
            !collapsed && 'rotate-90'
          )}
        >
          <IconCaret />
        </span>
      )}
      <span className={cn('inline-flex', iconColorClass)}>{icon}</span>
      <span
        className={cn(
          'flex-shrink-0',
          monoLabel
            ? '[font-family:inherit] normal-case tracking-[.04em] text-[var(--text-rack)] font-normal text-[10.5px]'
            : '[font-family:inherit] font-bold text-[11px] text-[var(--text-rack)]'
        )}
      >
        {label}
      </span>
      <span className="flex-1 h-px bg-[var(--rule)]" />
      <span className="[font-family:inherit] text-[10px] text-[var(--text-rack-data)] tracking-[.04em] normal-case">{count}</span>
      {action}
    </div>
  )
}

const SessionSlot: React.FC<{
  config: SessionConfig
  status: string
  reachable?: boolean    // undefined = 未探测过，true/false 来自 prober
  active: boolean
  isPinned: boolean
  draggable?: boolean
  onClick: () => void
  onEdit: (e: React.MouseEvent) => void
  onCopy: (e: React.MouseEvent) => void
  onTogglePin: (e: React.MouseEvent) => void
  onDelete: (e: React.MouseEvent) => void
  /** danger action 的图标重写,默认 IconX(删除语义)。LIVE 段会换成 IconPower(关闭终端语义) */
  dangerIcon?: React.ReactNode
  dangerTitle?: string
  /** 紧凑 hover actions —— 只保留 pin + danger,隐藏 edit/copy。LIVE 段用 */
  compactActions?: boolean
  /** 视觉置灰 —— LIVE 段该会话所有页签已被隐藏时用,提示点击即还原 */
  dimmed?: boolean
  /** 被隐藏的页签数(LIVE 段用);>0 时在名称右侧显示徽章 */
  hiddenCount?: number
  onDragStart?: (e: React.DragEvent) => void
  onDragEnter?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: (e: React.DragEvent) => void
  isDragging?: boolean
  isDragOver?: boolean
}> = ({
  config, status, reachable, active, isPinned, draggable,
  onClick, onEdit, onCopy, onTogglePin, onDelete, dangerIcon, dangerTitle, compactActions, dimmed, hiddenCount,
  onDragStart, onDragEnter, onDrop, onDragEnd, isDragging, isDragOver
}) => {
  const proto = mapProtocol(config.type)
  const visual = computeVisualStatus(status, reachable, proto)
  const { t } = useTranslation()
  return (
    <div
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      data-proto={proto}
      data-status={status}
      data-reach={reachable === undefined ? 'unknown' : reachable ? 'up' : 'down'}
      title={dimmed ? t('sidebar.tooltipWithHidden', { tooltip: visual.tooltip }) : visual.tooltip}
      className={cn(
        'group relative grid items-center gap-2.5 pr-3 min-h-[34px] py-1.5 cursor-pointer transition-colors',
        'grid-cols-[4px_auto_minmax(0,auto)_minmax(0,1fr)]',
        // slot 面板基底 + 1U 之间的 hairline + 底沿凹陷阴影(slot 嵌入 rack 框架感)
        'bg-[var(--bg-rack)] border-b border-[var(--rule-soft)]',
        'shadow-[inset_0_-1px_0_var(--bg-base)]',
        'hover:bg-[var(--bg-slot)]',
        dimmed && 'opacity-45 hover:opacity-100',
        active && [
          'bg-[var(--bg-slot)]',
          // 2px amber 左边 + 软晕,像 active slot 在通电
          'before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-[var(--amber)] before:shadow-[0_0_4px_var(--amber-glow)]',
          // active 行被"拉出"——上下各一道 amber-soft hairline
          'shadow-[inset_0_1px_0_var(--amber-soft),inset_0_-1px_0_var(--amber-soft)]'
        ],
        isDragging && 'opacity-50',
        isDragOver && 'border-t border-[var(--amber)]'
      )}
    >
      {/* 协议色条:贯通整行,作为 slot 的连接器边 */}
      <span
        aria-hidden
        className={cn(
          'absolute left-0 top-0 bottom-0 w-[4px] z-0 transition-[filter]',
          status === 'connecting' ? 'bg-[var(--amber)] animate-pulse-amber' : protoStripBg(proto),
          active && status !== 'connecting' && 'brightness-125'
        )}
      />
      {/* 协议标签：外围框颜色表示状态,内部文字表示协议 */}
      <span
        className={cn(
          'col-start-2 inline-flex items-end justify-center h-[22px] px-1.5 rounded-[3px] border-2 bg-transparent',
          '[font-family:inherit] text-[12px] font-bold uppercase tracking-[.04em]'
        )}
        style={{ borderColor: visual.borderColor }}
      >
        <span className={cn('leading-none pb-[3px]', PROTO_TEXT_CLS[proto])}>{PROTO_LABEL[proto]}</span>
      </span>
      <span className="text-[13.5px] text-[var(--text-rack)] font-semibold truncate max-w-[140px] tracking-[.01em] leading-none inline-flex items-end gap-1.5 h-[22px] pb-[4px]">
        {/* 被隐藏的页签数徽章 —— 提示点击还原 N 个页签;hiddenCount 为 0/undefined 时不渲染(用三元,切勿用 && 会把 0 渲染成文本) */}
        {hiddenCount ? (
          <span
            title={t('sidebar.tabsHidden', { count: hiddenCount })}
            className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1 rounded-[2px] bg-[var(--bg-elev)] text-[var(--amber)] [font-family:inherit] text-[12px] font-bold tabular-nums leading-none"
          >
            {hiddenCount}
          </span>
        ) : null}
        {config.name}
      </span>
      <span className="[font-family:inherit] text-[11px] text-[var(--text-rack-data)] truncate min-w-0 leading-none inline-flex items-end h-[22px] pb-[5px]">
        {formatMeta(config)}
      </span>
      {/* hover actions overlay */}
      <div
        className={cn(
          'absolute right-1.5 top-1/2 -translate-y-1/2 flex gap-0',
          'opacity-0 pointer-events-none transition-opacity',
          'group-hover:opacity-100 group-hover:pointer-events-auto',
          'pl-8',
          active ? 'bg-gradient-to-l from-[var(--bg-slot)] from-[24%] to-transparent'
                 : 'bg-gradient-to-l from-[var(--bg-rack)] from-[24%] to-transparent'
        )}
      >
        {!compactActions && <ActBtn onClick={onEdit} title={t('sidebar.editSession')}><IconEdit /></ActBtn>}
        {!compactActions && <ActBtn onClick={onCopy} title={t('sidebar.copySession')}><IconCopy /></ActBtn>}
        {!compactActions && (
          <ActBtn amber active={isPinned} onClick={onTogglePin} title={isPinned ? t('sidebar.unpin') : t('sidebar.pinSession')}>
            <IconStar filled={isPinned} />
          </ActBtn>
        )}
        <ActBtn danger onClick={onDelete} title={dangerTitle ?? t('sidebar.deleteSession')}>{dangerIcon ?? <IconX />}</ActBtn>
      </div>
    </div>
  )
}

const ActBtn: React.FC<{
  onClick: (e: React.MouseEvent) => void
  title?: string
  amber?: boolean
  danger?: boolean
  active?: boolean
  children: React.ReactNode
}> = ({ onClick, title, amber, danger, active, children }) => (
  <button
    onClick={onClick}
    title={title}
    className={cn(
      'w-[24px] h-[24px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] transition-colors',
      'text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)]',
      amber && (active ? 'text-[var(--amber)]' : 'hover:text-[var(--amber)]'),
      danger && 'hover:text-[var(--error-rack)]',
      !amber && !danger && 'hover:text-[var(--text-rack)]'
    )}
  >
    {children}
  </button>
)

// ─────────────────────────────────────────────────────────────────────────────
// SessionsPanel 主体
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 会话面板(机柜左列 Sessions 页签内容)- 会话机架 + 底部嵌入文件管理器。
 * 列宽度由 MainWindow 列容器统一管(三栏共享);本组件只持文件管理器高度(分割线拖动)。
 */
const SessionsPanel: React.FC<SessionsPanelProps> = ({ onConnect, onExecuteCommand, quickCommandsDisabled }) => {
  const [showDialog, setShowDialog] = useState(false)
  const [editConfig, setEditConfig] = useState<SessionConfig | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')
  const [showExportImport, setShowExportImport] = useState(false)
  // 快捷命令数据 —— 常驻 store（MainWindow 挂载时加载、面板 CRUD 后 loadAll 刷新），
  // 这里订阅给 ExportImportDialog 用
  const quickCommands = useQuickCommandsStore(s => s.commands)
  const loadQuickCommands = useQuickCommandsStore(s => s.loadAll)
  const { savedSessions, sessions, reachability, refreshSavedSessions, disconnectSession, removeLiveSession, setSessionEncoding, deleteSession } = useSessionStore()
  const removeSessionFromAllPanes = usePaneStore(s => s.removeSessionFromAllPanes)
  const { t } = useTranslation()
  // 被隐藏的终端页签(SessionsPanel LIVE 段会话标签点击 toggle)——用于给已隐藏的 LIVE 标签置灰
  const hiddenTabSessions = usePaneStore(s => s.hiddenTabSessions)
  // 订阅 layout —— LIVE 段需要按"在某个 pane 里(打开了 tab)"过滤,而不是按 sessions 数组(那里包含所有 saved 的 disconnected registry)
  const layoutRoot = usePaneStore(s => s.layout.root)
  const sessionIdsInPanes = useMemo<Set<string>>(() => {
    const ids = new Set<string>()
    const visit = (node: PaneNode | null | undefined): void => {
      if (!node) return
      if (node.type === 'leaf') {
        for (const sid of node.sessions) ids.add(sid)
      } else {
        visit(node.firstChild)
        visit(node.secondChild)
      }
    }
    visit(layoutRoot)
    return ids
  }, [layoutRoot])
  // 活动分屏的活动会话 —— 底部状态栏左槽终端状态读数(协议/尺寸/行数)的数据源。
  // 覆盖层(web/文档/dsh web/MCP)盖住活动分屏时置空:底层终端不可见,读数描述的不是
  // 眼前内容,回落 alt 提示(口径同 MainWindow 快捷命令的 overlayActiveHere 判断)。
  // 树与 activePaneId 都从 selector 快照 s 读取(findPane;不走内部 get() 的
  // getAllLeafPanes —— 会撕裂快照与活 store,React 18 并发渲染下出错位中间态,
  // 同 MainWindow.tsx 的 selector 约定)。
  // agent 会话刻意不过滤:读数语义是"当前可见的终端"(agent 孵化的也是真 PTY),
  // 用户正盯着 agent 终端时置空反而误导;LIVE 计数排除 agent 是会话注册表口径,两者各管各的
  const activeTerminalSessionId = usePaneStore(s => {
    const pane = findPane(s.layout.root, s.layout.activePaneId)
    if (pane?.type !== 'leaf' || !pane.activeSessionId || pane.overlays.some(r => r.active)) return ''
    return pane.activeSessionId
  })
  // 底部读数的协议码 —— 活动会话的协议,渲染前算好,JSX 只做展示
  const activeTerminalProto = useMemo(() => {
    if (!activeTerminalSessionId) return undefined
    const activeSession = sessions.find(s => s.id === activeTerminalSessionId)
    return activeSession?.config ? mapProtocol(activeSession.config.type) : undefined
  }, [sessions, activeTerminalSessionId])
  // 底部读数的编码(原始值,展示时再大写) —— ssh/telnet/serial 会话的运行时编码,
  // 点击弹出选择框三选一(见下方 encodingMenu);local 走 ConPTY 恒为 UTF-8、
  // config 字段不生效(见 connectors/local.ts),不展示也不可切,以免读数失真。
  // runtimeEncoding 是运行时真值(切档推送字段),config 永远是保存值镜像 ——
  // 后者仅作会话刚打开尚未切换时的兜底
  const activeTerminalEncoding = useMemo(() => {
    if (!activeTerminalProto || activeTerminalProto === 'local') return undefined
    const activeSession = sessions.find(s => s.id === activeTerminalSessionId)
    return activeSession?.runtimeEncoding ?? activeSession?.config.terminal?.encoding ?? 'utf-8'
  }, [sessions, activeTerminalSessionId, activeTerminalProto])
  // 文件管理器高度(列宽度由 MainWindow 列容器统一管) —— 声明在编码菜单块之前:
  // 菜单重锚 effect 的 deps 引用它,deps 数组渲染期求值,声明在后会踩 TDZ
  const [fileManagerHeight, setFileManagerHeight] = useState(200)
  const [isResizingHeight, setIsResizingHeight] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)
  // 编码选择菜单 —— 状态栏在窗口底部,菜单从编码按钮向上弹(portal 挂 body,竖排三项,
  // 当前项 amber 点亮)。选档即运行时切换:解码流/写编码立即换,只改运行时会话不写回
  // 保存配置 —— 同一会话重连保持(reconnect 复用 Session 与 config),关闭后重新打开
  // 才回到保存值;与 SessionDialog 的持久配置各管各的
  const [encodingMenu, setEncodingMenu] = useState<{ top: number; left: number } | null>(null)
  const encodingMenuRef = useRef<HTMLDivElement>(null)
  const encodingBtnRef = useRef<HTMLButtonElement>(null)
  // 外部点击 / ESC 收起 —— ESC 捕获截停防穿透给终端(xterm 会把裸 \x1b 发给远端),
  // 目标落在菜单或编码按钮上不收(按钮自己走 toggle 开合),见 useDismiss
  useDismiss(encodingMenu !== null, () => setEncodingMenu(null), [encodingMenuRef, encodingBtnRef])
  // 活动会话切换时菜单描述的已是别的会话,收起;读数消失时也收 —— entry 可能被删
  // 而 pane.activeSessionId 悬空指向旧 id(键盘流删除当前打开的会话,store
  // deleteSession 不做 pane 清理),菜单不收就成了看不见的 ESC 吞层
  useEffect(() => {
    setEncodingMenu(null)
  }, [activeTerminalSessionId])
  useEffect(() => {
    if (activeTerminalEncoding === undefined) setEncodingMenu(null)
  }, [activeTerminalEncoding])
  // 挂载后按菜单实际宽度精修左缘 —— 初定位的 -100 只是按当前内容估的预留,
  // 菜单宽度跟内容走(编码表加长标签时不该和样式里的 min-w 手工联动)。
  // 幂等:修完再跑一次,值不变即停;窗口 resize 时重锚 —— fixed 定位不跟随视口,
  // 且状态栏在窗口底部,竖向 resize 时按钮跟着移动,只重钳 left 会让菜单悬在
  // 旧 top 脱锚。两轴都从按钮矩形重新派生(菜单向上弹:底边贴按钮上沿再留 4px)。
  // 按钮位置还会被三处拖动改变而窗口尺寸不变:文件管理器高度拖动(本组件状态,
  // fileManagerHeight 进 deps,拖动中随重挂重锚)、MainWindow 列宽拖动与窗口 resize
  // (都会改变侧栏容器尺寸 —— ResizeObserver 盯容器一并覆盖,对 resize 冗余但无害)
  useLayoutEffect(() => {
    if (!encodingMenu) return
    const el = encodingMenuRef.current
    if (!el) return
    const reclamp = () => {
      const btn = encodingBtnRef.current
      if (!btn) return
      const width = el.getBoundingClientRect().width
      const rect = btn.getBoundingClientRect()
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      const top = Math.max(8, rect.top - 4)
      setEncodingMenu(prev => {
        if (!prev) return prev
        if (prev.top === top && prev.left === left) return prev
        return { top, left }
      })
    }
    reclamp()
    window.addEventListener('resize', reclamp)
    const ro = new ResizeObserver(reclamp)
    if (sidebarRef.current) ro.observe(sidebarRef.current)
    return () => {
      window.removeEventListener('resize', reclamp)
      ro.disconnect()
    }
    // sidebarRef 来自 useRef、引用恒稳定,进 deps 不触发重挂
  }, [encodingMenu, fileManagerHeight, sidebarRef])
  // 状态栏读数的窄宽降级 —— 侧栏宽 180-400 可拖而读数是恒定文案:全家族(协议/编码/
  // 尺寸/行数)约需 300px+ 才放得下,240px 默认宽下硬塞只会让尾巴在 overflow-hidden
  // 里被裁成半个字形。按价值分级整段退场:行数(<300)先走、尺寸段(<260)次之,
  // 协议码与编码读数(本特性的可见性)守住到底。两级阈值各带迟滞防边界抖动;观测
  // sidebarRef 容器 —— 其宽度只随窗口/列宽拖动变化、不依赖被隐藏的内容,无反馈震荡。
  // 阈值裁决抽在 statusbar-compact.ts(纯函数,真值表有直测);本 effect 只剩订阅 observer
  // → setState 的接线
  const [statusHideLines, setStatusHideLines] = useState(false)
  const [statusHideSize, setStatusHideSize] = useState(false)
  useEffect(() => {
    const el = sidebarRef.current
    if (!el) return
    let compact: StatusbarCompactState = { hideLines: false, hideSize: false }
    const ro = new ResizeObserver(() => {
      const next = evaluateStatusbarCompact(el.clientWidth, compact)
      if (next.hideLines !== compact.hideLines) setStatusHideLines(next.hideLines)
      if (next.hideSize !== compact.hideSize) setStatusHideSize(next.hideSize)
      compact = next
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleEncodingClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (encodingMenu) {
      setEncodingMenu(null)
      return
    }
    const rect = encodingBtnRef.current?.getBoundingClientRect()
    if (!rect) return
    // 向上弹:translateY(-100%) 让菜单底边贴按钮上沿再留 4px;左缘先粗钳进视口,
    // 挂载后 useLayoutEffect 再按实际宽度精修
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - 100)
    setEncodingMenu({ top: rect.top - 4, left })
  }
  // 不做「同值跳过」:读数显示值可能与 connector 实际编码漂移,重选当前显示的值也要
  // 走一遍 IPC 让 main 侧重新落位。同值重选由 main 侧短路(config 与 connector 都已是
  // 该值才算幂等命中),不会重建解码流 —— mid-多字节被 end() 冲成 � 的事不会发生
  const handleEncodingPick = (enc: TerminalEncoding) => {
    setEncodingMenu(null)
    if (activeTerminalSessionId) {
      setSessionEncoding(activeTerminalSessionId, enc)
    }
  }
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const isUpdating = useRef(false)

  // 分组折叠状态 — 放在顶部以维持"hooks 都在顶部"约定
  const [expandedIPs, setExpandedIPs] = useState<Record<string, boolean>>({})
  const [pinnedCollapsed, setPinnedCollapsed] = useState<boolean>(false)
  const [liveCollapsed, setLiveCollapsed] = useState<boolean>(false)

  // close-all 二次确认 —— 第一次点击进入 armed 态,2.5s 内再点才真执行
  const [closeAllArmed, setCloseAllArmed] = useState(false)
  const closeAllTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (closeAllTimerRef.current !== null) window.clearTimeout(closeAllTimerRef.current)
  }, [])

  // 协议筛选 —— 多选 toggle,空集 = 全部显示。作用于子网分组区域,不影响 LIVE/PINNED
  const [protoFilter, setProtoFilter] = useState<Set<ProtoKind>>(() => {
    try {
      const raw = localStorage.getItem('lyshell.protoFilter.v1')
      if (!raw) return new Set()
      const arr = JSON.parse(raw) as unknown
      if (!Array.isArray(arr)) return new Set()
      return new Set(arr.filter((p): p is ProtoKind => PROTO_KINDS.includes(p as ProtoKind)))
    } catch { return new Set() }
  })
  const toggleProtoFilter = (p: ProtoKind) => {
    setProtoFilter(prev => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p); else next.add(p)
      try { localStorage.setItem('lyshell.protoFilter.v1', JSON.stringify([...next])) } catch { /* quota */ }
      return next
    })
  }

  // 加载快速命令（store；MainWindow 已常驻加载，这里兜底刷新）
  useEffect(() => {
    loadQuickCommands()
  }, [loadQuickCommands])

  // 新建会话对话框请求(ui-store):请求方(命令 /new、MCP open_connection_dialog)
  // 可能在本面板未挂载时发起 —— 请求落 store 跨挂载存活,这里挂载后读到存量/
  // 挂载中收到变更都能开对话框,消费后归零防二次进页签误弹。
  // 原先的 window 'newSession' 事件在侧栏停于其他页签时监听器不存在、请求丢失,已废弃。
  const createRequestId = useUiStore(s => s.createDialogRequests.sessions ?? 0)
  useEffect(() => {
    if (!createRequestId) return
    setEditConfig(undefined)
    setShowDialog(true)
    useUiStore.getState().consumeCreateDialogRequest('sessions')
  }, [createRequestId])

  // 加载保存的会话列表
  useEffect(() => {
    refreshSavedSessions()
  }, [refreshSavedSessions])

  // 加载保存的 UI 配置
  useEffect(() => {
    const loadUIConfig = async () => {
      try {
        const savedHeight = await window.electronAPI?.getConfig('fileManagerHeight')
        if (savedHeight && savedHeight > 0) setFileManagerHeight(savedHeight)
      } catch (e) {
        console.warn('Failed to load UI config:', e)
      }
    }
    loadUIConfig()
  }, [])

  // 保存文件管理器高度（带防抖）
  useEffect(() => {
    const timer = setTimeout(() => {
      window.electronAPI?.setConfig('fileManagerHeight', fileManagerHeight)
    }, 500)
    return () => clearTimeout(timer)
  }, [fileManagerHeight])

  // 高度拖动
  useEffect(() => {
    if (!isResizingHeight) return
    const handleMouseMove = (e: MouseEvent) => {
      if (!sidebarRef.current) return
      const rect = sidebarRef.current.getBoundingClientRect()
      const newHeight = Math.max(100, Math.min(rect.height - 200, rect.bottom - e.clientY))
      setFileManagerHeight(newHeight)
    }
    const handleMouseUp = () => setIsResizingHeight(false)
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizingHeight])

  // ──────────── 处理函数 ────────────

  const handleOpenExportImport = () => {
    setShowExportImport(true)
  }

  const handleImportComplete = async () => {
    // 导入可能写入新命令 —— 刷新常驻 store（侧栏快捷命令模块/F 键直发共用）
    try {
      await loadQuickCommands()
    } catch (err) {
      console.error('Failed to refresh quick commands:', err)
    }
    refreshSavedSessions()
  }

  const matchesSearch = (config: SessionConfig) => {
    if (!config) return false
    if (!searchQuery.trim()) return true
    const query = searchQuery.toLowerCase()
    const name = (config.name || '').toLowerCase()
    const ip = getHostIP(config).toLowerCase()
    const port = getPort(config)
    return name.includes(query) || ip.includes(query) || port.includes(query)
  }

  // 过滤掉 agent 会话（标签含 "agent:" 前缀），agent 为瞬态终端，不进入会话管理列表
  const isAgentSession = (s: SessionConfig) => s.tags?.some(t => t.startsWith('agent:'))
  const displayedSessions = savedSessions.filter(s => s && !isAgentSession(s))
  const filteredSessions = displayedSessions.filter(s => matchesSearch(s))

  const sortByUpdateTime = (a: SessionConfig, b: SessionConfig) => {
    const getTime = (d: Date | string | undefined) => d ? new Date(d).getTime() : 0
    return getTime(b.updatedAt) - getTime(a.updatedAt)
  }

  const sortByPinOrder = (a: SessionConfig, b: SessionConfig) => {
    if (a.pinOrder !== undefined && b.pinOrder !== undefined) return a.pinOrder - b.pinOrder
    if (a.pinOrder !== undefined) return -1
    if (b.pinOrder !== undefined) return 1
    return sortByUpdateTime(a, b)
  }

  const pinnedSessions = filteredSessions.filter(s => s.tags?.includes('pinned')).sort(sortByPinOrder)
  const unpinnedSessions = filteredSessions.filter(s => !s.tags?.includes('pinned'))

  // 协议筛选作用域 = 子网分组区域;chip 计数始终基于 unpinnedSessions(不被自身筛选影响,否则点开就归零)
  const protoCounts: Record<ProtoKind, number> = { ssh: 0, telnet: 0, serial: 0, local: 0 }
  for (const s of unpinnedSessions) {
    const t = mapProtocol(s.type)
    protoCounts[t] = (protoCounts[t] ?? 0) + 1
  }
  // 隐藏的 LOC/SER chip 若仍在选中态,自动清出 protoFilter —— 否则用户看不到 chip 也点不掉,被锁死筛掉自己
  useEffect(() => {
    const stale: ProtoKind[] = []
    for (const p of ['local', 'serial'] as const) {
      if (protoFilter.has(p) && protoCounts[p] === 0) stale.push(p)
    }
    if (stale.length > 0) {
      setProtoFilter(prev => {
        const next = new Set(prev)
        for (const p of stale) next.delete(p)
        try { localStorage.setItem('lyshell.protoFilter.v1', JSON.stringify([...next])) } catch { /* quota */ }
        return next
      })
    }
    // protoCounts 每次渲染都是新对象,整体进 deps 会无限循环;只追踪用到的两个字段
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protoCounts.local, protoCounts.serial, protoFilter])
  const filterActive = protoFilter.size > 0
  const subnetCandidates = filterActive
    ? unpinnedSessions.filter(s => protoFilter.has(mapProtocol(s.type)))
    : unpinnedSessions

  const groupedBySubnet = subnetCandidates.reduce((acc, session) => {
    if (!session) return acc
    const key = getGroupKey(session)
    if (!acc[key]) acc[key] = []
    acc[key].push(session)
    return acc
  }, {} as Record<string, SessionConfig[]>)

  const sortedSubnetGroups = Object.entries(groupedBySubnet).sort(([, aSessions], [, bSessions]) => {
    const getLatestTime = (ss: SessionConfig[]) =>
      ss.reduce((max, s) => Math.max(max, s.updatedAt ? new Date(s.updatedAt).getTime() : 0), 0)
    return getLatestTime(bSessions) - getLatestTime(aSessions)
  })

  // 持久化 PINNED / LIVE 折叠状态
  useEffect(() => {
    window.electronAPI?.getConfig('pinnedCollapsed').then((v: unknown) => {
      if (typeof v === 'boolean') setPinnedCollapsed(v)
    }).catch(() => {})
    window.electronAPI?.getConfig('liveCollapsed').then((v: unknown) => {
      if (typeof v === 'boolean') setLiveCollapsed(v)
    }).catch(() => {})
  }, [])
  useEffect(() => {
    const t = setTimeout(() => {
      window.electronAPI?.setConfig('pinnedCollapsed', pinnedCollapsed)
    }, 500)
    return () => clearTimeout(t)
  }, [pinnedCollapsed])
  useEffect(() => {
    const t = setTimeout(() => {
      window.electronAPI?.setConfig('liveCollapsed', liveCollapsed)
    }, 500)
    return () => clearTimeout(t)
  }, [liveCollapsed])
  // 默认展开；首次点击后写入 false 收起，再点又置 true 展开
  const toggleIPGroup = (ip: string) => setExpandedIPs(prev => ({
    ...prev,
    [ip]: prev[ip] === false ? true : false
  }))

  // 所有分组（含 PINNED + 全部子网）是否都已折叠
  const ipsCollapsed = sortedSubnetGroups.length > 0 && sortedSubnetGroups.every(([key]) => expandedIPs[key] === false)
  const pinnedCollapsedOrAbsent = pinnedSessions.length === 0 || pinnedCollapsed
  const allGroupsCollapsed = pinnedCollapsedOrAbsent && (sortedSubnetGroups.length === 0 || ipsCollapsed)

  // 一键折叠 / 展开所有分组
  const toggleAllGroups = () => {
    if (allGroupsCollapsed) {
      // 全部展开
      setPinnedCollapsed(false)
      setExpandedIPs(prev => {
        const next = { ...prev }
        for (const [key] of sortedSubnetGroups) next[key] = true
        return next
      })
    } else {
      // 全部折叠
      if (pinnedSessions.length > 0) setPinnedCollapsed(true)
      setExpandedIPs(prev => {
        const next = { ...prev }
        for (const [key] of sortedSubnetGroups) next[key] = false
        return next
      })
    }
  }

  // saved → live 会话匹配 — 后端给每次 connect 分配新 uuid，所以不能按 id 找。
  // 用 (name + 协议 + host) 作为身份标识，与 saved 行做关联。
  const liveKey = (cfg: SessionConfig): string =>
    `${cfg.type}|${cfg.name}|${getHostIP(cfg)}`

  // 优先级：connected > connecting > reconnecting > error > disconnected
  // 重连中的 session 比已 error 的更值得展示（reconnecting 表示还在尝试，是"活的"信号）
  const statusRank: Record<string, number> = {
    connected: 5, connecting: 4, reconnecting: 3, error: 2, disconnected: 1
  }
  const bestSessionFor = (saved: SessionConfig) => {
    const key = liveKey(saved)
    let best: typeof sessions[number] | undefined
    for (const s of sessions) {
      if (!s.config) continue
      if (liveKey(s.config) !== key) continue
      if (!best || (statusRank[s.status] ?? 0) > (statusRank[best.status] ?? 0)) {
        best = s
      }
    }
    return best
  }
  const statusFor = (saved: SessionConfig): string => bestSessionFor(saved)?.status ?? 'disconnected'
  const reachabilityFor = (saved: SessionConfig): boolean | undefined => {
    // 与 main/ipc/handlers.ts 中 syncReachabilityTargets 的 key 对齐 — 直接用 config.id
    return reachability[saved.id]?.reachable
  }
  // 该 saved 对应的所有 runtime session 是否都被隐藏了页签(点击 LIVE 标签 toggle 的结果)
  // 只看真正在 pane 里的 session,排除 disconnected registry 条目
  // 按 runtime sessionId 去重(sessions 数组在竞态下可能出现同 id 重复 entry,见 addTemporarySession)
  const isLiveHidden = (saved: SessionConfig): boolean => {
    const key = liveKey(saved)
    const liveIds = Array.from(new Set(
      sessions
        .filter(s => s.config && liveKey(s.config) === key && s.id && sessionIdsInPanes.has(s.id))
        .map(s => s.id)
    ))
    return liveIds.length > 0 && liveIds.every(id => hiddenTabSessions[id])
  }
  // 该 saved 对应的 runtime session 中被隐藏了页签的数量(用于徽章显示)
  // 按 runtime sessionId 去重,徽章显示的是"被隐藏的唯一终端数",而非数组条目数
  const liveHiddenCount = (saved: SessionConfig): number => {
    const key = liveKey(saved)
    const hiddenIds = new Set(
      sessions
        .filter(s => s.config && liveKey(s.config) === key && s.id
          && sessionIdsInPanes.has(s.id) && hiddenTabSessions[s.id])
        .map(s => s.id)
    )
    return hiddenIds.size
  }

  // LIVE 行的 danger action: 把对应 saved 的所有 live entry 全关掉(clone/多次 connect 产生的 N 个一并清)
  // 已 disconnected 的 entry 也彻底摘掉
  const handleCloseLive = async (config: SessionConfig, e: React.MouseEvent) => {
    e.stopPropagation()
    const key = liveKey(config)
    // 快照一份 id 列表,避免边遍历边改 store
    const liveIds = sessions
      .filter(s => s.config && liveKey(s.config) === key)
      .map(s => s.id)
      .filter(Boolean)
    for (const liveId of liveIds) {
      removeSessionFromAllPanes(liveId)
      try { await disconnectSession(liveId) } catch { /* 已经断了也 OK */ }
      removeLiveSession(liveId)
    }
  }

  // LIVE 段 header 的 close-all: 遍历 liveSessions 走同一条 handleCloseLive 路径
  const handleCloseAllLive = async (e: React.MouseEvent) => {
    e.stopPropagation()
    // 走 handleCloseLive 而不是直接调 bestSessionFor —— 同一 saved 的 N 个 clone 也会一并清
    for (const config of liveSessions) {
      await handleCloseLive(config, e)
    }
  }

  // close-all 的点击 handler: 第一次进入 armed,第二次执行,2.5s 自动复位
  const handleCloseAllClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (closeAllArmed) {
      if (closeAllTimerRef.current !== null) {
        window.clearTimeout(closeAllTimerRef.current)
        closeAllTimerRef.current = null
      }
      setCloseAllArmed(false)
      await handleCloseAllLive(e)
      return
    }
    setCloseAllArmed(true)
    if (closeAllTimerRef.current !== null) window.clearTimeout(closeAllTimerRef.current)
    closeAllTimerRef.current = window.setTimeout(() => {
      setCloseAllArmed(false)
      closeAllTimerRef.current = null
    }, 2500)
  }

  // ───── 两段头数据 ─────
  // LIVE — saved session 的 live entry 必须出现在某个 pane 里才算"打开着的标签"
  // 不能只看 sessions 数组:loadSessions 会把所有 saved 都塞进去做 disconnected registry,bestSessionFor 对所有 saved 都返回 truthy
  const liveSessions = filteredSessions
    .filter(s => {
      const live = bestSessionFor(s)
      return !!live && sessionIdsInPanes.has(live.id)
    })
    .sort(sortByUpdateTime)

  const handleTogglePin = async (config: SessionConfig, e: React.MouseEvent) => {
    e.stopPropagation()
    const isPinned = config.tags?.includes('pinned')
    const newTags = isPinned ? config.tags.filter(t => t !== 'pinned') : [...(config.tags || []), 'pinned']
    let newPinOrder: number | undefined
    if (!isPinned) {
      const currentPinned = savedSessions.filter(s => s.tags?.includes('pinned'))
      const maxOrder = currentPinned.reduce((max, s) => s.pinOrder !== undefined ? Math.max(max, s.pinOrder) : max, -1)
      newPinOrder = maxOrder + 1
    }
    await window.electronAPI?.updateSession({ ...config, tags: newTags, pinOrder: newPinOrder, updatedAt: new Date() })
    await refreshSavedSessions()
  }

  const handleDragStart = (_e: React.DragEvent, index: number) => {
    setDraggedIndex(index)
  }
  // dragend 无论拖到目标还是中途取消/落到空白处都会触发 —— 唯一可靠的复位点。
  // 之前缺它:拖拽没落在别的 pinned 行上时 onDrop 不触发,draggedIndex 一直残留,行一直停在 isDragging 态放不掉。
  const handleDragEnd = () => {
    setDraggedIndex(null)
    setDragOverIndex(null)
  }
  const handleDragEnter = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDragOverIndex(index)
  }
  const handleDrop = async (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault()
    if (isUpdating.current) return
    isUpdating.current = true
    try {
      if (draggedIndex === null || draggedIndex === targetIndex) {
        setDraggedIndex(null)
        setDragOverIndex(null)
        return
      }
      const draggedSession = pinnedSessions[draggedIndex]
      const targetSession = pinnedSessions[targetIndex]
      if (!draggedSession?.id || !targetSession?.id) {
        setDraggedIndex(null)
        setDragOverIndex(null)
        return
      }
      const reordered = [...pinnedSessions]
      reordered.splice(draggedIndex, 1)
      reordered.splice(targetIndex, 0, draggedSession)
      for (let i = 0; i < reordered.length; i++) {
        const config = reordered[i]
        if (!config?.id) continue
        await window.electronAPI?.updateSession({ ...config, pinOrder: i })
      }
      await refreshSavedSessions()
      setDraggedIndex(null)
      setDragOverIndex(null)
    } finally {
      setTimeout(() => { isUpdating.current = false }, 300)
    }
  }

  // 走 store 的 deleteSession 而非裸 IPC + refreshSavedSessions：store 顺带清
  // pendingRuntimeEncoding 暂存与 sessions 里的 registry 条目（id=saved.id 的
  // disconnected 幽灵行），savedSessions 过滤也一并完成
  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm(t('sidebar.deleteSessionConfirm'))) {
      await deleteSession(sessionId)
    }
  }

  const handleSessionClick = (config: SessionConfig) => {
    onConnect?.(config.id, config)
  }

  // LIVE 段会话标签点击:不连接,而是切换该会话所有页签(含终端)的隐藏/还原
  // xterm 实例不卸载,连接与输出保留;再次点击同一标签即还原
  const handleLiveSessionToggleTabs = (config: SessionConfig) => {
    const key = liveKey(config)
    // 只取真正在某个 pane 里的 runtime session —— sessions 数组里还有同 liveKey 的
    // disconnected registry 条目(id = saved.id),它不在任何 pane,隐藏它无意义且会让计数虚高
    const liveIds = sessions
      .filter(s => s.config && liveKey(s.config) === key && s.id && sessionIdsInPanes.has(s.id))
      .map(s => s.id)
    if (liveIds.length === 0) return
    // 任一已隐藏 → 视为隐藏态,全部还原;否则全部隐藏
    const anyHidden = liveIds.some(id => usePaneStore.getState().hiddenTabSessions[id])
    usePaneStore.getState().toggleLiveSessionTabs(liveIds, !anyHidden)
  }

  const handleNewSession = () => {
    setEditConfig(undefined)
    setShowDialog(true)
  }

  const handleQuickLocal = async (shell: string, startupCommands?: string[]) => {
    const shellName = shell === 'powershell' ? 'PowerShell' : shell === 'pwsh' ? 'PowerShell 7' : 'CMD'
    const name = startupCommands ? `${shellName} (Admin)` : shellName
    const config: SessionConfig = {
      id: '',
      name,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: 'local' as any,
      local: { shell },
      terminal: {
        fontSize: 14,
        fontFamily: 'Consolas, Monaco, monospace',
        theme: {
          foreground: '#D4D4D4', background: '#1E1E1E', cursor: '#D4D4D4', selectionBackground: '#264F78',
          black: '#000000', red: '#CD3131', green: '#0DBC79', yellow: '#E5E510', blue: '#2472C8',
          magenta: '#BC3FBC', cyan: '#11A8CD', white: '#E5E5E5',
          brightBlack: '#666666', brightRed: '#F14C4C', brightGreen: '#23D18B', brightYellow: '#F5F543',
          brightBlue: '#3B8EEA', brightMagenta: '#D670D6', brightCyan: '#29B8DB', brightWhite: '#E5E5E5'
        },
        cursorStyle: 'bar', cursorBlink: true, scrollback: 10000, encoding: 'utf-8'
      },
      tags: [], startupCommands, createdAt: new Date(), updatedAt: new Date()
    }
    onConnect?.('', config)
  }

  const handleEditSession = (config: SessionConfig, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditConfig(config)
    setShowDialog(true)
  }

  const handleCopySession = (config: SessionConfig, e: React.MouseEvent) => {
    e.stopPropagation()
    const copiedConfig: SessionConfig = {
      ...config,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      id: undefined as any,
      name: config.name ? `${config.name} Copy` : '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createdAt: undefined as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updatedAt: undefined as any
    }
    setEditConfig(copiedConfig)
    setShowDialog(true)
  }

  // 底部计数
  const liveCount = sessions.filter(s => s.status === 'connected' && !isAgentSession(s.config)).length
  const idleCount = displayedSessions.length - liveCount

  return (
    <>
      <div
        ref={sidebarRef}
        className="bg-[var(--bg-base)] flex flex-col h-full sidebar-container"
        style={{ fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
      >
        {/* ===== 系统区 ===== 头行高对齐终端第一行(TOPBAR_HEIGHT):轨顶收起槽 / 本头行 /
             页签条在窗口顶部读作同一条横线。铭牌 = 产品名 + 编译期版本号
             (__APP_VERSION__ 由 vite define 注入,升版不用手改这里) */}
        <div
          className="flex items-center justify-between px-3 border-b border-[var(--rule)]"
          style={{ height: TOPBAR_HEIGHT }}
        >
          {/* 铭牌 = 设备徽章的语言:厂牌丝印 + 打字机固件号。品牌名走系统 UI 字体
              (Segoe UI Variable Display,Win11 自带、hinting 完整,任何字号都锐利不发虚),
              微收的 tracking 是 logotype 的紧凑感;版本号留在面板等宽栈里做「读数」--
              两种字面的并置就是机柜徽章的辨识度,等宽粗体做铭牌反而像玩具打字机 */}
          <span className="flex items-baseline gap-2 select-none">
            <span
              className="font-bold tracking-[-0.01em] text-[16px] text-[var(--text-rack)]"
              style={{ fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif' }}
            >
              LyShell
            </span>
            <span className="text-[12px] text-[var(--text-rack-mute)] tabular-nums">v{__APP_VERSION__}</span>
          </span>
          <div className="flex gap-0.5">
            <IconBtn amber onClick={handleNewSession} title={t('sidebar.newSession')}><IconPlus /></IconBtn>
            <IconBtn onClick={handleOpenExportImport} title={t('sidebar.exportImport')}><IconDownload /></IconBtn>
          </div>
        </div>

        {/* ===== LAUNCH STRIP ===== */}
        <StripRow label={t('sidebar.stripLaunch')}>
          <ShellPill shell="cmd" glyph="▮" onClick={() => handleQuickLocal('')}>cmd</ShellPill>
          <ShellPill shell="ps"  glyph="◆" onClick={() => handleQuickLocal('powershell')}>ps</ShellPill>
          <ShellPill shell="ps7" glyph="◇" onClick={() => handleQuickLocal('pwsh')}>ps7</ShellPill>
          <ShellPill shell="ps+" glyph="⛨" onClick={() => handleQuickLocal('powershell', ['gsudo'])}>ps+</ShellPill>
        </StripRow>

        {/* ===== 过滤区 ===== */}
        <div className="px-3 py-2 border-b border-[var(--rule)] flex items-center gap-1.5">
          <div className="flex-1 flex items-center gap-2 bg-[var(--bg-rack)] border border-[var(--rule)] rounded-[3px] px-2.5 py-1.5 focus-within:border-[var(--amber)] transition-colors">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[var(--text-rack-mute)] flex-shrink-0">
              <circle cx="5" cy="5" r="3"/><path d="m11 11-3.5-3.5"/>
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('sidebar.filterPlaceholder')}
              className="flex-1 bg-transparent border-none outline-none text-[12px] text-[var(--text-rack)] placeholder:text-[var(--text-rack-dim)]"
            />
          </div>
          <button
            onClick={toggleAllGroups}
            title={allGroupsCollapsed ? t('sidebar.expandAllGroups') : t('sidebar.collapseAllGroups')}
            className="w-[26px] h-[26px] flex-shrink-0 flex items-center justify-center bg-transparent border border-[var(--rule)] rounded-[3px] text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] hover:border-[var(--text-rack-mute)] cursor-pointer transition-colors"
          >
            {allGroupsCollapsed ? (
              // 展开图标：两个 chevron 向外
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square">
                <path d="M3 4l3-3 3 3M3 8l3 3 3-3"/>
              </svg>
            ) : (
              // 折叠图标：两个 chevron 向内
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square">
                <path d="M3 2l3 3 3-3M3 10l3-3 3 3"/>
              </svg>
            )}
          </button>
        </div>

        {/* ===== 快捷命令（原底部状态栏迁入，搜索框下方） ===== */}
        <QuickCommandsPanel onExecuteCommand={onExecuteCommand} disabled={quickCommandsDisabled} />

        {/* ===== 列表 ===== */}
        <div className="flex-1 overflow-y-auto min-h-[100px] rack-scroll">
          {/* LIVE — 当下已连接 */}
          {liveSessions.length > 0 && (
            <>
              <GroupHeader
                tone="live"
                icon={<IconLive />}
                label={t('sidebar.groupLive')}
                count={liveSessions.length}
                collapsed={liveCollapsed}
                onToggle={() => setLiveCollapsed(c => !c)}
                action={
                  <button
                    onClick={handleCloseAllClick}
                    title={closeAllArmed
                      ? t('sidebar.closeAllConfirm', { count: liveSessions.length })
                      : t('sidebar.closeAllConnections', { count: liveSessions.length })}
                    className={cn(
                      'ml-1.5 h-[18px] inline-flex items-center justify-center gap-[3px] rounded-[2px] cursor-pointer text-[10px] [font-family:inherit] tracking-[.02em] transition-colors',
                      closeAllArmed
                        ? 'px-1.5 bg-[var(--error-rack)] text-[var(--bg-base)] font-semibold'
                        : 'w-[18px] text-[var(--text-rack-mute)] hover:text-[var(--error-rack)] hover:bg-[var(--bg-elev)]'
                    )}
                  >
                    {closeAllArmed && <span className="tabular-nums">{liveSessions.length}</span>}
                    <IconPower />
                  </button>
                }
              />
              {!liveCollapsed && liveSessions.map(config => (
                <SessionSlot
                  key={`live-${config.id}`}
                  config={config}
                  status={statusFor(config)}
                  reachable={reachabilityFor(config)}
                  active={false}
                  isPinned={!!config.tags?.includes('pinned')}
                  compactActions
                  dimmed={isLiveHidden(config)}
                  hiddenCount={liveHiddenCount(config)}
                  onClick={() => handleLiveSessionToggleTabs(config)}
                  onEdit={(e) => handleEditSession(config, e)}
                  onCopy={(e) => handleCopySession(config, e)}
                  onTogglePin={(e) => handleTogglePin(config, e)}
                  /* LIVE 行的 X 改成关闭终端,不动 saved config */
                  onDelete={(e) => handleCloseLive(config, e)}
                  dangerIcon={<IconPower />}
                  dangerTitle="Close terminal"
                />
              ))}
            </>
          )}

          {/* PINNED */}
          {pinnedSessions.length > 0 && (
            <>
              <GroupHeader
                amber
                icon={<IconStar filled />}
                label={t('sidebar.groupPinned')}
                count={pinnedSessions.length}
                collapsed={pinnedCollapsed}
                onToggle={() => setPinnedCollapsed(c => !c)}
              />
              {!pinnedCollapsed && pinnedSessions.map((config, index) => (
                <SessionSlot
                  key={config.id}
                  config={config}
                  status={statusFor(config)}
                  reachable={reachabilityFor(config)}
                  active={false}
                  isPinned
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragEnter={(e) => handleDragEnter(e, index)}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                  isDragging={draggedIndex === index}
                  isDragOver={dragOverIndex === index && draggedIndex !== index}
                  onClick={() => handleSessionClick(config)}
                  onEdit={(e) => handleEditSession(config, e)}
                  onCopy={(e) => handleCopySession(config, e)}
                  onTogglePin={(e) => handleTogglePin(config, e)}
                  onDelete={(e) => handleDeleteSession(config.id, e)}
                />
              ))}
            </>
          )}

          {/* 协议筛选 chips —— LED 通道条:每颗 = 一盏协议状态灯 + 铭牌 + 读数;多选 toggle,全空 = 显示全部 */}
          <div className="flex items-stretch gap-[4px] px-2 py-2 bg-[var(--bg-strip)] border-y border-[var(--rule)]">
            {PROTO_KINDS.map(p => {
              const active = protoFilter.has(p)
              const count = protoCounts[p]
              // LOC 和 SER 是冷门协议,没会话时直接不渲染,避免占位干扰;SSH/TEL 始终保留(主流,占位有意义)
              if ((p === 'local' || p === 'serial') && count === 0) return null
              const disabled = count === 0
              return (
                <button
                  key={p}
                  onClick={() => !disabled && toggleProtoFilter(p)}
                  disabled={disabled}
                  title={disabled ? t('sidebar.noProtoSessions', { proto: PROTO_LABEL[p] }) : (active ? t('sidebar.clearProtoFilter', { proto: PROTO_LABEL[p] }) : t('sidebar.showOnlyProto', { proto: PROTO_LABEL[p] }))}
                  className={cn(
                    // 单行:LED · 铭牌 · 读数。带 border——按钮物体边界;
                    // 未选中=透明底 + 协议色淡 border-2;选中=透明底 + 协议色满色 border-2(亮框框住)。两态都不填充,纯靠边框深浅区分
                    'group relative flex-1 h-[28px] flex items-center gap-[6px] px-[8px] rounded-[2px] border-2 transition-colors',
                    disabled && 'opacity-25 cursor-not-allowed border-[var(--rule-soft)]',
                    !disabled && (active
                      ? PROTO_ACTIVE_CLS[p]
                      : PROTO_IDLE_CLS[p])
                  )}
                >
                  {/* LED —— 协议状态灯。off=/30 待机(仍可见),on=满色+光晕。状态信号全在这里 */}
                  <span
                    aria-hidden
                    className={cn(
                      'w-[6px] h-[6px] rounded-full flex-shrink-0 transition-all',
                      active ? PROTO_LED_LIT_CLS[p] : PROTO_LED_DIM_CLS[p]
                    )}
                  />
                  {/* 铭牌:未选中 text-rack 近白,选中点亮成协议色 */}
                  <span className={cn('[font-family:inherit] text-[12px] font-semibold tracking-[.12em]', active ? PROTO_TEXT_LIT_CLS[p] : 'text-[var(--text-rack)]')}>{PROTO_LABEL[p]}</span>
                  {/* 读数:未选中中性数据色,选中点亮成协议色,右贴边 */}
                  <span className={cn('ml-auto [font-family:inherit] text-[13px] font-semibold tabular-nums', active ? PROTO_TEXT_LIT_CLS[p] : 'text-[var(--text-rack-data)]')}>{count}</span>
                </button>
              )
            })}
          </div>

          {/* 子网分组 — 按 /24 折叠 IPv4,非 IP host(主机名 / 串口 / local)各自成组,均可折叠 */}
          {sortedSubnetGroups.map(([groupKey, group]) => {
            const sorted = group.length === 1 ? group : [...group].sort(sortByPinOrder)
            const expanded = expandedIPs[groupKey] !== false  // 默认展开
            return (
              <React.Fragment key={groupKey}>
                <GroupHeader
                  icon={<IconRack />}
                  label={groupKey}
                  count={group.length}
                  monoLabel
                  collapsed={!expanded}
                  onToggle={() => toggleIPGroup(groupKey)}
                />
                {expanded && sorted.map(config => (
                  <SessionSlot
                    key={config.id}
                    config={config}
                    status={statusFor(config)}
                    reachable={reachabilityFor(config)}
                    active={false}
                    isPinned={false}
                    onClick={() => handleSessionClick(config)}
                    onEdit={(e) => handleEditSession(config, e)}
                    onCopy={(e) => handleCopySession(config, e)}
                    onTogglePin={(e) => handleTogglePin(config, e)}
                    onDelete={(e) => handleDeleteSession(config.id, e)}
                  />
                ))}
              </React.Fragment>
            )
          })}

          {filteredSessions.length === 0 && (
            <div className="text-center py-8 px-4 text-[var(--text-rack-dim)] flex flex-col items-center gap-2">
              <span className="[font-family:inherit] text-[16px] text-[var(--text-rack-dim)] tracking-[.1em]">─ · ─</span>
              <span className="text-[11.5px] text-[var(--text-rack-mute)]">
                {searchQuery.trim() ? t('sidebar.noMatches') : t('sidebar.noSessionsYet')}
              </span>
              <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-faint)]">
                {searchQuery.trim() ? t('sidebar.tryDifferentKeyword') : t('sidebar.clickAboveToCreate')}
              </span>
            </div>
          )}
        </div>

        {/* ===== 文件管理器分割线 ===== */}
        <div
          className="h-[4px] bg-[var(--rule)] cursor-row-resize hover:bg-[var(--amber)] transition-colors flex items-center justify-center relative"
          onMouseDown={() => setIsResizingHeight(true)}
        >
          <div
            className="absolute -top-[4px] left-0 right-0 h-[4px] cursor-row-resize"
            onMouseDown={() => setIsResizingHeight(true)}
          />
          <div className="w-[30px] h-[2px] bg-[var(--text-rack-dim)] rounded" />
        </div>

        {/* ===== FileManager ===== */}
        <div style={{ height: `${fileManagerHeight}px` }} className="flex-shrink-0 overflow-hidden">
          <FileManagerPanel />
        </div>

        {/* ===== 底部 status ===== */}
        <div
          className="flex items-center justify-between overflow-hidden px-2.5 py-1.5 border-t border-[var(--rule)] bg-[var(--bg-rack)] text-[12px] font-semibold text-[var(--text-rack-data)] min-h-[28px]"
          style={{
            fontFamily: STATUSBAR_FONT_STACK,
            fontFeatureSettings: '"tnum" 1'
          }}
        >
          {/* 终端状态读数 —— 活动分屏的活动会话(协议/编码/尺寸/行数),从 LIVE 段头迁来,常驻可见不受段折叠影响。
              占左槽,与 alt 快捷键提示互斥:有活动终端且未被覆盖层盖住时读数优先,否则回落提示
              (读数+提示+计数三段在 240px 默认侧栏放不下);在线/空闲计数固定右槽。
              收缩策略:计数 flex-shrink-0 恒不缩,左槽 min-w-0 + overflow-hidden 兜底裁切;
              常规窄宽先走两级降级(行数 <300 / 尺寸段 <260 整段退场,见 statusHideLines),
              overflow 裁切只剩极端窄宽(或行数到 99.9k 级)的最终防线,溢出被拦在栏内、
              不上溢到拖宽条;两槽统一 12px、gap-1,
              按默认侧栏宽校准;协议码用协议色(与会话行同语言);栏本身已是 mono,TerminalSize 直接继承。
              字体用打包的 Maple(圆角等宽,即终端 webfont —— TERMINAL_WEBFONT_FAMILY 同源;笔画粗、
              x-height 大,12px 小字号下比 Cascadia Code 这类轻 hinting 细笔画字体发虚得少,读数更清晰),
              swap 期回落 Cascadia/Consolas,中文回落雅黑;栏外侧栏其余部分仍走通用 mono 栈,不跟改。
              整栏 font-semibold:Maple 只捆了 Regular/Bold 两档(无 Medium/SemiBold),600 解析到
              真实 Bold 字面(非合成加粗,笔画成形不发虚),读数笔画更粗更清晰;协议码原有的
              font-semibold 随之冗余但保留,栏重改回 normal 时它仍自洽。
              编码跟在协议码后(local 不显示,见上方 activeTerminalEncoding 注释);左槽各读数段
              (协议/编码/尺寸/行数)一律竖规(BarRule)隔开,与右槽计数对的分隔同节奏;
              编码→尺寸的竖规由 TerminalSize 自带(实例注册前的空窗期随尺寸读数一起缺席,
              不在编码段尾硬挂一条,免得空窗期悬空)。 */}
          {activeTerminalSessionId ? (
            <span className="inline-flex items-center gap-1 min-w-0 overflow-hidden text-[var(--text-rack-data)] whitespace-nowrap">
              {activeTerminalProto && (
                <span className={cn('font-semibold tracking-[.08em]', PROTO_TEXT_CLS[activeTerminalProto])}>
                  {PROTO_LABEL[activeTerminalProto]}
                </span>
              )}
              {activeTerminalEncoding && (
                <>
                  <BarRule />
                  <button
                    ref={encodingBtnRef}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleEncodingClick}
                    title={t('statusbar.encodingHint')}
                    className={cn(
                      'tracking-[.04em] bg-transparent border-0 p-0 cursor-pointer [font-family:inherit] [font-size:inherit] [line-height:inherit] transition-colors',
                      encodingMenu ? 'text-[var(--text-rack)]' : 'hover:text-[var(--text-rack)]'
                    )}
                  >
                    {activeTerminalEncoding.toUpperCase()}
                  </button>
                </>
              )}
              {/* 窄宽降级:侧栏拖窄到放不下整段时按价值退场,见上方 statusHideLines 注释 */}
              {!statusHideSize && (
                <TerminalSize sessionId={activeTerminalSessionId} hideLines={statusHideLines} />
              )}
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 min-w-0 overflow-hidden whitespace-nowrap">
              <span>{t('sidebar.footerShortcut', { n: 9 })}</span>
            </span>
          )}
          <span className="inline-flex items-center gap-1 flex-shrink-0 whitespace-nowrap">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--live)] animate-breathe flex-shrink-0" />
            <span>
              <span className="text-[var(--text-rack)] tabular-nums">{liveCount}</span>
              <span className="ml-1">{t('sidebar.footerLive')}</span>
            </span>
            <BarRule />
            <span>
              <span className="text-[var(--text-rack)] tabular-nums">{Math.max(0, idleCount)}</span>
              <span className="ml-1">{t('sidebar.footerIdle')}</span>
            </span>
          </span>
        </div>
      </div>

      {/* 编码选择菜单 —— portal 挂 body 脱离侧栏的 overflow 裁切;样式对齐 PaneTabBar
          悬停卡(bg-slot + rule 边 + shadow),字体走 STATUSBAR_FONT_STACK 保证菜单值与读数同风格 */}
      {encodingMenu && activeTerminalEncoding && createPortal(
        <div
          ref={encodingMenuRef}
          className="fixed z-[300] py-1 rounded-[3px] bg-[var(--bg-slot)] border border-[var(--rule)] shadow-xl flex flex-col min-w-[92px]"
          style={{
            top: encodingMenu.top,
            left: encodingMenu.left,
            transform: 'translateY(-100%)',
            fontFamily: STATUSBAR_FONT_STACK
          }}
        >
          {TERMINAL_ENCODINGS.map(enc => {
            const isOn = enc === activeTerminalEncoding
            return (
              <button
                key={enc}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => { e.stopPropagation(); handleEncodingPick(enc) }}
                className={cn(
                  'flex items-center justify-between gap-3 px-2.5 py-1 bg-transparent border-0 cursor-pointer [font-size:12px] tracking-[.04em] transition-colors',
                  isOn
                    ? 'text-[var(--amber)] bg-[var(--amber-soft)]'
                    : 'text-[var(--text-rack-data)] hover:text-[var(--text-rack)] hover:bg-[var(--bg-elev)]'
                )}
              >
                <span>{enc.toUpperCase()}</span>
                {isOn && <span aria-hidden className="text-[11px]">✓</span>}
              </button>
            )
          })}
        </div>,
        document.body
      )}

      {/* 会话对话框 */}
      <SessionDialog
        open={showDialog}
        onClose={() => { setShowDialog(false); setEditConfig(undefined) }}
        initialConfig={editConfig}
        onSubmit={async (config) => {
          if (editConfig) {
            await window.electronAPI?.updateSession(config)
            refreshSavedSessions()
            return config.id
          }
          const newConfig = await window.electronAPI?.createSession(config)
          if (newConfig?.id) onConnect?.(newConfig.id, newConfig)
          refreshSavedSessions()
          return newConfig?.id
        }}
      />

      {/* 导出导入对话框 */}
      <ExportImportDialog
        open={showExportImport}
        onClose={() => setShowExportImport(false)}
        sessions={savedSessions}
        quickCommands={quickCommands}
        onImportComplete={handleImportComplete}
      />

    </>
  )
}

export default SessionsPanel
