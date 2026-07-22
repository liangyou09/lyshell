import React, { useState, useEffect, useRef, useMemo } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import type { SessionConfig, PaneNode } from '@shared/types'
import { useSessionStore } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import SessionDialog from '../SessionDialog/SessionDialog'
import ExportImportDialog from '../ExportImportDialog/ExportImportDialog'
import FileManagerPanel from '../FileManager/FileManagerPanel'
import i18n from '../../i18n'

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

interface QuickCommand {
  id: string
  name: string
  content: string
}

interface AgentConfig {
  id: string
  name: string
  command: string
  icon?: string
  cwd?: string
  env?: Record<string, string>
  order: number
}

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  onConnect?: (sessionId: string, config: SessionConfig) => void
  onQuickCommandsChange?: () => void
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

const IconPlus = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"><path d="M7 2v10M2 7h10"/></svg>
)
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
const IconAddTiny = () => (
  <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M4.5 1v7M1 4.5h7"/></svg>
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

const IconBtn: React.FC<{
  onClick?: () => void
  title?: string
  amber?: boolean
  children: React.ReactNode
}> = ({ onClick, title, amber, children }) => (
  <button
    onClick={onClick}
    title={title}
    className={cn(
      'w-[24px] h-[24px] flex items-center justify-center bg-transparent border-none rounded-[3px] cursor-pointer transition-colors',
      'text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)]',
      amber ? 'hover:text-[var(--amber)]' : 'hover:text-[var(--text-rack)]'
    )}
  >
    {children}
  </button>
)

const StripRow: React.FC<{ label: string; children: React.ReactNode; wrap?: boolean }> = ({ label, children, wrap }) => (
  <div className="grid grid-cols-[52px_1fr] items-center gap-2 px-3 py-1.5 bg-[var(--bg-strip)] border-b border-[var(--rule-soft)]">
    <span className="font-mono font-bold text-[12px] text-[var(--text-rack)]">
      {label}
    </span>
    {/* wrap=true: agents 等数量不定的项换行展示,避免单行横向滚动+隐藏滚动条导致看不全 */}
    <div className={cn(
      'flex items-center gap-1 min-w-0',
      wrap ? 'flex-wrap' : 'overflow-x-auto scrollbar-hide'
    )}>
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
        'inline-flex items-center gap-[5px] flex-shrink-0 px-2 py-[3px] rounded-[3px] cursor-pointer whitespace-nowrap',
        'text-[11.5px] font-medium text-[var(--text-rack)] bg-transparent border border-[var(--rule)]',
        'hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)] transition-colors',
        borderHover
      )}
    >
      <span className={cn('font-mono text-[11px] w-[11px] inline-flex justify-center', glyphColor)}>{glyph}</span>
      <span>{children}</span>
    </button>
  )
}

const AgentPill: React.FC<{
  agent: AgentConfig
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}> = ({ agent, onClick, onContextMenu }) => (
  <button
    onClick={onClick}
    onContextMenu={onContextMenu}
    title={`${agent.name}: ${agent.command}`}
    className={cn(
      'inline-flex items-center gap-[5px] flex-shrink-0 px-2 py-[3px] rounded-[3px] cursor-pointer whitespace-nowrap',
      'text-[11.5px] font-medium text-[var(--text-rack)] bg-transparent border border-[var(--rule)]',
      'hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)] hover:border-[var(--amber)] transition-colors'
    )}
  >
    {agent.icon && <span className="text-[11.5px] leading-none">{agent.icon}</span>}
    <span>{agent.name}</span>
  </button>
)

const StripAdd: React.FC<{ onClick: () => void; title?: string }> = ({ onClick, title }) => (
  <button
    onClick={onClick}
    title={title}
    className={cn(
      'w-[22px] h-[22px] flex-shrink-0 ml-0.5 inline-flex items-center justify-center cursor-pointer rounded-[3px]',
      'bg-transparent border border-dashed border-[var(--rule)] text-[var(--text-rack-dim)]',
      'hover:border-[var(--amber)] hover:border-solid hover:text-[var(--amber)] transition-colors'
    )}
  >
    <IconAddTiny />
  </button>
)

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
            ? 'font-mono normal-case tracking-[.04em] text-[var(--text-rack)] font-normal text-[10.5px]'
            : 'font-mono font-bold text-[11px] text-[var(--text-rack)]'
        )}
      >
        {label}
      </span>
      <span className="flex-1 h-px bg-[var(--rule)]" />
      <span className="font-mono text-[10px] text-[var(--text-rack-data)] tracking-[.04em] normal-case">{count}</span>
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
  isDragging?: boolean
  isDragOver?: boolean
}> = ({
  config, status, reachable, active, isPinned, draggable,
  onClick, onEdit, onCopy, onTogglePin, onDelete, dangerIcon, dangerTitle, compactActions, dimmed, hiddenCount,
  onDragStart, onDragEnter, onDrop, isDragging, isDragOver
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
          'font-mono text-[12px] font-bold uppercase tracking-[.04em]'
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
            className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1 rounded-[2px] bg-[var(--bg-elev)] text-[var(--amber)] font-mono text-[12px] font-bold tabular-nums leading-none"
          >
            {hiddenCount}
          </span>
        ) : null}
        {config.name}
      </span>
      <span className="font-mono text-[11px] text-[var(--text-rack-data)] truncate min-w-0 leading-none inline-flex items-end h-[22px] pb-[5px]">
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
// Sidebar 主体
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 侧边栏组件 - 左侧会话机架 + 底部嵌入文件管理器
 * 支持宽度调整（右边缘拖动）和文件管理器高度调整（分割线拖动）
 */
