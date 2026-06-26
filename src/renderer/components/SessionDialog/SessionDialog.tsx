import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { SessionConfig, SerialPortInfo } from '@shared/types'
import { ConnectionType } from '@shared/types'
import { DEFAULT_THEME_DARK } from '@shared/constants'

interface SessionDialogProps {
  open: boolean
  onClose: () => void
  /**
   * 提交回调。
   *   - 编辑模式：返回值忽略。成功即关闭;抛错则进入 fault 态显示 err.message,用户可改参数 Retry(与新建模式一致)。
   *   - 新建模式：
   *       返回 string —— 调用方触发连接,session id 已落盘;dialog 立即关闭(不等连接事件)。
   *       返回 null   —— 调用方只创建不连接,dialog 立即关闭。
   *       返回 undefined —— 兜底,等同于 string(dialog 立即关闭,沿用 config.id)。
   *       抛错        —— dialog 进入 'fault' 状态,显示 err.message,用户可改参数 Retry。
   *
   * 连接 connecting / connected / error 反馈由终端面板自己显示(状态条 + 输出区),
   * 不再阻塞 dialog —— 避免串口/local 这种瞬时连接抢跑 React commit 导致 dialog 卡死。
   */
  onSubmit: (config: SessionConfig) => Promise<string | null | undefined> | string | null | undefined | void
  initialConfig?: SessionConfig
}

const PROTO_ACCENT: Record<ConnectionType, string> = {
  [ConnectionType.SSH]: 'var(--proto-ssh)',
  [ConnectionType.TELNET]: 'var(--proto-tel)',
  [ConnectionType.SERIAL]: 'var(--proto-ser)',
  [ConnectionType.LOCAL]: 'var(--proto-loc)'
}

const PROTO_LABEL: Record<ConnectionType, string> = {
  [ConnectionType.SSH]: 'SSH',
  [ConnectionType.TELNET]: 'TEL',
  [ConnectionType.SERIAL]: 'SER',
  [ConnectionType.LOCAL]: 'LOC'
}

const BAUD_PRESETS = ['9600', '19200', '38400', '57600', '115200', '230400']

