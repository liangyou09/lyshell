/**
 * 终端文档链接 provider —— Ctrl+点击输出行内的 .md/.html/.txt 路径开文档页签。
 *
 * 坐标系（xterm 5.5 源码核实，Linkifier2/OscLinkProvider）：provideLinks 的
 * 行号与 ILink.range 的 y 均为 1-based 绝对缓冲行（buffer.lines.get(n-1)），
 * 非视口行；range 的 x 为 1-based 列。宽字符占 2 列但字符串里只占 1 字符，
 * 故逐格重建「字符串位置 → 列号」映射，避免含中文行上链接错位。
 *
 * 已知限制：
 * - 远端相对路径按 connector shell 的 cwd（filePwd 查一次按会话缓存），不是
 *   交互终端 cd 后的 cwd；绝对路径不受影响。彻底修复靠 OSC 7 shell 集成。
 * - 本地会话没有 pwd 通道，cwd 从 buffer 底部向上找最近一条 PS/cmd 提示符行
 *   （TUI 跑在备用屏幕时提示符在 normal buffer，两个都扫），最终回落到会话
 *   配置的启动 cwd；自定义提示符且无 cwd 配置时相对路径放弃。
 * - 分组列表（`prototypes/（2 个）` 组头 + `- a.html` 裸名条目、`design/（9 个）— …`
 *   组头 + 表格）里的裸文件名会向上（至多 40 行）找最近的目录头行拼上目录再
 *   归并；空行仅在上方首个非空行也是目录头时跨过（组头与表格间的排版空行）。
 * - telnet/serial 会话无文件读取通道，不响应。
 */
import type { Terminal, ILinkProvider, ILink, IBufferLine, IBuffer } from '@xterm/xterm'
import i18n from '../../i18n'
import { useSessionStore } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import { matchDocPaths, resolveDocPath, matchPromptCwd, localJoin, stripLeadingDash, matchDirHeader } from './docLink'
import { openLocalDoc, openRemoteDoc } from './readDoc'

/** 会话 → shell cwd 缓存（相对路径归并用；只在首次命中时查询一次） */
const cwdCache = new Map<string, string>()

async function getCwd(sessionId: string): Promise<string | undefined> {
  const cached = cwdCache.get(sessionId)
  if (cached !== undefined) return cached
  try {
    const res = await window.electronAPI?.filePwd(sessionId)
    if (res && res.success && typeof res.data === 'string' && res.data) {
      cwdCache.set(sessionId, res.data)
      return res.data
    }
  } catch { /* pwd 失败按无 cwd 处理：相对路径放弃 */ }
  return undefined
}

/** 逐格重建行文本与「字符串位置 → 0-based 列号」映射（宽字符只占 1 字符位） */
function buildLineIndex(line: IBufferLine): { text: string; cols: number[] } {
  let text = ''
  const cols: number[] = []
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x, undefined)
    if (!cell) break
    const s = cell.getChars()
    if (!s) continue // 宽字符尾格
    for (const ch of s) {
      cols.push(x)
      text += ch
    }
  }
  return { text, cols }
}

/** 悬浮提示（xterm link 无内建 tooltip，自建一枚复用的浮层） */
let tipEl: HTMLDivElement | null = null

function showTip(clientX: number, clientY: number): void {
  if (!tipEl) {
    tipEl = document.createElement('div')
    tipEl.className = 'doc-link-tip'
    document.body.appendChild(tipEl)
  }
  tipEl.textContent = i18n.t('doc.ctrlClickHint')
  tipEl.style.display = 'block'
  tipEl.style.left = `${Math.max(4, clientX - 10)}px`
  // 优先浮在指针上方；太靠顶就翻到下方
  tipEl.style.top = `${clientY > 40 ? clientY - 32 : clientY + 18}px`
}

function hideTip(): void {
  if (tipEl) tipEl.style.display = 'none'
}

/**
 * 本地会话 cwd 猜测：从 buffer 底部向上找最近一条 PS/cmd 提示符行。
 * - 不止看最后一条非空行 —— 终端里可能跑着 TUI/长输出，提示符（含启动
 *   命令的 `PS D:\docs> claude` 行）在更上面；
 * - TUI 走备用屏幕时 buffer.active 指向 alternate，提示符在 normal buffer，
 *   两个都扫；
 * - 都找不到回落到会话配置的启动 cwd（自定义提示符时至少覆盖未 cd 场景）。
 */
export function guessLocalCwd(terminal: Terminal, fallbackCwd?: string): string | null {
  const buffers: IBuffer[] = [terminal.buffer.active]
  if (terminal.buffer.normal !== terminal.buffer.active) buffers.push(terminal.buffer.normal)
  for (const buffer of buffers) {
    try {
      for (let y = buffer.length - 1; y >= 0 && y >= buffer.length - 2000; y--) {
        const line = buffer.getLine(y)
        if (!line) break
        const text = line.translateToString(true).trim()
        if (!text) continue
        const cwd = matchPromptCwd(text)
        if (cwd) return cwd
      }
    } catch { /* buffer 读取异常按无 cwd 处理 */ }
  }
  return fallbackCwd ?? null
}

/**
 * 裸文件名的分组目录上下文：分组列表（`prototypes/（2 个）` 组头 + 裸名
 * 条目、`design/（9 个）— …` 组头 + 表格）里，从点击行向上找最近的目录头。
 * 空行处理：组头与表格之间常隔空行，故遇空行时向上跳过连续空行看第一行
 * 非空内容 —— 是目录头就跨过去，不是就停（上面是别的组/别的输出，不借用）。
 * 找到返回带尾分隔符的目录，否则 null。
 */