const Sidebar: React.FC<SidebarProps> = ({ collapsed, onConnect, onQuickCommandsChange }) => {
  const [showDialog, setShowDialog] = useState(false)
  const [editConfig, setEditConfig] = useState<SessionConfig | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')
  const [showExportImport, setShowExportImport] = useState(false)
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([])
  const { savedSessions, sessions, reachability, refreshSavedSessions, disconnectSession, removeLiveSession } = useSessionStore()
  const removeSessionFromAllPanes = usePaneStore(s => s.removeSessionFromAllPanes)
  const { t } = useTranslation()
  // 被隐藏的终端页签(Sidebar LIVE 段会话标签点击 toggle)——用于给已隐藏的 LIVE 标签置灰
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
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const isUpdating = useRef(false)

  // 宽度状态
  const [width, setWidth] = useState(240)
  const [fileManagerHeight, setFileManagerHeight] = useState(200)
  const [isResizingWidth, setIsResizingWidth] = useState(false)
  const [isResizingHeight, setIsResizingHeight] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)

  // Agent 状态（吸收自原 AgentBar）
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [showAgentDialog, setShowAgentDialog] = useState(false)
  const [editAgent, setEditAgent] = useState<AgentConfig | undefined>(undefined)
  const [agentName, setAgentName] = useState('')
  const [agentCommand, setAgentCommand] = useState('')
  const [agentIcon, setAgentIcon] = useState('')
  const [agentCwd, setAgentCwd] = useState('')

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

  // 加载快速命令
  useEffect(() => {
    window.electronAPI?.getQuickCommands().then((cmds: unknown) => {
      if (Array.isArray(cmds)) setQuickCommands(cmds as QuickCommand[])
    }).catch(err => console.error('Failed to load quick commands:', err))
  }, [])

  // 加载 Agent
  const loadAgents = async () => {
    try {
      const result = await window.electronAPI?.listAgents()
      if (Array.isArray(result)) setAgents(result as AgentConfig[])
    } catch (err) {
      console.error('Failed to load agents:', err)
    }
  }
  useEffect(() => { loadAgents() }, [])

  // 监听新建会话事件
  useEffect(() => {
    const handleNewSession = () => {
      setEditConfig(undefined)
      setShowDialog(true)
    }
    window.addEventListener('newSession', handleNewSession)
    return () => window.removeEventListener('newSession', handleNewSession)
  }, [])

  // 加载保存的会话列表
  useEffect(() => {
    refreshSavedSessions()
  }, [refreshSavedSessions])

  // 加载保存的 UI 配置
  useEffect(() => {
    const loadUIConfig = async () => {
      try {
        const savedWidth = await window.electronAPI?.getConfig('sidebarWidth')
        if (savedWidth && savedWidth > 0) setWidth(savedWidth)
        const savedHeight = await window.electronAPI?.getConfig('fileManagerHeight')
        if (savedHeight && savedHeight > 0) setFileManagerHeight(savedHeight)
      } catch (e) {
        console.warn('Failed to load UI config:', e)
      }
    }
    loadUIConfig()
  }, [])

  // 保存宽度（带防抖）
  useEffect(() => {
    const timer = setTimeout(() => {
      window.electronAPI?.setConfig('sidebarWidth', width)
    }, 500)
    return () => clearTimeout(timer)
  }, [width])

  // 保存文件管理器高度（带防抖）
  useEffect(() => {
    const timer = setTimeout(() => {
      window.electronAPI?.setConfig('fileManagerHeight', fileManagerHeight)
    }, 500)
    return () => clearTimeout(timer)
  }, [fileManagerHeight])

  // 宽度拖动
  useEffect(() => {
    if (!isResizingWidth) return
    const handleMouseMove = (e: MouseEvent) => setWidth(Math.max(180, Math.min(400, e.clientX)))
    const handleMouseUp = () => setIsResizingWidth(false)
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizingWidth])

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
    const saved = localStorage.getItem('quickCommands')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed)) setQuickCommands(parsed)
      } catch {
        setQuickCommands([])
      }
    } else {
      setQuickCommands([])
    }
    setShowExportImport(true)
  }

  const handleImportComplete = async () => {
    try {
      const cmds = await window.electronAPI?.getQuickCommands()
      if (Array.isArray(cmds)) setQuickCommands(cmds as QuickCommand[])
      onQuickCommandsChange?.()
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

  const filteredSessions = savedSessions.filter(s => s && matchesSearch(s))

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

  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm(t('sidebar.deleteSessionConfirm'))) {
      await window.electronAPI?.deleteSession(sessionId)
      refreshSavedSessions()
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

  const handleLaunchAgent = async (agentId: string) => {
    await window.electronAPI?.launchAgent(agentId)
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

  // Agent 对话框
  const handleAgentAdd = () => {
    setEditAgent(undefined)
    setAgentName(''); setAgentCommand(''); setAgentIcon(''); setAgentCwd('')
    setShowAgentDialog(true)
  }
  const handleAgentContextMenu = (agent: AgentConfig, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    setEditAgent(agent)
    setAgentName(agent.name); setAgentCommand(agent.command)
    setAgentIcon(agent.icon || ''); setAgentCwd(agent.cwd || '')
    setShowAgentDialog(true)
  }
  const handleAgentSave = async () => {
    if (!agentName.trim() || !agentCommand.trim()) return
    if (editAgent) {
      await window.electronAPI?.updateAgent({
        ...editAgent,
        name: agentName.trim(),
        command: agentCommand.trim(),
        icon: agentIcon || undefined,
        cwd: agentCwd || undefined
      })
    } else {
      await window.electronAPI?.addAgent({
        name: agentName.trim(),
        command: agentCommand.trim(),
        icon: agentIcon || undefined,
        cwd: agentCwd || undefined,
        order: agents.length
      })
    }
    await loadAgents()
    setShowAgentDialog(false)
  }
  const handleAgentDelete = async () => {
    if (editAgent) {
      await window.electronAPI?.deleteAgent(editAgent.id)
      await loadAgents()
      setShowAgentDialog(false)
    }
  }

  // 底部计数
  const liveCount = sessions.filter(s => s.status === 'connected').length
  const idleCount = savedSessions.length - liveCount

  if (collapsed) return null

  return (
    <>
      <div
        ref={sidebarRef}
        className="bg-[var(--bg-base)] border-r border-[var(--rule)] flex flex-col h-full sidebar-container"
        style={{ width: `${width}px`, pointerEvents: 'auto' }}
      >
        {/* ===== 系统区 ===== */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--rule)]">
          <span className="font-semibold tracking-[.18em] text-[11px] text-[var(--text-rack)] select-none">
            LYSHELL<span className="text-[var(--amber)] mx-1.5 font-normal">·</span>
            <span className="text-[var(--text-rack-mute)] font-medium">RACK</span>
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

        {/* ===== AGENTS STRIP ===== */}
        <StripRow label={t('sidebar.stripAgents')} wrap>
          {agents.map(a => (
            <AgentPill
              key={a.id}
              agent={a}
              onClick={() => handleLaunchAgent(a.id)}
              onContextMenu={(e) => handleAgentContextMenu(a, e)}
            />
          ))}
          <StripAdd onClick={handleAgentAdd} title={t('sidebar.addAgent')} />
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
                      'ml-1.5 h-[18px] inline-flex items-center justify-center gap-[3px] rounded-[2px] cursor-pointer text-[10px] font-mono tracking-[.02em] transition-colors',
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
                  <span className={cn('font-mono text-[12px] font-semibold tracking-[.12em]', active ? PROTO_TEXT_LIT_CLS[p] : 'text-[var(--text-rack)]')}>{PROTO_LABEL[p]}</span>
                  {/* 读数:未选中中性数据色,选中点亮成协议色,右贴边 */}
                  <span className={cn('ml-auto font-mono text-[13px] font-semibold tabular-nums', active ? PROTO_TEXT_LIT_CLS[p] : 'text-[var(--text-rack-data)]')}>{count}</span>
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
              <span className="font-mono text-[16px] text-[var(--text-rack-dim)] tracking-[.1em]">─ · ─</span>
              <span className="text-[11.5px] text-[var(--text-rack-mute)]">
                {searchQuery.trim() ? t('sidebar.noMatches') : t('sidebar.noSessionsYet')}
              </span>
              <span className="text-[10.5px] font-mono text-[var(--text-rack-faint)]">
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
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-[var(--rule)] bg-[var(--bg-rack)] font-mono text-[11.5px] text-[var(--text-rack-mute)] tracking-[.02em] min-h-[26px]">
          <span className="inline-flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--live)] animate-breathe flex-shrink-0" />
            <span>
              <span className="text-[var(--text-rack-data)] tabular-nums">{liveCount}</span>
              <span className="ml-1">{t('sidebar.footerLive')}</span>
            </span>
            <span aria-hidden className="w-px h-[10px] bg-[var(--rule)]" />
            <span>
              <span className="text-[var(--text-rack-data)] tabular-nums">{Math.max(0, idleCount)}</span>
              <span className="ml-1">{t('sidebar.footerIdle')}</span>
            </span>
          </span>
          <span className="text-[var(--text-rack-mute)]">{t('sidebar.footerShortcut')}</span>
        </div>
      </div>

      {/* 右边缘宽度调整条 */}
      <div
        className="w-[4px] bg-[var(--rule)] cursor-col-resize hover:bg-[var(--amber)] transition-colors flex-shrink-0 relative"
        onMouseDown={() => setIsResizingWidth(true)}
      >
        <div
          className="absolute -left-[4px] top-0 bottom-0 w-[4px] cursor-col-resize"
          onMouseDown={() => setIsResizingWidth(true)}
        />
      </div>

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

      {/* Agent 编辑对话框（吸收自原 AgentBar） */}
      {showAgentDialog && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-[var(--bg-elev)] border border-[var(--rule)] rounded-md shadow-xl w-[380px] p-4">
            <div className="text-sm text-[var(--text-rack)] font-medium mb-3">
              {editAgent ? t('sidebar.agentEditTitle') : t('sidebar.agentAddTitle')}
            </div>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <label className="text-xs text-[var(--text-rack-mute)] w-16 shrink-0">{t('sidebar.agentFieldName')}</label>
                <input
                  type="text"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="Claude Code"
                  autoFocus
                  className="flex-1 px-3 py-1.5 bg-[var(--bg-base)] border border-[var(--rule)] rounded text-sm text-[var(--text-rack)] placeholder:text-[var(--text-rack-dim)] focus:outline-none focus:border-[var(--amber)]"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-[var(--text-rack-mute)] w-16 shrink-0">{t('sidebar.agentFieldCommand')}</label>
                <input
                  type="text"
                  value={agentCommand}
                  onChange={(e) => setAgentCommand(e.target.value)}
                  placeholder="claude"
                  className="flex-1 px-3 py-1.5 bg-[var(--bg-base)] border border-[var(--rule)] rounded text-sm text-[var(--text-rack)] placeholder:text-[var(--text-rack-dim)] focus:outline-none focus:border-[var(--amber)]"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-[var(--text-rack-mute)] w-16 shrink-0">{t('sidebar.agentFieldIcon')}</label>
                <input
                  type="text"
                  value={agentIcon}
                  onChange={(e) => setAgentIcon(e.target.value)}
                  placeholder="🤖"
                  className="w-16 px-3 py-1.5 bg-[var(--bg-base)] border border-[var(--rule)] rounded text-sm text-[var(--text-rack)] placeholder:text-[var(--text-rack-dim)] focus:outline-none focus:border-[var(--amber)]"
                />
                <label className="text-xs text-[var(--text-rack-mute)] w-16 shrink-0">{t('sidebar.agentFieldWorkdir')}</label>
                <input
                  type="text"
                  value={agentCwd}
                  onChange={(e) => setAgentCwd(e.target.value)}
                  placeholder="Optional"
                  className="flex-1 px-3 py-1.5 bg-[var(--bg-base)] border border-[var(--rule)] rounded text-sm text-[var(--text-rack)] placeholder:text-[var(--text-rack-dim)] focus:outline-none focus:border-[var(--amber)]"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                {editAgent && (
                  <button
                    onClick={handleAgentDelete}
                    className="px-3 py-1 text-sm text-[var(--error-rack)] hover:opacity-80 transition-opacity"
                  >
                    {t('sidebar.agentDelete')}
                  </button>
                )}
                <button
                  onClick={() => setShowAgentDialog(false)}
                  className="px-3 py-1 text-sm text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] transition-colors"
                >
                  {t('sidebar.agentCancel')}
                </button>
                <button
                  onClick={handleAgentSave}
                  className="px-3 py-1 text-sm bg-[var(--amber)] text-[var(--bg-base)] rounded hover:opacity-90 transition-opacity font-medium"
                >
                  {t('sidebar.agentSave')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default Sidebar
