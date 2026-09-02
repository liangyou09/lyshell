/**
 * 终端链接 provider —— Ctrl+点击输出行内的 .md/.html/.txt 路径开文档页签，
 * http(s) URL 开网页页签（web 覆盖层，URL 识别见 urlLink.ts）。
 *
 * 坐标系（xterm 5.5 源码核实，Linkifier2/OscLinkProvider）：provideLinks 的
 * 行号与 ILink.range 的 y 均为 1-based 绝对缓冲行（buffer.lines.get(n-1)），
 * 非视口行；range 的 x 为 1-based 列。宽字符占 2 列但字符串里只占 1 字符，
 * 故逐格重建「字符串位置 → 列号」映射，避免含中文行上链接错位。
 *
 * 已知限制：
 * - 远端相对路径的 cwd 双候选：交互 shell 的提示符 cwd（user@host:PATH$ 行）
 *   在前、filePwd 登录目录在后，组合候选逐一 stat 落定 —— 交互终端 cd 之后
 *   仍准。文档读取（filePwd/fileStat 独立连接）与路径归并都跟随会话登录
 *   用户：提示符 cwd 的绝对形态是身份无关的事实照用；~ 形态在提示符用户 ≠
 *   会话 SSH 用户（终端里 su 过 / enter 命令换身份）时弃用 —— ~ 不属于登录
 *   用户，硬按任何一方的家展开都拼出两头不靠的路径，退回登录目录。su 换
 *   身份后点文档读不到是显式报错，而不是追错身份。自定义提示符（starship
 *   ❯、zsh % 等）提示符 cwd 不可得，只剩登录目录（cd 后归并会偏）；
 *   彻底修复靠 OSC 7 shell 集成。
 * - 本地会话没有 pwd 通道，cwd 从 buffer 底部向上找最近一条 PS/cmd 提示符行
 *   （TUI 跑在备用屏幕时提示符在 normal buffer，两个都扫），最终回落到会话
 *   配置的启动 cwd；自定义提示符且无 cwd 配置时相对路径放弃。
 * - 分组列表（`prototypes/（2 个）` 组头 + `- a.html` 裸名条目、`design/（9 个）— …`
 *   组头 + 表格）里的裸文件名会向上（至多 40 行）找最近的目录头行拼上目录再
 *   归并；空行仅在上方首个非空行也是目录头时跨过（组头与表格间的排版空行）。
 * - 远端裸文件名在无目录头时（普通多列 ls 输出）再向上找最近一条 ls/ll 命令
 *   行取目录参数：`ls project/6080/` 的显式参数与 `ls` 无参时提示符里的 cwd
 *   都进候选，stat 先命中者胜出 —— 启发猜错只多一次失败探测，不会错开页签；
 *   参数即文件本身（`ls foo.md` 输出裸名 foo.md）时不作目录上下文。本地无
 *   stat 探测通道，不走此候选。
 * - telnet/serial 会话无文件读取通道，文档路径不响应；URL 打开不依赖会话
 *   类型，任何会话都能点。
 */
import type { Terminal, ILinkProvider, ILink, IBufferLine, IBuffer } from '@xterm/xterm'
import i18n from '../../i18n'
import { useSessionStore } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import { matchDocPaths, resolveDocPath, matchPromptCwd, localJoin, stripLeadingDash, matchDirHeader, matchLsDir, matchRemotePrompt, expandPromptTilde, conventionalHome } from './docLink'
import type { RemotePromptInfo } from './docLink'
import { matchHttpUrls } from './urlLink'
import { openLocalDoc, openRemoteDoc } from './readDoc'

/**
 * filePwd：文件连接器（会话配置 SSH 用户的独立连接）上 execRaw('pwd') 的结果
 * —— 登录用户的 home（SFTP 连接器每次新开 exec 通道；Exec 连接器持久 shell
 * 会重放 shellEnterCommands，enter 命令换过环境则是进入后的目录）。它是
 * 「登录环境」的 cwd，不是交互终端 cd 后的 cwd。每次点击实时查询不缓存 ——
 * 会话换用户重连后登录 home 随之改变，缓存会把旧用户的 home 拼进新会话。
 */