export function findGroupDir(terminal: Terminal, clickedLineNumber: number): string | null {
  try {
    const buffer = terminal.buffer.active
    for (let ln = clickedLineNumber - 1; ln >= 1 && ln > clickedLineNumber - 1 - 40; ln--) {
      const line = buffer.getLine(ln - 1)
      if (!line) break
      const text = line.translateToString(true).trim()
      if (!text) {
        // 空行：仅当上方首个非空行是目录头时跨过（组头与表格间的排版空行），
        // 否则本组到头
        for (let up = ln - 1; up >= 1 && up > clickedLineNumber - 1 - 40; up--) {
          const l2 = buffer.getLine(up - 1)
          if (!l2) break
          const t2 = l2.translateToString(true).trim()
          if (!t2) continue
          return matchDirHeader(t2)
        }
        return null
      }
      const dir = matchDirHeader(text)
      if (dir) return dir
    }
  } catch { /* buffer 读取异常按无目录上下文处理 */ }
  return null
}

/** 激活（Ctrl+点击）：解析路径 → 按会话类型走远端/本地读取 → 开文档页签 */
async function activateLink(terminal: Terminal, sessionId: string, rawPath0: string, lineNo?: number): Promise<void> {
  const session = useSessionStore.getState().sessions.find(s => s.id === sessionId)
  const sessionType = session?.config.type
  if (sessionType !== 'ssh' && sessionType !== 'local') return

  // 弹点符号直接贴着路径（-.claude/x.md）时剥掉，不影响选中区间
  let rawPath = stripLeadingDash(rawPath0)

  // 裸文件名（不含分隔符）且知道点击行：向上找分组目录头（prototypes/（2 个））
  if (lineNo !== undefined && !/[\\/]/.test(rawPath)) {
    const dir = findGroupDir(terminal, lineNo)
    if (dir) rawPath = dir + rawPath
  }

  let finalPath: string | null
  if (sessionType === 'local') {
    if (/^[A-Za-z]:[\\/]/.test(rawPath)) {
      finalPath = rawPath
    } else {
      // 裸名/相对路径：按提示符行解析出的 cwd 归并，回落会话启动 cwd
      const cwd = guessLocalCwd(terminal, session?.config.local?.cwd)
      finalPath = cwd ? localJoin(cwd, rawPath) : null
    }
  } else {
    finalPath = resolveDocPath(rawPath, await getCwd(sessionId))
  }
  if (!finalPath) {
    if (sessionType === 'local') {
      console.warn('[docLink] 本地相对路径无法解析（缓冲区未见 PS/cmd 提示符且会话无 cwd 配置）:', rawPath0)
    } else {
      console.warn('[docLink] 远端相对路径无法解析（无 cwd）:', rawPath0)
    }
    return
  }

  // paneId 实时查：prop 可能过期（页签被拖去别的 pane 后再点旧输出）
  const paneId = usePaneStore.getState().getPaneBySessionId(sessionId)?.id
  if (sessionType === 'local') {
    void openLocalDoc(finalPath, paneId)
  } else {
    void openRemoteDoc(sessionId, finalPath, paneId)
  }
}

/** 幂等守卫：同一 terminal 实例只挂一次（terminal-store 跨组件重挂载保留实例，复用分支会重复走到）。
 *  记录 disposable 与注册时的 sessionId —— 同实例换会话重挂时（理论路径：实例被复用
 *  绑到别的会话）先注销旧 provider，避免旧链接继续用旧 sessionId 开文档页签。 */
const registeredTerminals = new WeakMap<Terminal, { dispose(): void; sessionId: string }>()

/**
 * 构造文档链接 provider（导出供单测直调 provideLinks 验证坐标）。
 */
export function createDocLinkProvider(terminal: Terminal, sessionId: string): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[]) => void): void {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1)
      if (!line) {
        callback([])
        return
      }
      const { text, cols } = buildLineIndex(line)
      const links: ILink[] = []
      for (const m of matchDocPaths(text)) {
        const startX = cols[m.start]
        const endX = cols[m.end - 1]
        if (startX === undefined || endX === undefined) continue
        links.push({
          range: {
            start: { x: startX + 1, y: bufferLineNumber },
            end: { x: endX + 1, y: bufferLineNumber }
          },
          text: m.path,
          // 普通点击不劫持（保留给终端聚焦/光标定位），Ctrl/Cmd+点击才开文档
          activate: (event: MouseEvent) => {
            if (!(event.ctrlKey || event.metaKey)) return
            void activateLink(terminal, sessionId, m.path, bufferLineNumber)
          },
          hover: (event: MouseEvent) => showTip(event.clientX, event.clientY),
          leave: () => hideTip()
        })
      }
      callback(links)
    }
  }
}

/**
 * 注册文档链接 provider。创建/复用两个分支都可安全调用 —— terminal-store
 * 会跨组件重挂载保留终端实例（HMR、切页签回挂都会走复用分支），只挂在
 * 创建分支会让"代码更新前创建的终端"永远没有链接。
 */
export function registerDocLinkProvider(terminal: Terminal, sessionId: string): { dispose(): void } {
  const prev = registeredTerminals.get(terminal)
  if (prev) {
    if (prev.sessionId === sessionId) return { dispose: () => {} } // 同会话重挂：幂等
    prev.dispose() // 换会话：注销旧 provider 重挂，闭包换绑新 sessionId
  }
  const disposable = terminal.registerLinkProvider(createDocLinkProvider(terminal, sessionId))
  registeredTerminals.set(terminal, { dispose: () => disposable.dispose(), sessionId })
  return disposable
}
