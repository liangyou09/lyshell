import { randomUUID } from 'crypto'
import { session, webContents } from 'electron'
import type { WebContents, WebFrameMain } from 'electron'
import { WEBBAR_PARTITION } from '@shared/constants'
import { parseWebTerminalRequest } from '@shared/web-terminal'
import type { WebTerminalError, WebTerminalRequest, WebTerminalResult } from '@shared/web-terminal'
import { webTerminalInputScript, webTerminalClearScript } from './web-terminal-input'

/**
 * 网页终端输入后端：把主窗口的文本发送到用户在堡垒机页面里点选的 xterm.js 终端。
 *
 * 设计要点：
 * - 只操作本窗口托管、webbar 分区的 webview，构建时不扩大任何 webPreferences。
 * - 页面侧采用固定函数模板；命令只经 JSON 序列化作为数据参数，不能执行为代码。
 * - 绑定由「随机 token + 文档/元素标记」定位，导航、frame 重载、终端元素被替换
 *   或 guest 销毁后立即失效，等待用户重新绑定。
 */

/** 单帧脚本的等待上限；超时即视为该帧不可用，后续不会再发送任何内容。 */
const SCRIPT_TIMEOUT_MS = 700

/** 单次 bind 最多探测的 frame 数量，避免超多 iframe 页面产生无界任务。 */
export const WEB_TERMINAL_MAX_FRAMES = 24

/** 页面侧标记属性名（固定，不承载秘密）；属性值才是绑定 token。 */
const MARK_ATTR = 'data-lyshell-terminal'

/** 绑定 token 由页面侧 16 字节随机数生成，这里校验其形状。 */
const TOKEN_PATTERN = /^[0-9a-f]{32}$/

/**
 * 探测模板：只读，不修改 DOM。返回本帧 activeElement 是否是一个可见 xterm 的输入面。
 * 注意 xterm 的 helper textarea 本身是 opacity:0 / 0×0 / 移出屏幕的，
 * 因此「可见」判断落在 .xterm 根节点上。
 */
export const WEB_TERMINAL_PROBE_SCRIPT = `(() => {
  const MARK = ${JSON.stringify(MARK_ATTR)}
  const ROOT = 'xterm'
  const INPUT = 'xterm-helper-textarea'
  const shown = (node) => {
    if (!node || !node.isConnected) return false
    if (typeof node.checkVisibility === 'function') {
      if (!node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    }
    const rect = node.getBoundingClientRect()
    return rect.width > 1 && rect.height > 1
  }
  const inputs = []
  for (const root of Array.from(document.querySelectorAll('.' + ROOT))) {
    if (!shown(root)) continue
    for (const input of Array.from(root.querySelectorAll('textarea.' + INPUT))) {
      if (!input.disabled && !input.readOnly) inputs.push(input)
    }
  }
  const active = document.activeElement
  const pick = () => {
    for (const input of inputs) if (input === active) return input
    // 焦点可能停在 .xterm 内部的其它节点；只有在根节点内能唯一确定输入框时才接受，
    // 避免把普通表单/密码框当成终端。
    if (!active) return null
    for (const input of inputs) {
      const root = input.closest('.' + ROOT)
      if (root && root.contains(active) && root.querySelectorAll('.' + INPUT).length === 1) return input
    }
    return null
  }
  const target = pick()
  return { terminal: !!target, href: location.href, marked: document.documentElement.hasAttribute(MARK) }
})()`

/**
 * 标记模板：重新确认同一终端后写入随机 token（token 在页面内生成并回传，
 * 主进程从不把它当作脚本执行），保存原元素的弱引用。
 */
