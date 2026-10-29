import { ipcRenderer } from 'electron'

/**
 * 只读 webview 专用 preload（运行在 sandbox + contextIsolation 的隔离世界）。
 *
 * 职责（故意保持最小面）：
 * 1. 一次性握手：把主进程注入的 permit 通过 `shelf-browser:attach` 发回；
 * 2. 阻断所有编辑入口：beforeinput / drop / paste / submit / 文件控件 / 可编辑区域；
 * 3. 只上报“被阻断”信号，绝不发送任何 safe / 授权类消息；
 * 4. 受限的滚动遥测与滚动恢复（最多 3 次 / 2 秒，用户输入优先）。
 *
 * 不暴露任何 contextBridge API：guest 页面拿不到任何 Node / IPC 能力。
 * 通道名与 src/main/browser/shelf-readonly-contract.ts 的 READONLY_CHANNELS 保持一致
 * （preload 是独立 bundle，不能运行时引用主进程模块）。
 */

const PERMIT_PREFIX = '--lyshell-shelf-permit='
const ATTACH_CHANNEL = 'shelf-browser:attach'
const BLOCKED_CHANNEL = 'shelf-browser:readonly-blocked'
const SCROLL_COMMAND_CHANNEL = 'shelf-browser:scroll'
const SCROLL_TELEMETRY_CHANNEL = 'shelf-browser:readonly-scroll'

const MAX_PERMIT_LENGTH = 128
const MAX_SCROLL_Y = 10_000_000
const MAX_NONCE_LENGTH = 128
const RESTORE_MAX_ATTEMPTS = 3
const RESTORE_MAX_DURATION_MS = 2000
const RESTORE_ATTEMPT_DELAYS_MS = [0, 150, 450] as const
const RESTORE_TOLERANCE_PX = 2
const OWN_SCROLL_WINDOW_MS = 250
const RESTORE_QUIET_USER_MS = 1000
const TELEMETRY_MIN_INTERVAL_MS = 200
const BLOCKED_MIN_INTERVAL_MS = 200
const documentNonce = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join('')

const CONTROL_SELECTOR = 'input, select, textarea, button, label, [contenteditable]'

type BlockedKind = 'input' | 'change' | 'init-failed'

interface RestoreState {
  readonly navigationNonce: string
  readonly targetY: number
  attempts: number
  deadlineTimer: ReturnType<typeof setTimeout> | null
  nextTimer: ReturnType<typeof setTimeout> | null
}

let controlObserver: MutationObserver | null = null
let lastBlockedAt = 0

let restoreState: RestoreState | null = null
let lastUserIntentAt = 0
let ownScrollY = -1
let ownScrollAt = 0

let telemetryTimer: ReturnType<typeof setTimeout> | null = null
let telemetryPendingY = 0
let telemetryLastSentAt = 0
let telemetrySequence = 0

function isTopFrame(): boolean {
  try {
    return window.top === window
  } catch {
    return false
  }
}

function readPermit(): string | null {
  const argument = process.argv.find((value) => value.startsWith(PERMIT_PREFIX))
  if (!argument) return null
  const permit = argument.slice(PERMIT_PREFIX.length)
  if (permit.length === 0 || permit.length > MAX_PERMIT_LENGTH) return null
  return permit
}

function sendBlocked(kind: BlockedKind): void {
  ipcRenderer.send(BLOCKED_CHANNEL, { kind })
}

function sendHandshake(): void {
  const permit = readPermit()
  if (!isTopFrame()) return
  ipcRenderer.on('shelf-browser:challenge', (_event, id: unknown) => {
    if (typeof id === 'string' && id.length > 0 && id.length <= MAX_PERMIT_LENGTH) ipcRenderer.send(ATTACH_CHANNEL, id, documentNonce)
  })
  const send = (): void => {
    if (permit) ipcRenderer.send(ATTACH_CHANNEL, permit, documentNonce)
  }
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', send, { once: true })
  } else {
    send()
  }
}

// ---------------------------------------------------------------------------
// 编辑入口阻断
// ---------------------------------------------------------------------------

function hardenControls(): void {
  if (document.designMode !== 'off') document.designMode = 'off'

  document.querySelectorAll('input, select, textarea, button').forEach((element) => {
    if (element instanceof HTMLInputElement && element.type === 'file') {
      try {
        element.type = 'text'
      } catch {
        // 个别状态不允许切换类型：保持禁用即可
      }
    }
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLButtonElement
    ) {
      element.disabled = true
    }
  })

  document.querySelectorAll('[contenteditable]').forEach((element) => {
    element.removeAttribute('contenteditable')
  })
}

function blockControlActivation(event: Event): void {
  const target = event.target
  if (!(target instanceof Element)) return
  // 包括 label 触发的合成 click（文件选择器入口），因此不检查 event.isTrusted。
  if (!target.closest(CONTROL_SELECTOR)) return
  event.preventDefault()
  event.stopImmediatePropagation()
}

function reportBlockedInput(kind: 'input' | 'change'): (event: Event) => void {
  return (event: Event): void => {
    if (!event.isTrusted) return
    const now = Date.now()
    if (now - lastBlockedAt < BLOCKED_MIN_INTERVAL_MS) return
    lastBlockedAt = now
    sendBlocked(kind)
  }
}

function installGuards(): void {
  const swallow = (event: Event): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  for (const type of ['beforeinput', 'drop', 'dragover', 'paste', 'submit']) {
    window.addEventListener(type, swallow, { capture: true })
  }
  window.addEventListener('click', blockControlActivation, { capture: true })
  window.addEventListener('input', reportBlockedInput('input'), { capture: true, passive: true })
  window.addEventListener('change', reportBlockedInput('change'), { capture: true, passive: true })

  hardenControls()
  controlObserver = new MutationObserver(hardenControls)
  controlObserver.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['contenteditable'],
  })
}