async function getCwd(sessionId: string): Promise<string | undefined> {
  try {
    const res = await window.electronAPI?.filePwd(sessionId)
    if (res && res.success && typeof res.data === 'string' && res.data) return res.data
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

/** 悬浮提示（xterm link 无内建 tooltip，自建一枚复用的浮层；文案按链接种类传入） */
let tipEl: HTMLDivElement | null = null

function showTip(clientX: number, clientY: number, message: string): void {
  if (!tipEl) {
    tipEl = document.createElement('div')
    tipEl.className = 'doc-link-tip'
    document.body.appendChild(tipEl)
  }
  tipEl.textContent = message
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

/**
 * 裸文件名的 ls 命令目录上下文：从点击行向上（至多 40 行，与 findGroupDir
 * 对齐）找最近一条含 ls/ll 命令的行，取其目录参数（matchLsDir）。中间的
 * 多列列表行不阻断扫描（一次 ls 输出可能占多行）；与目录头不同，这里命中
 * 也只是候选 —— 调用方（pickRemoteDocPath）还要 stat 验证。
 */
export function findLsDir(terminal: Terminal, clickedLineNumber: number): string | null {
  try {
    const buffer = terminal.buffer.active
    for (let ln = clickedLineNumber - 1; ln >= 1 && ln > clickedLineNumber - 1 - 40; ln--) {
      const line = buffer.getLine(ln - 1)
      if (!line) break
      const dir = matchLsDir(line.translateToString(true).trim())
      if (dir) return dir
    }
  } catch { /* buffer 读取异常按无目录上下文处理 */ }
  return null
}

/**
 * 交互 shell 的提示符上下文：从点击行向上（至多 40 行）找最近一条
 * user@host:PATH$ 提示符行（matchRemotePrompt），拿到交互终端 cd 之后的真实
 * cwd 与当前用户（filePwd 只是会话配置用户的登录目录 / 登录 home）。命中也
 * 只是候选，调用方 stat 验证。
 */
export function findRemotePrompt(terminal: Terminal, clickedLineNumber: number): RemotePromptInfo | null {
  try {
    const buffer = terminal.buffer.active
    for (let ln = clickedLineNumber - 1; ln >= 1 && ln > clickedLineNumber - 1 - 40; ln--) {
      const line = buffer.getLine(ln - 1)
      if (!line) break
      const prompt = matchRemotePrompt(line.translateToString(true).trim())
      if (prompt) return prompt
    }
  } catch { /* buffer 读取异常按无 cwd 上下文处理 */ }
  return null
}

/** 远端路径的 cwd 无关形态：绝对 / ~\ 前缀（盘符是本地概念，出现也透传）。
 *  ~/ 前缀不算 —— 可按登录目录展开成 stat 可用的绝对路径（SFTP 不认 ~） */
const isRemotePassthrough = (p: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('~\\')

/**
 * 远端相对路径的落点选择：ls 目录 × cwd 双轴组合候选，逐一 stat 先命中者胜出。
 * 读取（filePwd/fileStat 的独立连接）与路径归并都跟随会话登录用户：
 * - ~ 展开基准 = 登录 home（filePwd）；拿不到时按会话 SSH 用户名猜惯例家目录
 *   （Linux 惯例，macOS /Users 等会猜错 —— 只影响 filePwd 已失败时的错误页签
 *   候选路径，stat 探测随之落空）。
 * - cwd 轴：提示符 cwd 在前、登录 home 在后。提示符 cwd 的绝对形态是身份
 *   无关的事实，直接用；~ 形态挂的是提示符用户的家，提示符用户 ≠ 会话 SSH
 *   用户（终端里 su 过）时登录用户解释不了它 —— 弃用该 cwd 退回登录 home，
 *   不按任何一方的家硬拼出两头不靠的路径。前者不可得时后者是唯一来源。
 * - ls 目录轴：仅裸文件名且有命令行目录参数时，拼目录在前、裸名在后
 *   （目录参数比 cwd 更具体）；拼接分隔符跟随 lsDir 自身风格。多段相对路径
 *   只有 cwd 轴。
 * 候选只是启发（提示符行 / 命令行都未必与点击行同属一次输出），stat 把「猜错」
 * 变成一次失败的探测而非错误页签；全部未命中（拼错 / 通道异常）取首选候选 ——
 * 错误页签展示最可能的意图路径，比静默回落更可排查。
 */
export async function pickRemoteDocPath(
  sessionId: string,
  path: string,
  lsDir: string | null,
  prompt: RemotePromptInfo | null,
  sshUser?: string
): Promise<string | null> {
  const home = await getCwd(sessionId)
  // ls 的参数即文件本身（`ls foo.md` 的输出就是裸名 foo.md）：目录参数与点击
  // 的裸名同名时，拼出的 foo.md/foo.md 是无意义候选（stat 拒绝得了时靠回落
  // 救回，stat 整体不可用时它还会成为兜底首选）—— 按无目录上下文处理，
  // cwd 归并即正解
  if (lsDir && lsDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() === path) lsDir = null
  // ~ 展开基准：登录 home；filePwd 拿不到时按会话 SSH 用户名猜惯例家目录
  const tildeBase = home ?? (sshUser !== undefined ? conventionalHome(sshUser) : undefined)
  // 提示符 cwd：~ 形态且提示符用户 ≠ 会话 SSH 用户（终端里 su 过）时弃用 ——
  // 读取跟随登录用户，~ 不属于它；绝对形态是身份无关的事实，保留
  const promptCwdUsable = prompt !== null &&
    (prompt.cwd.startsWith('/') || sshUser === undefined || prompt.user === sshUser)
  const promptCwd = promptCwdUsable ? expandPromptTilde(prompt.cwd, tildeBase) : null
  // cwd 轴：提示符 cwd（可用时）在前、登录 home 在后（Set 去重）
  const cwds = [...new Set([promptCwd, home].filter((p): p is string => p !== null))]
  // ls 目录轴
  let rels: string[]
  if (lsDir) {
    // 分隔符跟随 lsDir 自身风格（Windows 远端 shell 的反斜杠目录参数）；
    // 已带尾分隔符直接拼接
    const sep = /[\\/]$/.test(lsDir) ? '' : (lsDir.includes('\\') && !lsDir.includes('/') ? '\\' : '/')
    rels = [lsDir + sep + path, path]
  } else {
    rels = [path]
  }
  // rel 自带 ~/ 前缀时按登录用户展开成 stat 可用的绝对路径（SFTP 不认 ~）；
  // 无基准可依（展不开）保留原样 —— resolveDocPath 透传，与旧行为一致的兜底
  const expandedRels = rels.flatMap(rel => {
    if (rel.startsWith('~')) {
      const exp = tildeBase !== undefined ? expandPromptTilde(rel, tildeBase) : null
      return exp !== null ? [exp] : [rel]
    }
    return [rel]
  })
  const candidates = [...new Set(
    expandedRels
      .flatMap(rel => (cwds.length > 0 ? cwds : [undefined]).map(cwd => resolveDocPath(rel, cwd)))
      .filter((p): p is string => p !== null)
  )]
  for (const p of candidates) {
    try {
      const res = await window.electronAPI?.fileStat(sessionId, p)
      if (res?.success && res.data && !res.data.isDir) return p
    } catch { /* stat 异常按未命中继续：通道问题时仍取候选路径开页签出显式报错 */ }
  }
  return candidates[0] ?? null
}

/** 激活（Ctrl+点击）：解析路径 → 按会话类型走远端/本地读取 → 开文档页签 */
async function activateLink(terminal: Terminal, sessionId: string, rawPath0: string, lineNo?: number): Promise<void> {
  const session = useSessionStore.getState().sessions.find(s => s.id === sessionId)
  const sessionType = session?.config.type
  if (sessionType !== 'ssh' && sessionType !== 'local') return

  // 弹点符号直接贴着路径（-.claude/x.md）时剥掉，不影响选中区间
  let rawPath = stripLeadingDash(rawPath0)

  // 裸文件名（不含分隔符）且知道点击行：先找分组目录头（prototypes/（2 个））；
  // 无目录头（普通多列 ls 输出）时远端再找 ls 命令行的目录参数作候选
  let lsDir: string | null = null
  if (lineNo !== undefined && !/[\\/]/.test(rawPath)) {
    const dir = findGroupDir(terminal, lineNo)
    if (dir) {
      rawPath = dir + rawPath
    } else if (sessionType === 'ssh') {
      lsDir = findLsDir(terminal, lineNo)
    }
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
  } else if (lineNo !== undefined && !isRemotePassthrough(rawPath)) {
    // 远端相对路径（裸名/多段/~/ 前缀）：提示符 cwd + 登录目录 cwd（+ ls 目录
    // 参数）组合候选逐一 stat 落定；绝对路径无 cwd 参与，走下方透传
    const prompt = findRemotePrompt(terminal, lineNo)
    // 会话配置的 SSH 用户：filePwd 独立连接以此为身份，读取跟随它 —— 提示符
    // 用户与之不同（终端里 su 过）时 ~ 形态的提示符 cwd 不属于登录用户，弃用
    const cfg = session?.config
    const sshUser = cfg && cfg.type === 'ssh' ? cfg.ssh?.username : undefined
    finalPath = await pickRemoteDocPath(sessionId, rawPath, lsDir, prompt, sshUser)
  } else {
    finalPath = resolveDocPath(rawPath, await getCwd(sessionId))
  }
  if (!finalPath) {
    if (sessionType === 'local') {
      console.warn('[docLink] 本地相对路径无法解析（缓冲区未见 PS/cmd 提示符且会话无 cwd 配置）:', rawPath0)
      return
    }
    // 远端无从落定（filePwd 失败且无提示符行可用）：以原相对路径开错误页签 ——
    // 显式报错比静默无反应可排查（与「错误页签展示意图」的既有取舍一致）
    const errPaneId = usePaneStore.getState().getPaneBySessionId(sessionId)?.id
    void openRemoteDoc(sessionId, rawPath, errPaneId)
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

/** Ctrl+点击 URL：开网页页签。落点 pane 同样实时查；URL 打开不依赖会话类型
 *  （无文件读取）。失败要出声——识别成链但打不开的情形不能静默（与 activateLink
 *  的 warn 惯例一致，排查「点了没反应」时这是唯一的线索出口） */
function openTerminalUrl(sessionId: string, url: string): void {
  const paneId = usePaneStore.getState().getPaneBySessionId(sessionId)?.id
  const res = usePaneStore.getState().openWebTab(url, paneId)
  if (!res.ok) console.warn('[docLink] 打开网页页签失败:', res.error, url)
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
          hover: (event: MouseEvent) => showTip(event.clientX, event.clientY, i18n.t('doc.ctrlClickHint')),
          leave: () => hideTip()
        })
      }
      // URL 与文档路径无重叠（路径正则的 lookbehind 挡住 https://…/x.md 的
      // 一切子串起点），两条扫描直接并排追加即可
      for (const u of matchHttpUrls(text)) {
        const startX = cols[u.start]
        const endX = cols[u.end - 1]
        if (startX === undefined || endX === undefined) continue
        links.push({
          range: {
            start: { x: startX + 1, y: bufferLineNumber },
            end: { x: endX + 1, y: bufferLineNumber }
          },
          text: u.url,
          activate: (event: MouseEvent) => {
            if (!(event.ctrlKey || event.metaKey)) return
            openTerminalUrl(sessionId, u.url)
          },
          hover: (event: MouseEvent) => showTip(event.clientX, event.clientY, i18n.t('doc.ctrlClickUrlHint')),
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