export const WEB_TERMINAL_STAMP_SCRIPT = `(() => {
  const MARK = ${JSON.stringify(MARK_ATTR)}
  const ROOT = 'xterm'
  const INPUT = 'xterm-helper-textarea'
  const shown = (node) => {
    if (!node || !node.isConnected) return false
    if (typeof node.checkVisibility === 'function') {
      if (!node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    }
    const rect = node.getBoundingClientRect()
    return rect.width > 1 && rect.height > 1
  }
  const randomToken = () => {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  const active = document.activeElement
  const candidates = []
  for (const root of Array.from(document.querySelectorAll('.' + ROOT))) {
    if (!shown(root)) continue
    for (const input of Array.from(root.querySelectorAll('textarea.' + INPUT))) {
      if (!input.disabled && !input.readOnly) candidates.push(input)
    }
  }
  let target = null
  for (const input of candidates) if (input === active) target = input
  if (!target && active) {
    for (const input of candidates) {
      const root = input.closest('.' + ROOT)
      if (root && root.contains(active) && root.querySelectorAll('.' + INPUT).length === 1) target = input
    }
  }
  if (!target) return { ok: false, href: location.href }
  // 清掉上一次绑定留下的标记，避免旧元素被误认为当前目标
  for (const node of Array.from(document.querySelectorAll('[' + MARK + ']'))) node.removeAttribute(MARK)
  document.documentElement.removeAttribute(MARK)
  const token = randomToken()
  document.documentElement.setAttribute(MARK, token)
  const root = target.closest('.' + ROOT)
  if (root) root.setAttribute(MARK, token)
  target.setAttribute(MARK, token)
  globalThis[Symbol.for('lyshell.web-terminal.v1')] = {token, target: new WeakRef(target), root: new WeakRef(root)}
  return {
    ok: document.activeElement === target,
    token: token,
    href: location.href,
    terminals: document.querySelectorAll('.' + ROOT + ' .' + INPUT).length
  }
})()`

/**
 * 校验模板：确认文档 token 与输入面 token 一致（同一文档、同一终端元素），
 * 确认终端仍可见、仍是原元素，并把它聚焦。
 */
export const WEB_TERMINAL_CHECK_SCRIPT = `(() => {
  const MARK = ${JSON.stringify(MARK_ATTR)}
  const ROOT = 'xterm'
  const INPUT = 'xterm-helper-textarea'
  const shown = (node) => {
    if (!node || !node.isConnected) return false
    if (typeof node.checkVisibility === 'function') {
      if (!node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    }
    const rect = node.getBoundingClientRect()
    return rect.width > 1 && rect.height > 1
  }
  const docToken = document.documentElement.getAttribute(MARK) || ''
  if (!docToken) return { ok: false, docToken: '', elementToken: '', href: location.href }
  const target = Array.from(document.querySelectorAll('.' + INPUT + '[' + MARK + ']'))
    .find((node) => node.getAttribute(MARK) === docToken) || null
  if (!target) return { ok: false, docToken: docToken, elementToken: '', href: location.href }
  const state = globalThis[Symbol.for('lyshell.web-terminal.v1')]
  if (!state || state.token !== docToken || state.target.deref() !== target || state.root.deref() !== target.closest('.' + ROOT)) return {ok:false}
  const elementToken = target.getAttribute(MARK) || ''
  const root = target.closest('.' + ROOT)
  if (!root || !shown(root)) return { ok: false, docToken: docToken, elementToken: elementToken, href: location.href }
  return {
    ok: document.activeElement === target,
    docToken: docToken,
    elementToken: elementToken,
    href: location.href
  }
})()`

type LooseListener = (...args: never[]) => void

type FrameProbe = { frame: WebFrameMain; href: string; terminal: boolean }

interface Binding {
  id: string
  owner: WebContents
  page: WebContents
  pageId: number
  frame: WebFrameMain | null
  frameUrl: string
  url: string
  token: string
  dropped: boolean
  listeners: { target: WebContents; event: string; listener: LooseListener }[]
}

const bindings = new Map<number, Binding>()
const inflight = new Set<number>()