// ---------------------------------------------------------------------------
// 滚动遥测 / 恢复
// ---------------------------------------------------------------------------

function readScrollY(): number {
  const value = window.scrollY
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(MAX_SCROLL_Y, Math.max(0, Math.round(value)))
}

function isOwnScroll(y: number): boolean {
  return (
    ownScrollY >= 0 &&
    Date.now() - ownScrollAt <= OWN_SCROLL_WINDOW_MS &&
    Math.abs(y - ownScrollY) <= RESTORE_TOLERANCE_PX
  )
}

function flushTelemetry(): void {
  if (telemetryTimer !== null) {
    clearTimeout(telemetryTimer)
    telemetryTimer = null
  }
  telemetryLastSentAt = Date.now()
  telemetrySequence += 1
  ipcRenderer.send(SCROLL_TELEMETRY_CHANNEL, { y: telemetryPendingY, sequence: telemetrySequence, documentNonce })
}

function queueTelemetry(): void {
  telemetryPendingY = readScrollY()
  const waitMs = TELEMETRY_MIN_INTERVAL_MS - (Date.now() - telemetryLastSentAt)
  if (waitMs <= 0) {
    flushTelemetry()
    return
  }
  if (telemetryTimer === null) {
    telemetryTimer = setTimeout(flushTelemetry, waitMs)
  }
}

function markUserIntent(event: Event): void {
  if (!event.isTrusted) return
  lastUserIntentAt = Date.now()
  clearRestore()
}

function onScroll(event: Event): void {
  if (!event.isTrusted) return
  const y = readScrollY()
  if (isOwnScroll(y)) {
    // 自己 scrollTo 触发的滚动不算用户意图。
    queueTelemetry()
    return
  }
  if (restoreState !== null) {
    // 恢复期间页面自身在滚动（锚点跳转 / 滚动锚定）：放弃恢复，避免和页面抢滚动条。
    lastUserIntentAt = Date.now()
    clearRestore()
  }
  queueTelemetry()
}

function clearRestore(): void {
  const state = restoreState
  if (state === null) return
  restoreState = null
  if (state.nextTimer !== null) clearTimeout(state.nextTimer)
  if (state.deadlineTimer !== null) clearTimeout(state.deadlineTimer)
}

function parseScrollCommand(payload: unknown): { navigationNonce: string; y: number } | null {
  if (!payload || typeof payload !== 'object') return null
  const { navigationNonce, y } = payload as { navigationNonce?: unknown; y?: unknown }
  if (
    typeof navigationNonce !== 'string' ||
    navigationNonce.length === 0 ||
    navigationNonce.length > MAX_NONCE_LENGTH
  ) {
    return null
  }
  if (typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > MAX_SCROLL_Y) return null
  return { navigationNonce, y: Math.round(y) }
}

function scheduleAttempt(state: RestoreState, delayMs: number): void {
  if (restoreState !== state) return
  if (state.attempts >= RESTORE_MAX_ATTEMPTS) {
    clearRestore()
    return
  }
  state.nextTimer = setTimeout(() => runAttempt(state), delayMs)
}

function runAttempt(state: RestoreState): void {
  if (restoreState !== state) return
  state.attempts += 1
  ownScrollY = state.targetY
  ownScrollAt = Date.now()
  try {
    window.scrollTo({ left: window.scrollX, top: state.targetY, behavior: 'auto' })
  } catch {
    window.scrollTo(window.scrollX, state.targetY)
  }
  if (Math.abs(readScrollY() - state.targetY) <= RESTORE_TOLERANCE_PX) {
    clearRestore()
    return
  }
  const nextDelay: number | undefined = RESTORE_ATTEMPT_DELAYS_MS[state.attempts]
  if (state.attempts >= RESTORE_MAX_ATTEMPTS || nextDelay === undefined) {
    clearRestore()
    return
  }
  scheduleAttempt(state, nextDelay)
}

function startRestore(navigationNonce: string, targetY: number): void {
  clearRestore()
  // 用户刚刚有输入：这次恢复让位，避免“抢滚动”。
  if (Date.now() - lastUserIntentAt < RESTORE_QUIET_USER_MS) return
  const state: RestoreState = {
    navigationNonce,
    targetY,
    attempts: 0,
    deadlineTimer: null,
    nextTimer: null,
  }
  restoreState = state
  state.deadlineTimer = setTimeout(clearRestore, RESTORE_MAX_DURATION_MS)
  scheduleAttempt(state, RESTORE_ATTEMPT_DELAYS_MS[0])
}

function installScrollBridge(): void {
  for (const type of ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown']) {
    window.addEventListener(type, markUserIntent, { capture: true, passive: true })
  }
  window.addEventListener('scroll', onScroll, { capture: true, passive: true })
  ipcRenderer.on(SCROLL_COMMAND_CHANNEL, (_event, payload: unknown) => {
    const command = parseScrollCommand(payload)
    if (command !== null && command.navigationNonce === documentNonce) startRestore(command.navigationNonce, command.y)
  })
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => queueTelemetry(), { once: true })
  } else {
    queueTelemetry()
  }
}

// ---------------------------------------------------------------------------

function boot(): void {
  try {
    installGuards()
  } catch {
    // 阻断层装不上时不得以“只读已就绪”身份握手：只发阻断信号，由主进程判定。
    sendBlocked('init-failed')
    return
  }
  installScrollBridge()
  sendHandshake()
}

boot()