const SessionDialog: React.FC<SessionDialogProps> = ({
  open,
  onClose,
  onSubmit,
  initialConfig
}) => {
  // ─── 基础字段 ─────────────────────────────────────────
  const [name, setName] = useState('')
  const [type, setType] = useState<ConnectionType>(ConnectionType.SSH)
  // 标签由收藏/置顶按钮和 MCP 管理，对话框不再暴露编辑入口；编辑模式下原样保留
  const [tags, setTags] = useState<string[]>([])

  // ─── 协议字段 ─────────────────────────────────────────
  const [sshHost, setSshHost] = useState('')
  const [sshPort, setSshPort] = useState('22')
  const [sshUser, setSshUser] = useState('')
  const [sshPassword, setSshPassword] = useState('')
  const [sshPrivateKey, setSshPrivateKey] = useState('')

  const [telnetHost, setTelnetHost] = useState('')
  const [telnetPort, setTelnetPort] = useState('23')

  const [serialPath, setSerialPath] = useState('')
  const [serialBaudRate, setSerialBaudRate] = useState('9600')

  const [localShell, setLocalShell] = useState('')
  const [isCustomShell, setIsCustomShell] = useState(false)
  const [localCwd, setLocalCwd] = useState('')

  const [encoding, setEncoding] = useState<'utf-8' | 'gbk' | 'gb2312'>('utf-8')

  // ─── 宏面板 ──────────────────────────────────────────
  const [macroTab, setMacroTab] = useState<'shell' | 'startup'>('startup')
  const [shellEnterLines, setShellEnterLines] = useState<string[]>([])
  const [sshShellEnterWait, setSshShellEnterWait] = useState('1000')
  const [startupLines, setStartupLines] = useState<string[]>([])

  // ─── 串口扫描 ─────────────────────────────────────────
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([])
  const [serialScanning, setSerialScanning] = useState(false)

  // ─── 遥测状态 ─────────────────────────────────────────
  // 错误就 string,否则 null —— 原 linkState 二态('ready' | 'fault')收进 faultMsg 单字段(null = ready)
  const [faultMsg, setFaultMsg] = useState<string | null>(null)
  // 防止 await onSubmit 期间用户连按 Enter 触发重复提交
  const submittingRef = useRef(false)
  // onClose 用 ref 包一层,避免父组件每次 render 传入新引用导致依赖该 ref 的回调重订阅
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  const accent = PROTO_ACCENT[type]
  const isEdit = !!initialConfig

  // ─── 地址分类与 IP 自动填充 ────────────────────────────
  type AddrKind = 'ipv4' | 'ipv6' | 'hostname' | 'unknown'

  const classifyAddress = (text: string): AddrKind => {
    const t = text.trim()
    if (!t) return 'unknown'
    // IPv4: 数字.数字.数字.数字
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return 'ipv4'
    // IPv4 输入中（含末尾点 / 不足 4 段，但每段都是数字）
    if (/^\d{1,3}(\.\d{1,3}){0,3}\.?$/.test(t)) return 'ipv4'
    // IPv6: 至少含一个 ':'，且只含 hex / ':' / '%' (zone-id) / '.' (v4-mapped)
    if (/:/.test(t) && /^[0-9a-fA-F:%.]+$/.test(t)) return 'ipv6'
    // hostname: 至少含一个字母 / 横杠 / 点，不含非法字符
    if (/^[a-zA-Z0-9.\-_]+$/.test(t) && /[a-zA-Z-]/.test(t)) return 'hostname'
    return 'unknown'
  }

  // 从粘贴的字符串里提取 host + port
  // 接受: 192.168.1.1 / 192.168.1.1:22 / [2001:db8::1]:22 / 2001:db8::1 / host.example.com:2222
  const parseHostPort = (text: string): { host: string; port?: string } => {
    const t = text.trim()
    // [v6]:port
    const v6Bracket = t.match(/^\[([0-9a-fA-F:%.]+)\](?::(\d+))?$/)
    if (v6Bracket) return { host: v6Bracket[1], port: v6Bracket[2] }
    // v6 without brackets — 不解析尾部端口（歧义太大），整段作为 host
    if (/^[0-9a-fA-F]{0,4}:[0-9a-fA-F:%.]+$/.test(t) && (t.match(/:/g) || []).length >= 2) {
      return { host: t }
    }
    // v4 / hostname with optional :port
    const m = t.match(/^([^:]+)(?::(\d+))?$/)
    if (m) return { host: m[1], port: m[2] }
    return { host: t }
  }

  const handleNameChange = (value: string) => {
    setName(value)
    if (initialConfig) return  // 编辑模式不自动填充

    const trimmed = value.trim()
    if (!trimmed) return
    const kind = classifyAddress(trimmed)
    // 只对看起来像地址的自动填充（hostname/ipv4/ipv6）
    if (kind === 'unknown') return

    const { host, port } = parseHostPort(trimmed)
    if (!host) return

    if (type === ConnectionType.SSH) {
      setSshHost(host)
      if (port) setSshPort(port)
    } else if (type === ConnectionType.TELNET) {
      setTelnetHost(host)
      if (port) setTelnetPort(port)
    }
  }

  // ─── 初始化 / 重置 ────────────────────────────────────
  useEffect(() => {
    if (!open) return
    if (initialConfig) {
      setName(initialConfig.name || '')
      setType(initialConfig.type || ConnectionType.SSH)
      setTags(initialConfig.tags || [])
      setStartupLines(initialConfig.startupCommands || [])
      setSshHost(initialConfig.ssh?.host || '')
      setSshPort(initialConfig.ssh?.port?.toString() || '22')
      setSshUser(initialConfig.ssh?.username || '')
      setSshPassword(initialConfig.ssh?.password || '')
      setSshPrivateKey(initialConfig.ssh?.privateKey || '')
      setShellEnterLines(
        (initialConfig.ssh?.shellEnterCommands || '').split('\n').filter(Boolean)
      )
      setSshShellEnterWait(initialConfig.ssh?.shellEnterWait?.toString() || '1000')
      setTelnetHost(initialConfig.telnet?.host || '')
      setTelnetPort(initialConfig.telnet?.port?.toString() || '23')
      setSerialPath(initialConfig.serial?.path || '')
      setSerialBaudRate(initialConfig.serial?.baudRate?.toString() || '9600')
      const shell = initialConfig.local?.shell || ''
      setLocalShell(shell)
      setIsCustomShell(!!shell && shell !== 'powershell' && shell !== 'pwsh')
      setLocalCwd(initialConfig.local?.cwd || '')
      setEncoding(initialConfig.terminal?.encoding || 'utf-8')
    } else {
      setName('')
      setType(ConnectionType.SSH)
      setTags([])
      setStartupLines([])
      setSshHost('')
      setSshPort('22')
      setSshUser('')
      setSshPassword('')
      setSshPrivateKey('')
      setShellEnterLines([])
      setSshShellEnterWait('1000')
      setTelnetHost('')
      setTelnetPort('23')
      setSerialPath('')
      setSerialBaudRate('9600')
      setLocalShell('')
      setIsCustomShell(false)
      setLocalCwd('')
      setEncoding('utf-8')
    }
    setFaultMsg(null)
    submittingRef.current = false
    setMacroTab('startup')
  }, [initialConfig, open])

  // ─── 串口扫描 ─────────────────────────────────────────
  const scanSerialPorts = useCallback(async () => {
    if (!window.electronAPI) return
    setSerialScanning(true)
    try {
      const ports = await window.electronAPI.listSerialPorts()
      setSerialPorts(Array.isArray(ports) ? ports : [])
    } catch {
      setSerialPorts([])
    } finally {
      setSerialScanning(false)
    }
  }, [])

  useEffect(() => {
    if (!open || type !== ConnectionType.SERIAL) return
    scanSerialPorts()
  }, [open, type, scanSerialPorts])

  // ─── ESC 关闭 ─────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleCancel = () => {
    // 提交后 dialog 立即关闭,无 linking 中间态需要回滚 —— 直接关掉即可。
    onCloseRef.current()
  }

  if (!open) return null

  // ─── 提交 ────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submittingRef.current) return  // 防止 await 期间 Enter 重复提交

    // 派生 session 名称
    let sessionName = name.trim()
    if (!sessionName) {
      if (type === ConnectionType.SSH) sessionName = sshHost.trim()
      else if (type === ConnectionType.TELNET) sessionName = telnetHost.trim()
      else if (type === ConnectionType.SERIAL) sessionName = serialPath
      else if (type === ConnectionType.LOCAL) sessionName = 'Local Terminal'
    }

    const config: SessionConfig = {
      id: initialConfig?.id || Date.now().toString(),
      name: sessionName,
      type,
      tags,
      startupCommands: startupLines.filter(Boolean),
      terminal: {
        ...initialConfig?.terminal || {
          fontSize: 14,
          fontFamily: 'Consolas, Monaco, monospace',
          theme: DEFAULT_THEME_DARK,
          cursorStyle: 'block',
          cursorBlink: true,
          scrollback: 10000
        },
        encoding: encoding
      },
      createdAt: initialConfig?.createdAt || new Date(),
      updatedAt: new Date()
    }

    if (type === ConnectionType.SSH) {
      config.ssh = {
        host: sshHost.trim(),
        port: parseInt(sshPort) || 22,
        username: sshUser,
        password: sshPassword || undefined,
        privateKey: sshPrivateKey || undefined,
        shellEnterCommands: shellEnterLines.filter(Boolean).join('\n') || undefined,
        shellEnterWait: parseInt(sshShellEnterWait) || undefined
      }
    } else if (type === ConnectionType.TELNET) {
      config.telnet = {
        host: telnetHost.trim(),
        port: parseInt(telnetPort) || 23
      }
    } else if (type === ConnectionType.SERIAL) {
      config.serial = {
        path: serialPath,
        baudRate: parseInt(serialBaudRate) || 9600,
        dataBits: 8,
        stopBits: 1,
        parity: 'none'
      }
    } else if (type === ConnectionType.LOCAL) {
      config.local = {
        shell: localShell || undefined,
        cwd: localCwd || undefined
      }
    }

    // 编辑模式：成功即关闭;抛错则留 dialog 显示 err.message 让用户改参数 Retry —— 与新建模式失败 UX 统一
    if (isEdit) {
      setFaultMsg(null)
      try {
        await onSubmit(config)
        onCloseRef.current()
      } catch (err) {
        setFaultMsg((err as Error)?.message || 'Failed to save session')
      }
      return
    }

    // 新建模式：提交即关闭,不再等连接事件。
    // 连接状态(connecting / connected / error)由终端面板自己反馈 —— 状态条 / 输出区
    // 比 dialog 内的 "Connecting" 更准确,也避免串口这种瞬时连接抢跑 React commit 导致卡死
    submittingRef.current = true
    setFaultMsg(null)
    try {
      const id = await onSubmit(config)
      if (id === null) {
        // 调用方约定：只创建不连接 —— 直接关闭
        onCloseRef.current()
        return
      }
      // 提交成功 —— createdIdRef 不再需要(dialog 立即关闭,无 cancel 中断机会)
      onCloseRef.current()
    } catch (err) {
      setFaultMsg((err as Error)?.message || 'Failed to create session')
    } finally {
      submittingRef.current = false
    }
  }

  // ─── 渲染辅助 ─────────────────────────────────────────
  const renderHostRow = (
    host: string,
    setHost: (v: string) => void,
    port: string,
    setPort: (v: string) => void,
    placeholder: string
  ) => {
    const kind = classifyAddress(host)
    const chipLabel: Record<AddrKind, string> = {
      ipv4: 'IPv4',
      ipv6: 'IPv6',
      hostname: 'Host',
      unknown: ''
    }
    // 用户粘贴 "host:port" 时自动拆分到端口字段
    const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
      const text = e.clipboardData.getData('text').trim()
      if (!text) return
      const { host: pastedHost, port: pastedPort } = parseHostPort(text)
      if (pastedPort) {
        e.preventDefault()
        setHost(pastedHost)
        setPort(pastedPort)
      }
    }
    return (
      <div className="flex items-end">
        {/* 主机标签 */}
        <span
          className="text-[13px] text-[var(--text-rack)] font-medium flex-shrink-0 pb-1.5 w-[44px] mr-2"
          style={{ fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' }}
        >
          Host
        </span>
        {/* 主输入框 */}
        <div className="flex-1 min-w-0 relative mr-4">
          <input
            value={host}
            onChange={e => setHost(e.target.value)}
            onPaste={handlePaste}
            placeholder={placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="lyshell-host-input w-full bg-transparent border-b text-[18px] font-medium text-[var(--text-rack)] focus:outline-none pb-1.5 pr-16"
            style={{
              fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace',
              borderBottomColor: host ? accent : 'var(--rule)',
              caretColor: accent,
              transition: 'border-bottom-color .15s'
            }}
            onFocus={e => { e.currentTarget.style.borderBottomColor = accent }}
            onBlur={e => { e.currentTarget.style.borderBottomColor = host ? accent : 'var(--rule)' }}
          />
          {kind !== 'unknown' && (
            <span
              className="absolute right-0 bottom-2 text-[11px] tracking-[0.06em] px-1.5 py-px rounded-sm border pointer-events-none select-none"
              style={{
                fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
                color: accent,
                borderColor: `color-mix(in srgb, ${accent} 33%, transparent)`,
                background: `color-mix(in srgb, ${accent} 6%, transparent)`
              }}
            >
              {chipLabel[kind]}
            </span>
          )}
        </div>
        {/* 端口 */}
        <div className="flex items-baseline flex-shrink-0">
          <span
            className="text-[13px] text-[var(--text-rack)] font-medium mr-2"
            style={{ fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' }}
          >
            Port
          </span>
          <input
            value={port}
            onChange={e => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
            onFocus={e => { e.target.select(); e.currentTarget.style.borderBottomColor = accent }}
            onBlur={e => { e.currentTarget.style.borderBottomColor = port ? accent : 'var(--rule)' }}
            inputMode="numeric"
            className="w-[52px] bg-transparent border-b text-[18px] font-medium text-[var(--text-rack)] focus:outline-none pb-1.5 tabular-nums text-right"
            style={{
              fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace',
              borderBottomColor: port ? accent : 'var(--rule)',
              caretColor: accent,
              transition: 'border-bottom-color .15s'
            }}
          />
        </div>
      </div>
    )
  }

  const renderMacroPanel = () => {
    const lines = macroTab === 'shell' ? shellEnterLines : startupLines
    const setLines = macroTab === 'shell' ? setShellEnterLines : setStartupLines
    const showShellTab = type === ConnectionType.SSH

    return (
      <>
        {/* tab bar */}
        <div className="flex items-center border-b border-[var(--rule-soft)] mb-2 -mb-px">
          {showShellTab && (
            <button
              type="button"
              onClick={() => setMacroTab('shell')}
              className="text-[13px] py-2 px-3 border-b cursor-pointer flex items-center gap-2"
              style={{
                color: macroTab === 'shell' ? accent : 'var(--text-rack-data)',
                borderBottomColor: macroTab === 'shell' ? accent : 'transparent',
                marginBottom: -1,
                fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
              }}
            >
              Shell Init
              <span
                className="text-[11px] px-1.5 py-px rounded-sm bg-[var(--bg-base)] border border-[var(--rule)] font-mono tabular-nums"
                style={{ color: macroTab === 'shell' ? accent : 'var(--text-rack-mute)', opacity: macroTab === 'shell' ? 0.7 : 1 }}
              >
                {shellEnterLines.filter(Boolean).length}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setMacroTab('startup')}
            className="text-[13px] py-2 px-3 border-b cursor-pointer flex items-center gap-2"
            style={{
              color: macroTab === 'startup' ? accent : 'var(--text-rack-data)',
              borderBottomColor: macroTab === 'startup' ? accent : 'transparent',
              marginBottom: -1,
              fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
            }}
          >
            Startup
            <span
              className="text-[11px] px-1.5 py-px rounded-sm bg-[var(--bg-base)] border border-[var(--rule)] font-mono tabular-nums"
              style={{ color: macroTab === 'startup' ? accent : 'var(--text-rack-mute)', opacity: macroTab === 'startup' ? 0.7 : 1 }}
            >
              {startupLines.filter(Boolean).length}
            </span>
          </button>
          {!showShellTab && (
            <span
              className="text-[13px] py-2 px-3 opacity-30 cursor-not-allowed flex items-center gap-2"
              style={{
                color: 'var(--text-rack-mute)',
                fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
              }}
              title="Shell Init is only available for SSH"
            >
              Shell Init
              <span className="text-[11px] px-1.5 py-px rounded-sm bg-[var(--bg-base)] border border-[var(--rule)] font-mono">SSH only</span>
            </span>
          )}
          {macroTab === 'shell' && (
            <div className="ml-auto flex items-baseline gap-1.5 pr-1">
              <span
                className="text-[12px] text-[var(--text-rack-mute)]"
                style={{ fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' }}
              >
                Wait
              </span>
              <input
                value={sshShellEnterWait}
                onChange={e => setSshShellEnterWait(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className="w-[52px] bg-transparent border-none text-right text-[var(--text-rack)] font-medium focus:outline-none tabular-nums font-mono text-[13px]"
                style={{ caretColor: accent }}
              />
              <span className="text-[11px] text-[var(--text-rack-mute)] font-mono">ms</span>
            </div>
          )}
        </div>

        {/* line editor — 单个 textarea，跨行选择/复制/删除像普通编辑器 */}
        <div className="bg-[var(--bg-base)] border border-[var(--rule)] rounded-sm relative overflow-hidden">
          {(() => {
            const text = lines.join('\n')
            const rowCount = Math.max(text.split('\n').length, 3)
            const placeholder = macroTab === 'shell'
              ? 'One command per line · Enter for newline · paste multi-line'
              : 'One command per line · Enter for newline · paste multi-line'
            return (
              <div className="flex">
                {/* 行号槽（不响应交互，跟随 textarea 滚动） */}
                <div
                  className="select-none pt-1.5 pb-1.5 pl-2.5 pr-2 text-right text-[11px] text-[var(--text-rack-dim)] font-mono tabular-nums leading-[22px] bg-[var(--bg-strip)] border-r border-[var(--rule-soft)]"
                  style={{ minWidth: 32 }}
                  aria-hidden
                >
                  {Array.from({ length: rowCount }, (_, i) => (
                    <div key={i}>{i + 1}</div>
                  ))}
                </div>
                <textarea
                  value={text}
                  onChange={e => {
                    // 用户主动按 Enter / 粘贴 都通过这一条路径
                    setLines(e.target.value.split('\n'))
                  }}
                  onPaste={e => {
                    // 粘贴正常走 onChange，无需特殊处理；保留 hook 留作以后扩展
                    void e
                  }}
                  placeholder={placeholder}
                  spellCheck={false}
                  rows={Math.min(rowCount, 8)}
                  className="lyshell-macro-area flex-1 min-w-0 bg-transparent border-none text-[var(--text-rack)] focus:outline-none resize-none py-1.5 px-3 text-[13px] leading-[22px]"
                  style={{
                    caretColor: accent,
                    fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", monospace'
                  }}
                />
              </div>
            )
          })()}
        </div>
      </>
    )
  }

  // ─── 串口扫描面板 ─────────────────────────────────────
  const renderSerialScanner = () => {
    const matched = serialPath && serialPorts.some(p => p.path === serialPath)
    const ghost = !matched && serialPath ? { path: serialPath } as SerialPortInfo : null

    return (
      <div className="border border-[var(--rule)] bg-[var(--bg-base)] rounded-sm overflow-hidden">
        <div
          className="flex items-center h-[30px] px-3 pl-3 border-b border-[var(--rule-soft)] bg-[var(--bg-rack)] text-[12px] text-[var(--text-rack-data)]"
          style={{ fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' }}
        >
          <span>
            Detected{' '}
            <span style={{ color: accent }} className="font-medium ml-0.5 font-mono tabular-nums">{serialPorts.length}</span>
          </span>
          <button
            type="button"
            onClick={scanSerialPorts}
            disabled={serialScanning}
            className="ml-auto text-[var(--text-rack-data)] hover:text-[var(--text-rack)] cursor-pointer flex items-center gap-1.5 text-[12px] px-2 py-1 disabled:opacity-40"
          >
            <span className={serialScanning ? 'animate-spin inline-block' : ''}>↻</span>
            {serialScanning ? 'Scanning' : 'Rescan'}
          </button>
        </div>
        <div className="max-h-[168px] overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
          {serialPorts.length === 0 && !ghost && !serialScanning && (
            <div
              className="px-3 py-3.5 text-[12.5px] text-[var(--text-rack-mute)] text-center"
              style={{ fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' }}
            >
              No serial ports detected · type a path below to enter manually
            </div>
          )}
          {serialPorts.map(p => {
            const isOn = serialPath === p.path
            const label = p.friendlyName || p.manufacturer || '—'
            const vidPid = p.vendorId && p.productId ? `${p.vendorId}:${p.productId}` : ''
            return (
              <div
                key={p.path}
                onClick={() => setSerialPath(p.path)}
                className="grid items-center gap-3 px-3 pl-3 py-2 cursor-pointer border-b border-[var(--rule-soft)] hover:bg-white/[0.025] relative font-mono"
                style={{
                  gridTemplateColumns: '16px 76px 1fr auto',
                  background: isOn ? 'color-mix(in srgb, var(--proto-ser) 8%, transparent)' : undefined
                }}
              >
                {isOn && (
                  <span
                    className="absolute left-0 top-0 bottom-0 w-[2px]"
                    style={{ background: accent }}
                  />
                )}
                <span
                  className="w-2 h-2 rounded-full justify-self-center"
                  style={{
                    background: isOn ? accent : 'var(--live)',
                    boxShadow: `0 0 5px ${isOn ? accent : 'var(--live)'}`
                  }}
                />
                <span
                  className="text-[13px] font-medium tracking-[0.04em]"
                  style={{ color: isOn ? accent : 'var(--text-rack)' }}
                >
                  {p.path}
                </span>
                <span className="text-[12px] text-[var(--text-rack-data)] truncate" style={{ fontFamily: 'system-ui, sans-serif' }}>
                  {label}
                </span>
                {vidPid && (
                  <span className="text-[10.5px] tracking-[0.06em] text-[var(--text-rack-mute)] justify-self-end">
                    {vidPid}
                  </span>
                )}
              </div>
            )
          })}
          {ghost && (
            <div
              onClick={() => setSerialPath(ghost.path)}
              className="grid items-center gap-3 px-3 pl-3 py-2 cursor-pointer border-b border-[var(--rule-soft)] hover:bg-white/[0.025] relative font-mono opacity-55"
              style={{
                gridTemplateColumns: '16px 76px 1fr auto',
                background: 'color-mix(in srgb, var(--proto-ser) 8%, transparent)'
              }}
            >
              <span
                className="absolute left-0 top-0 bottom-0 w-[2px]"
                style={{ background: accent }}
              />
              <span
                className="w-2 h-2 rounded-full justify-self-center border border-[var(--text-rack-faint)]"
              />
              <span className="text-[13px] font-medium tracking-[0.04em]" style={{ color: accent }}>{ghost.path}</span>
              <span className="text-[12px] text-[var(--text-rack-data)] truncate" style={{ fontFamily: 'system-ui, sans-serif' }}>
                <span style={{ color: 'var(--text-rack-mute)', fontSize: 12, fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' }}>Offline</span>
              </span>
              <span />
            </div>
          )}
          {/* manual entry row */}
          <div
            className="grid items-center gap-3 px-3 pl-3 py-2 font-mono"
            style={{ gridTemplateColumns: '16px 1fr' }}
          >
            <span
              className="w-2 h-2 rounded-full justify-self-center border border-dashed border-[var(--text-rack-faint)]"
            />
            <input
              value={serialPorts.some(p => p.path === serialPath) ? '' : (ghost ? '' : serialPath)}
              onChange={e => setSerialPath(e.target.value)}
              placeholder="Or type: COM5 / /dev/ttyUSB0"
              className="bg-transparent border-b text-[13px] py-1 text-[var(--text-rack)] focus:outline-none"
              style={{ borderBottomColor: accent, caretColor: accent }}
            />
          </div>
        </div>
      </div>
    )
  }

  // ─── 主渲染 ──────────────────────────────────────────
  const channelLabel = isEdit ? 'Edit Session' : 'New Session'
  const buttonLabel =
    faultMsg ? 'Retry' :
    isEdit ? 'Save' :
    'Connect'

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onMouseDown={e => { if (e.target === e.currentTarget) handleCancel() }}
    >
      <div
        className="bg-[var(--bg-rack)] border border-[var(--rule)] w-[448px] overflow-hidden lyshell-session-dialog"
        style={{
          boxShadow: '0 0 0 1px rgba(0,0,0,.3), 0 24px 60px -12px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.02)'
        }}
      >
        {/* placeholder + selection 强制亮度（dialog 作用域，不污染全局） */}
        <style>{`
          .lyshell-session-dialog ::placeholder {
            color: var(--text-rack-dim) !important;
            opacity: 1;
          }
          .lyshell-session-dialog ::-webkit-input-placeholder { color: var(--text-rack-dim) !important; }
          .lyshell-session-dialog :-ms-input-placeholder { color: var(--text-rack-dim) !important; }
          /* 主机输入框：18px mono 太抢眼，placeholder 再压暗一档 + 字号缩小 */
          .lyshell-session-dialog .lyshell-host-input::placeholder {
            color: var(--text-rack-faint) !important;
            font-weight: 400;
            font-size: 13px;
            font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
          }
          .lyshell-session-dialog .lyshell-host-input::-webkit-input-placeholder {
            color: var(--text-rack-faint) !important;
            font-weight: 400;
            font-size: 13px;
            font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
          }
          /* 宏面板空态：placeholder 走 sans，input 自己仍是 mono 等输入命令 */
          .lyshell-session-dialog .lyshell-macro-empty::placeholder,
          .lyshell-session-dialog .lyshell-macro-area::placeholder {
            color: var(--text-rack-dim) !important;
            font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
            font-size: 12.5px;
          }
          .lyshell-session-dialog .lyshell-macro-empty::-webkit-input-placeholder,
          .lyshell-session-dialog .lyshell-macro-area::-webkit-input-placeholder {
            color: var(--text-rack-dim) !important;
            font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
            font-size: 12.5px;
          }
        `}</style>
        {/* TITLE STRIP */}
        <div
          className="flex items-center h-10 px-3 pl-4 border-b border-[var(--rule)] text-[13px] text-[var(--text-rack-data)] gap-3"
          style={{
            background: 'linear-gradient(180deg, var(--rule-soft) 0%, var(--bg-slot) 100%)',
            fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
          }}
        >
          <span className="text-[var(--text-rack)] font-medium flex-shrink-0 flex items-center">
            <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: accent, boxShadow: `0 0 5px ${accent}` }} />
            {channelLabel}
          </span>
          <span className="text-[var(--text-rack-faint)] flex-shrink-0">·</span>
          <input
            value={name}
            onChange={e => handleNameChange(e.target.value)}
            placeholder="Empty = use IP as session name"
            className="flex-1 min-w-0 bg-transparent border-none text-[var(--text-rack)] text-[13px] tracking-[0.02em] normal-case py-0 outline-none border-b border-dashed border-transparent hover:border-[var(--rule)] focus:border-[var(--rule)]"
            style={{
              textTransform: 'none',
              letterSpacing: '0.02em',
              fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
            }}
          />
          <button
            type="button"
            onClick={handleCancel}
            className="text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] text-lg tracking-normal px-2 py-0.5 flex-shrink-0 cursor-pointer"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          {/* PROTOCOL */}
          <div className="py-3.5 px-4 border-b border-[var(--rule)]">
            <div className="grid grid-cols-4 gap-2">
              {(Object.values(ConnectionType) as ConnectionType[]).map(p => {
                const isOn = type === p
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setType(p)}
                    className="h-10 rounded-sm flex items-center justify-center gap-2 cursor-pointer relative font-mono transition-transform"
                    style={{
                      background: isOn ? 'var(--bg-slot)' : 'var(--rule)',
                      borderTop: `1px solid ${isOn ? 'var(--rule)' : 'var(--rule)'}`,
                      borderRight: '1px solid var(--rule)',
                      borderBottom: '1px solid var(--rule)',
                      borderLeft: '1px solid var(--rule)',
                      boxShadow: isOn
                        ? 'inset 0 1px 6px rgba(0,0,0,.6)'
                        : '0 2px 0 #0B0B0D, inset 0 1px 0 rgba(255,255,255,.04)',
                      transform: isOn ? 'translateY(1px)' : 'none'
                    }}
                  >
                    {isOn && (
                      <span
                        className="absolute left-2 right-2 -top-px h-0.5"
                        style={{ background: PROTO_ACCENT[p], boxShadow: `0 0 8px ${PROTO_ACCENT[p]}` }}
                      />
                    )}
                    <span
                      className="text-[14px] font-medium tracking-[0.1em]"
                      style={{ color: isOn ? PROTO_ACCENT[p] : 'var(--text-rack-data)' }}
                    >
                      {PROTO_LABEL[p]}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* TARGET / PORT */}
          {(type === ConnectionType.SSH || type === ConnectionType.TELNET) && (
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              {type === ConnectionType.SSH
                ? renderHostRow(sshHost, setSshHost, sshPort, setSshPort, 'IP or hostname')
                : renderHostRow(telnetHost, setTelnetHost, telnetPort, setTelnetPort, 'IP or hostname')}
            </div>
          )}

          {type === ConnectionType.SERIAL && (
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              {renderSerialScanner()}
              <div className="flex items-center mt-3 pt-2.5 border-t border-[var(--rule-soft)]">
                <span
                  className="text-[13px] text-[var(--text-rack)] font-medium w-[44px] mr-2 flex-shrink-0"
                  style={{ fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' }}
                >
                  Baud
                </span>
                <div className="flex gap-1.5 flex-wrap flex-1">
                  {BAUD_PRESETS.map(b => {
                    const isOn = serialBaudRate === b
                    return (
                      <button
                        key={b}
                        type="button"
                        onClick={() => setSerialBaudRate(b)}
                        className="font-mono text-[12px] px-2.5 py-1 border rounded-sm cursor-pointer tracking-[0.04em]"
                        style={{
                          color: isOn ? accent : 'var(--text-rack-data)',
                          borderColor: isOn ? accent : 'var(--rule)',
                          background: isOn ? 'color-mix(in srgb, var(--proto-ser) 6%, transparent)' : 'var(--bg-base)'
                        }}
                      >
                        {b}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {type === ConnectionType.LOCAL && (
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-center">
                <span
                  className="text-[13px] text-[var(--text-rack)] font-medium w-[44px] mr-2 flex-shrink-0"
                  style={{ fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' }}
                >
                  Shell
                </span>
                <select
                  value={isCustomShell ? 'custom' : localShell}
                  onChange={e => {
                    const val = e.target.value
                    if (val === '') { setLocalShell(''); setIsCustomShell(false) }
                    else if (val === 'powershell') { setLocalShell('powershell'); setIsCustomShell(false) }
                    else if (val === 'pwsh') { setLocalShell('pwsh'); setIsCustomShell(false) }
                    else { setIsCustomShell(true); setLocalShell('') }
                  }}
                  className="bg-[var(--bg-base)] border border-[var(--rule)] text-[var(--text-rack)] text-[13px] py-1.5 px-2.5 rounded-sm focus:outline-none focus:border-[var(--text-rack-dim)]"
                  style={{ fontFamily: 'ui-monospace, "JetBrains Mono", monospace' }}
                >
                  <option value="">cmd.exe (default)</option>
                  <option value="powershell">PowerShell</option>
                  <option value="pwsh">PowerShell 7</option>
                  <option value="custom">Custom…</option>
                </select>
                {isCustomShell && (
                  <input
                    value={localShell}
                    onChange={e => setLocalShell(e.target.value)}
                    placeholder="C:\path\to\shell.exe"
                    className="flex-1 bg-transparent border-b border-[var(--rule)] text-[13px] py-1 text-[var(--text-rack)] focus:outline-none font-mono ml-2"
                    style={{ caretColor: accent }}
                  />
                )}
              </div>
              <div className="flex items-center mt-2.5">
                <span
                  className="text-[13px] text-[var(--text-rack)] font-medium w-[44px] mr-2 flex-shrink-0"
                  style={{ fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' }}
                >
                  Cwd
                </span>
                <input
                  value={localCwd}
                  onChange={e => setLocalCwd(e.target.value)}
                  placeholder="Empty = home directory"
                  className="flex-1 bg-transparent border-b border-[var(--rule)] text-[13px] py-1 text-[var(--text-rack)] focus:outline-none font-mono"
                  style={{ caretColor: accent }}
                />
              </div>
            </div>
          )}

          {/* AUTH (SSH only) */}
          {type === ConnectionType.SSH && (
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <FieldRow label="User">
                <input
                  value={sshUser}
                  onChange={e => setSshUser(e.target.value)}
                  placeholder="root"
                  className="flex-1 bg-transparent border-b text-[14px] text-[var(--text-rack)] focus:outline-none focus:text-white font-mono pb-1.5"
                  style={{
                    borderBottomColor: sshUser ? accent : 'var(--rule)',
                    caretColor: accent,
                    transition: 'border-bottom-color .15s'
                  }}
                  onFocus={e => { e.currentTarget.style.borderBottomColor = accent }}
                  onBlur={e => { e.currentTarget.style.borderBottomColor = sshUser ? accent : 'var(--rule)' }}
                  required
                />
              </FieldRow>
              <FieldRow label="Auth">
                <input
                  type="password"
                  value={sshPassword}
                  onChange={e => setSshPassword(e.target.value)}
                  placeholder="Password"
                  className="flex-1 bg-transparent border-b text-[14px] text-[var(--text-rack)] focus:outline-none focus:text-white font-mono pb-1.5"
                  style={{
                    borderBottomColor: sshPassword ? accent : 'var(--rule)',
                    caretColor: accent,
                    transition: 'border-bottom-color .15s'
                  }}
                  onFocus={e => { e.currentTarget.style.borderBottomColor = accent }}
                  onBlur={e => { e.currentTarget.style.borderBottomColor = sshPassword ? accent : 'var(--rule)' }}
                />
                <span
                  className="text-[12px] text-[var(--text-rack-mute)] mx-3 self-center"
                  style={{ fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' }}
                >
                  or
                </span>
                <input
                  value={sshPrivateKey}
                  onChange={e => setSshPrivateKey(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                  className="flex-1 bg-transparent border-b text-[13px] text-[var(--text-rack)] focus:outline-none font-mono pb-1.5"
                  style={{
                    borderBottomColor: sshPrivateKey ? accent : 'var(--rule)',
                    caretColor: accent,
                    transition: 'border-bottom-color .15s'
                  }}
                  onFocus={e => { e.currentTarget.style.borderBottomColor = accent }}
                  onBlur={e => { e.currentTarget.style.borderBottomColor = sshPrivateKey ? accent : 'var(--rule)' }}
                />
              </FieldRow>
            </div>
          )}

          {/* MACROS */}
          <div className="py-3.5 px-4 border-b border-[var(--rule)]">
            {renderMacroPanel()}
          </div>

          {/* META */}
          <div className="py-3.5 px-4">
            <FieldRow label="Charset" bare labelWidth="w-[56px]">
              <div className="flex gap-1 flex-1">
                {(['utf-8', 'gbk', 'gb2312'] as const).map(enc => {
                  const isOn = encoding === enc
                  return (
                    <button
                      key={enc}
                      type="button"
                      onClick={() => setEncoding(enc)}
                      className="font-mono text-[12px] px-2.5 py-1 border rounded-sm cursor-pointer tracking-[0.04em]"
                      style={{
                        color: isOn ? accent : 'var(--text-rack-data)',
                        borderColor: isOn ? accent : 'var(--rule)',
                        background: isOn ? `color-mix(in srgb, ${accent} 6%, transparent)` : 'var(--bg-base)'
                      }}
                    >
                      {enc}
                    </button>
                  )
                })}
              </div>
            </FieldRow>
          </div>

          {/* TELEMETRY STRIP */}
          <TelemetryStrip
            faultMsg={faultMsg}
            isEdit={isEdit}
            accent={accent}
            buttonLabel={buttonLabel}
          />
        </form>
      </div>
    </div>
  )
}

// ─── 小工具组件 ─────────────────────────────────────────

const FieldRow: React.FC<{ label: string; bare?: boolean; labelWidth?: string; children: React.ReactNode }> = ({
  label, bare, labelWidth = 'w-[44px]', children
}) => (
  <div className={`flex ${bare ? 'items-center py-2' : 'items-stretch py-2.5'}`}>
    <span
      className={`text-[13px] font-medium text-[var(--text-rack)] ${labelWidth} mr-2 flex-shrink-0 self-center`}
      style={{ fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' }}
    >
      {label}
    </span>
    {children}
  </div>
)

const TelemetryStrip: React.FC<{
  faultMsg: string | null
  isEdit: boolean
  accent: string
  buttonLabel: string
}> = ({ faultMsg, isEdit, accent, buttonLabel }) => {
  const isFault = !!faultMsg
  const stateColor =
    isFault ? 'var(--error-rack)' :
    'var(--text-rack-dim)'
  const stateMsg =
    isFault ? (faultMsg || 'Connection failed') :
    isEdit ? 'Edit mode · save will not reconnect' : 'Ready'

  return (
    <div
      className="flex items-stretch h-[44px] border-t border-[var(--rule)]"
      style={{ background: 'linear-gradient(180deg, var(--bg-rack) 0%, var(--bg-rack) 100%)' }}
    >
      <div
        className="flex-1 flex items-center px-4 gap-2.5 min-w-0 text-[13px]"
        style={{
          color: stateColor,
          fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
        }}
      >
        <span
          className="w-2 h-2 rounded-full border flex-shrink-0"
          style={{
            borderColor: stateColor,
            background: isFault ? stateColor : 'transparent',
            boxShadow: isFault ? `0 0 6px ${stateColor}` : 'none'
          }}
        />
        <span className="truncate">{stateMsg}</span>
      </div>
      <button
        type="submit"
        className="flex items-center gap-2 px-6 bg-transparent border-l border-[var(--rule)] text-[14px] font-medium cursor-pointer transition-colors"
        style={{
          color: isFault ? 'var(--error-rack)' : accent,
          fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLButtonElement).style.background = `color-mix(in srgb, ${accent} 8%, transparent)`
        }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
      >
        {buttonLabel}
        <span className="opacity-70 text-[13px] font-mono" style={{ letterSpacing: 0 }}>
          ↵
        </span>
      </button>
      <style>{`
        @keyframes lyshell-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        @media (prefers-reduced-motion: reduce) {
          [style*="lyshell-pulse"] { animation: none !important; }
        }
      `}</style>
    </div>
  )
}

export default SessionDialog