function fail(error: WebTerminalError): WebTerminalResult {
  return { success: false, error }
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function frameKey(frame: WebFrameMain): string {
  try {
    if (typeof frame.frameTreeNodeId === 'number') return `tree:${frame.frameTreeNodeId}`
    return `route:${frame.processId}:${frame.routingId}`
  } catch {
    // 已销毁的 frame 访问属性可能抛错；按「已失效」参与比较即可
    return 'destroyed'
  }
}

function sameFrame(left: WebFrameMain | null | undefined, right: WebFrameMain | null | undefined): boolean {
  if (!left || !right) return false
  if (left === right) return true
  return frameKey(left) === frameKey(right)
}

function frameAlive(frame: WebFrameMain | null | undefined): frame is WebFrameMain {
  try { return !!frame && !frame.isDestroyed() } catch { return false }
}

/**
 * 执行模板，超时/异常返回 undefined；输入模板另带绝对截止时间，禁止迟到输入。
 */
function runScript(frame: WebFrameMain, script: string, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<unknown> {
  if (!frameAlive(frame)) return Promise.resolve(undefined)
  let pending: Promise<unknown>
  try {
    pending = frame.executeJavaScript(script, true)
  } catch {
    return Promise.resolve(undefined)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
  })
  const settled = Promise.race([pending.catch(() => undefined), timeout])
  return settled.finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function resolveOwnedPage(owner: WebContents, pageId: number): { page: WebContents } | { error: WebTerminalError } {
  if (!owner || typeof owner.isDestroyed !== 'function') return { error: 'denied' }
  if (owner.isDestroyed()) return { error: 'unavailable' }
  if (owner.getType() !== 'window') return { error: 'denied' }
  if (pageId === owner.id) return { error: 'denied' }
  const page = webContents.fromId(pageId)
  if (!page || page.isDestroyed()) return { error: 'unavailable' }
  if (page === owner || page.getType() !== 'webview') return { error: 'denied' }
  if (page.hostWebContents !== owner) return { error: 'denied' }
  if (page.session !== session.fromPartition(WEBBAR_PARTITION)) return { error: 'denied' }
  // about:blank / file: / devtools: 等页面不参与输入
  if (!isHttpUrl(page.getURL())) return { error: 'unavailable' }
  return { page }
}

function listen(binding: Binding, target: WebContents, event: string, listener: LooseListener): void {
  const emitter = target as unknown as { on: (name: string, handler: LooseListener) => void }
  emitter.on(event, listener)
  binding.listeners.push({ target, event, listener })
}

function detach(binding: Binding): void {
  const listeners = binding.listeners
  binding.listeners = []
  for (const { target, event, listener } of listeners) {
    try {
      const emitter = target as unknown as { removeListener: (name: string, handler: LooseListener) => void }
      emitter.removeListener(event, listener)
    } catch {
      // 页面或窗口已销毁时移除监听失败无需处理
    }
  }
}

/** 作废绑定：摘掉监听、从表中移除，并尽力清掉页面标记。 */
function drop(binding: Binding): void {
  if (binding.dropped) return
  binding.dropped = true
  detach(binding)
  if (bindings.get(binding.pageId) === binding) bindings.delete(binding.pageId)
  const frame = binding.frame
  if (frameAlive(frame) && binding.token) void runScript(frame, webTerminalClearScript(binding.token)).catch(() => undefined)
}

function attach(binding: Binding): void {
  const { page, owner } = binding
  // 主框架任何导航（含 SPA 的 in-place 导航）都让绑定失效，等待用户重新绑定
  listen(binding, page, 'did-start-navigation', (details: unknown, _url?: string, _isInPlace?: boolean, isMainFrame?: boolean): void => {
    const info = asRecord(details)
    if ((info && info.isMainFrame === true) || isMainFrame === true) {
      drop(binding)
      return
    }
    const navigating = info && typeof info.frame === 'object' && info.frame !== null ? (info.frame as WebFrameMain) : null
    if (navigating && sameFrame(navigating, binding.frame)) drop(binding)
  })
  listen(binding, page, 'did-navigate-in-page', (_event: unknown, _url?: string, isMainFrame?: boolean): void => {
    if (isMainFrame === true) drop(binding)
  })
  listen(binding, page, 'destroyed', (): void => { drop(binding) })
  listen(binding, page, 'render-process-gone', (): void => { drop(binding) })
  listen(binding, owner, 'destroyed', (): void => { drop(binding) })
}

/** 探测顺序：先看用户最后聚焦的 frame，再按 framesInSubtree 顺序，总数有上限。 */
function candidateFrames(page: WebContents): WebFrameMain[] {
  const ordered: WebFrameMain[] = []
  const seen = new Set<string>()
  const push = (frame: WebFrameMain | null | undefined): void => {
    if (!frame || ordered.length >= WEB_TERMINAL_MAX_FRAMES || !frameAlive(frame)) return
    const key = frameKey(frame)
    if (seen.has(key)) return
    seen.add(key)
    ordered.push(frame)
  }
  push(page.focusedFrame)
  let frames: WebFrameMain[] = []
  try {
    frames = page.mainFrame?.framesInSubtree ?? []
  } catch {
    frames = []
  }
  for (const frame of frames) push(frame)
  return ordered
}

async function probeFrame(frame: WebFrameMain): Promise<FrameProbe | null> {
  const value = asRecord(await runScript(frame, WEB_TERMINAL_PROBE_SCRIPT))
  if (!value) return null
  return {
    frame,
    href: typeof value.href === 'string' ? value.href : frame.url,
    terminal: value.terminal === true
  }
}

async function bind(owner: WebContents, pageId: number): Promise<WebTerminalResult> {
  if (inflight.has(pageId)) return fail('busy')
  const resolved = resolveOwnedPage(owner, pageId)
  if (!('page' in resolved)) return fail(resolved.error)
  const page = resolved.page
  const previous = bindings.get(pageId)
  if (previous) drop(previous)
  inflight.add(pageId)
  const binding: Binding = {
    id: randomUUID(),
    owner,
    page,
    pageId,
    frame: null,
    frameUrl: '',
    url: page.getURL(),
    token: '',
    dropped: false,
    listeners: []
  }
  bindings.set(pageId, binding)
  attach(binding)
  try {
    const frames = candidateFrames(page)
    if (frames.length === 0) return dropWith(binding, 'unsupported')
    const probes = (await Promise.all(frames.map(frame => probeFrame(frame)))).filter(
      (probe): probe is FrameProbe => probe !== null && probe.terminal
    )
    if (binding.dropped) return fail('stale')
    if (probes.length === 0) return dropWith(binding, 'unsupported')
    const focusedFrame = page.focusedFrame
    // 用户最后一次聚焦的 frame 不是终端时不做猜测，要求先点终端再绑定
    if (frameAlive(focusedFrame) && !probes.some(probe => sameFrame(probe.frame, focusedFrame))) {
      return dropWith(binding, 'unsupported')
    }
    const chosen = probes.length === 1
      ? probes[0]
      : probes.find(probe => sameFrame(probe.frame, focusedFrame))
    // 多个候选却无法确定「最后点选的终端」时不随机挑选
    if (!chosen) return dropWith(binding, 'unsupported')
    const stamp = asRecord(await runScript(chosen.frame, WEB_TERMINAL_STAMP_SCRIPT))
    const stampToken = stamp && stamp.ok === true && typeof stamp.token === 'string' && TOKEN_PATTERN.test(stamp.token)
      ? stamp.token
      : null
    if (stampToken === null) {
      // 未收到 token 的迟到标记不能成为主进程绑定，后续绑定会覆盖它。
      return dropWith(binding, 'unsupported')
    }
    if (binding.dropped) {
      // 标记期间发生了导航，不能接受这份结果。
      return fail('stale')
    }
    if (!frameAlive(chosen.frame)) return dropWith(binding, 'stale')
    binding.frame = chosen.frame
    binding.frameUrl = chosen.href
    binding.token = stampToken
    // 探测/标记期间页面可能已经跳转，此时旧文档上的标记不再可信
    if (page.isDestroyed()) return dropWith(binding, 'unavailable')
    if (page.getURL() !== binding.url) return dropWith(binding, 'stale')
    if (chosen.frame.url !== binding.frameUrl) return dropWith(binding, 'stale')
    if (typeof stamp?.href === 'string' && stamp.href !== binding.frameUrl) return dropWith(binding, 'stale')
    return { success: true, bindingId: binding.id, url: binding.url }
  } finally {
    inflight.delete(pageId)
  }
}

function dropWith(binding: Binding, error: WebTerminalError): WebTerminalResult {
  drop(binding)
  return fail(error)
}

type CheckResult = { ok: boolean; docToken: string; elementToken: string }

function parseCheck(value: unknown): CheckResult | null {
  const record = asRecord(value)
  if (!record) return null
  return {
    ok: record.ok === true,
    docToken: typeof record.docToken === 'string' ? record.docToken : '',
    elementToken: typeof record.elementToken === 'string' ? record.elementToken : ''
  }
}

async function send(
  owner: WebContents,
  request: Extract<WebTerminalRequest, { kind: 'send' }>
): Promise<WebTerminalResult> {
  const { pageId } = request
  const binding = bindings.get(pageId)
  if (!binding || binding.id !== request.bindingId) return fail('stale')
  if (binding.owner !== owner) return fail('denied')
  if (binding.dropped) return fail('stale')
  const { page } = binding
  if (binding.owner.isDestroyed() || page.isDestroyed()) {
    drop(binding)
    return fail('unavailable')
  }
  const frame = binding.frame
  if (!frameAlive(frame)) return dropWith(binding, 'stale')
  if (page.getURL() !== binding.url || frame.url !== binding.frameUrl) return dropWith(binding, 'stale')
  if (inflight.has(pageId)) return fail('busy')
  inflight.add(pageId)
  try {
    const check = parseCheck(await runScript(frame, WEB_TERMINAL_CHECK_SCRIPT))
    // 校验失败或超时：目标已不可用，绑定作废，绝不发送
    if (!check || !check.ok) return dropWith(binding, 'stale')
    if (check.docToken !== binding.token || check.elementToken !== binding.token) return dropWith(binding, 'stale')
    if (binding.dropped) return fail('stale')
    if (page.getURL() !== binding.url || !frameAlive(frame)) return dropWith(binding, 'stale')
    // 输入与回车在同一个 frame 回合中完成；不能使用跨进程 iframe 上会崩溃的原生 IME 路由。
    const outcome = asRecord(await runScript(frame, webTerminalInputScript({
      text: request.text, enter: request.enter, token: binding.token,
      href: binding.frameUrl, expires: Date.now() + SCRIPT_TIMEOUT_MS
    })))
    if (!outcome || outcome.ok !== true) return dropWith(binding, outcome?.partial === false ? 'stale' : 'uncertain')
    if (binding.dropped || page.getURL() !== binding.url || !frameAlive(frame)) return dropWith(binding, 'uncertain')
    return { success: true, bindingId: binding.id, url: page.getURL() }
  } finally {
    inflight.delete(pageId)
  }
}

function release(owner: WebContents, request: Extract<WebTerminalRequest, { kind: 'release' }>): WebTerminalResult {
  const binding = bindings.get(request.pageId)
  if (!binding || binding.id !== request.bindingId) return fail('stale')
  if (binding.owner !== owner) return fail('denied')
  drop(binding)
  return { success: true }
}

/**
 * 主进程入口：bind / send / release 三个动作都先做严格校验与归属检查。
 * 任何失败都以 `WebTerminalResult.error` 返回，不抛出异常。
 */
export async function webTerminalRequest(owner: WebContents, request: WebTerminalRequest): Promise<WebTerminalResult> {
  const parsed = parseWebTerminalRequest(request)
  if (!parsed) return fail('invalid')
  if (!owner || typeof owner.isDestroyed !== 'function' || owner.isDestroyed()) return fail('unavailable')
  switch (parsed.kind) {
    case 'bind':
      return bind(owner, parsed.pageId)
    case 'send':
      return send(owner, parsed)
    case 'release':
      return release(owner, parsed)
    default:
      return fail('invalid')
  }
}
