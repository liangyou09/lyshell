import type { Session, WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import { shelfWebUrl } from '@shared/task-shelf'
import { hasReadonlySession } from './shelf-readonly-contract'

/**
 * 可重载普通网页的「观察器」契约（显式同源 GET 重载 + 丢弃 JS 堆）。
 *
 * 设计约束：
 * - 本模块只提供**观察**，绝不自行授权、绝不决定用户同意。`safe` 只表示
 *   “主进程原生条件干净 + 隔离世界观察器没有看到已知风险”，运行时必须另有
 *   显式的逐 URL 用户同意才能据此重载。
 * - 不接受网页自报的任何消息：不注册自定义 IPC、不新增 preload。DOM 观察只通过
 *   `webContents.executeJavaScriptInIsolatedWorld(1005, [...])` 注入主进程生成的
 *   静态脚本，脚本运行在隔离世界，网页主世界无法覆盖其中的状态。
 * - 网页侧只允许「标记 blocked + 记录受限滚动位置」；绝不拦截、不 preventDefault、
 *   不改写网页 DOM、不读取任何文本 / 键值。
 * - 观察器缺少 nonce、抛错、状态不一致、导航竞态一律 fail closed（blocked / unknown）。
 * - 本模块只依赖 Electron 的**类型**（无运行时 electron import），全部原生行为
 *   通过入参注入，因此可在纯 Node（vitest）下测试。
 *
 * Provider 标识：与只读契约的 `app:readonly-v1` 区分，运行时可据此选择不同的
 * 保护判定；这里不写生命周期 / 资源表。
 */
export const RELOADABLE_PROVIDER = 'app:reloadable-v1'

export type ReloadableDecision = 'safe' | 'blocked' | 'unknown'

export interface ReloadableSnapshot {
  decision: ReloadableDecision
  reasonCodes: string[]
  url?: string
  documentNonce?: string
  scrollY?: number
}

/** 隔离世界 ID：网页主世界与其它注入脚本都不可见，主进程独占。 */
const ISOLATED_WORLD_ID = 1005
const BRIDGE_KEY = '__lyshellReloadableV1'
const MAX_SCROLL_Y = 10_000_000
const MAX_REASON_CODES = 16
const MAX_STATE_REASONS = 32
const MAX_PENDING_REQUESTS = 128
const MAX_LATCHES = 32
const NONCE_PATTERN = /^[a-f0-9]{32}$/
const REASON_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/
const RESTORE_MAX_ATTEMPTS = 3
const RESTORE_MAX_DURATION_MS = 2000
const RESTORE_ATTEMPT_DELAYS_MS = [0, 150, 450] as const
const RESTORE_TOLERANCE_PX = 2

/** 这些原因表示“无法判定”，不是确定的阻断；safe 与两者都不同。 */
const UNKNOWN_REASON_CODES: ReadonlySet<string> = new Set([
  'guest-destroyed',
  'renderer-crashed',
  'renderer-gone',
  'inspection-failed',
  'inspection-timeout',
  'request-observation-unknown',
  'listener-failed',
  'observer-failed',
  'state-missing',
  'state-inconsistent',
  'scan-failed',
  'query-failed',
  'restore-failed',
  'dom-too-large',
  'custom-element-unknown',
  'shadow-dom-unknown',
  'navigation-during-inspection',
  'service-worker-active',
  'service-worker-unknown',
])

/**
 * 本模块用到的原生 WebContents 子集（测试注入同形假对象）。
 * 只保留需要的成员，避免依赖 Electron 的完整运行时对象。
 */
interface GuardGuest {
  readonly id: number
  readonly session: Session
  readonly debugger?: {
    isAttached?: () => boolean
    on?: (event: string, listener: () => void) => unknown
    removeListener?: (event: string, listener: () => void) => unknown
  }
  readonly mainFrame?: { readonly framesInSubtree: readonly unknown[] }
  isDestroyed: () => boolean
  getURL: () => string
  isLoadingMainFrame: () => boolean
  isCrashed: () => boolean
  isCurrentlyAudible: () => boolean
  isDevToolsOpened: () => boolean
  executeJavaScriptInIsolatedWorld: (
    worldId: number,
    scripts: Array<{ code: string }>
  ) => Promise<unknown>
  on: (event: string, listener: (...args: unknown[]) => void) => unknown
  once: (event: string, listener: (...args: unknown[]) => void) => unknown
  removeListener: (event: string, listener: (...args: unknown[]) => void) => unknown
}

interface RequestDetailsLike {
  id?: unknown
  method?: unknown
  resourceType?: unknown
  webContentsId?: unknown
}

interface WebRequestLike {
  onBeforeRequest: (
    listener: (details: RequestDetailsLike, callback: (response: Record<string, unknown>) => void) => void
  ) => void
  onCompleted?: (listener: (details: RequestDetailsLike) => void) => void
  onErrorOccurred?: (listener: (details: RequestDetailsLike) => void) => void
}

interface GuardSession {
  readonly webRequest?: WebRequestLike
  readonly serviceWorkers?: { getAllRunning?: () => unknown }
  isPersistent?: () => boolean
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
}

interface Reason {
  code: string
  unknown: boolean
}

interface GuardState {
  disposed: boolean
  destroyed: boolean
  detached: boolean
  /** 每发生一次主框架完整文档导航就 +1；快照用它识别跨文档回包。 */
  documentSeq: number
  documentNonce: string | null
  /** 观察器已成功安装到的 documentSeq；不相等说明当前文档还没有观察器。 */
  observerSeq: number | null
  readonly latches: Set<string>
  readonly requests: Set<number>
  requestOverflow: boolean
}

interface Injection {
  seq: number
  promise: Promise<boolean>
}

interface SessionBinding {
  readonly guards: Map<number, Set<ReloadablePageGuard>>
}

const initializedSessions = new WeakSet<Session>()
const sessionBindings = new WeakMap<Session, SessionBinding>()

// ---------------------------------------------------------------------------
// 隔离世界脚本（静态常量 + 主进程生成的 32hex nonce）
// ---------------------------------------------------------------------------

const NONCE_TOKEN = '@@RELOADABLE_NONCE@@'
const TARGET_TOKEN = '@@RELOADABLE_TARGET@@'

/**
 * 观察器安装脚本。只读 DOM、只挂被动监听：不 preventDefault、不改网页 DOM、
 * 不读取文本。MutationObserver 只检查新增节点的标签 / 控件选择器 / open shadowRoot。
 */
const OBSERVER_SOURCE = `(() => {
  'use strict';
  try {
    const NONCE = '${NONCE_TOKEN}';
    const KEY = '${BRIDGE_KEY}';
    const MAX_SCROLL = 10000000;
    const MAX_REASONS = 32;
    const CONTROL_SELECTOR = 'input, select, textarea, [contenteditable], [role="textbox"], [role="searchbox"], [role="combobox"], [role="slider"], [role="spinbutton"]';
    const MEDIA_SELECTOR = 'video, audio';
    const reasons = [];
    const latch = (code) => {
      if (typeof code !== 'string' || reasons.length >= MAX_REASONS || reasons.indexOf(code) >= 0) return;
      reasons.push(code);
    };
    const readScroll = () => {
      try {
        const value = window.scrollY;
        if (typeof value !== 'number' || !isFinite(value)) return 0;
        return Math.min(MAX_SCROLL, Math.max(0, Math.round(value)));
      } catch (error) { return 0; }
    };
    const state = {
      nonce: NONCE,
      reasons: reasons,
      scrollY: readScroll(),
      shadow: false,
      observer: false,
      lastUserIntentAt: 0,
      ownScrollY: -1,
      ownScrollAt: 0,
      restoreUntil: 0,
      restoring: false,
      scanning: false
    };
    const scan = () => {
      if (state.scanning) return;
      state.scanning = true;
      try {
        try {
          if (document.designMode !== 'off') latch('design-mode');
        } catch (error) { latch('design-mode'); }
        if (typeof document.querySelector === 'function' && document.querySelector(CONTROL_SELECTOR)) latch('editable-control');
        if (typeof document.querySelectorAll === 'function') {
          const media = document.querySelectorAll(MEDIA_SELECTOR);
          const mediaLimit = Math.min(media.length, 64);
          for (let i = 0; i < mediaLimit; i++) {
            const element = media[i];
            if (element && element.paused === false && element.ended !== true) { latch('media-playing'); break; }
          }
          const all = document.querySelectorAll('*');
          if (all.length > 5000) latch('dom-too-large');
          const limit = Math.min(all.length, 5000);
          for (let i = 0; i < limit; i++) {
            const element = all[i];
            if (!element) continue;
            const name = typeof element.localName === 'string' ? element.localName : '';
            if (name.indexOf('-') > 0 || element.shadowRoot) { state.shadow = true; latch('custom-element-unknown'); break; }
          }
        }
      } catch (error) { latch('scan-failed'); }
      state.scanning = false;
    };
    const checkMedia = (scope) => {
      try {
        const media = scope.querySelectorAll(MEDIA_SELECTOR);
        const limit = Math.min(media.length, 16);
        for (let i = 0; i < limit; i++) {
          const element = media[i];
          if (element && element.paused === false && element.ended !== true) { latch('media-playing'); return; }
        }
      } catch (error) { latch('scan-failed'); }
    };
    const scanAdded = (records) => {
      try {
        if (records.length > 64) latch('dom-too-large');
        const recordLimit = Math.min(records.length, 64);
        for (let i = 0; i < recordLimit; i++) {
          const record = records[i];
          if (!record) continue;
          if (record.type === 'attributes') { scan(); continue; }
          const added = record.addedNodes;
          if (!added) continue;
          if (added.length > 64) latch('dom-too-large');
          const addedLimit = Math.min(added.length, 64);
          for (let j = 0; j < addedLimit; j++) {
            const node = added[j];
            if (!node || node.nodeType !== 1) continue;
            const name = typeof node.localName === 'string' ? node.localName : '';
            if (name.indexOf('-') > 0 || node.shadowRoot) { state.shadow = true; latch('custom-element-unknown'); }
            if (typeof node.matches === 'function' && node.matches(CONTROL_SELECTOR)) latch('editable-control');
            if (typeof node.querySelector === 'function') {
              if (node.querySelector(CONTROL_SELECTOR)) latch('editable-control');
              if (typeof node.querySelectorAll === 'function') checkMedia(node);
            }
          }
        }
      } catch (error) { latch('scan-failed'); }
    };
    scan();
    const inputTypes = ['beforeinput', 'input', 'change', 'paste', 'drop', 'submit', 'keydown', 'keypress'];
    for (let i = 0; i < inputTypes.length; i++) {
      const type = inputTypes[i];
      document.addEventListener(type, () => latch('input-' + type), { capture: true, passive: true });
    }
    document.addEventListener('scroll', () => {
      const y = readScroll();
      const now = Date.now();
      const own = state.ownScrollY >= 0 && now - state.ownScrollAt <= 250 && Math.abs(y - state.ownScrollY) <= 2;
      state.scrollY = y;
      if (!own && now < state.restoreUntil) state.lastUserIntentAt = now;
    }, { capture: true, passive: true });
    const intentTypes = ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown'];
    for (let i = 0; i < intentTypes.length; i++) {
      const type = intentTypes[i];
      document.addEventListener(type, (event) => {
        try { if (event && event.isTrusted === true) state.lastUserIntentAt = Date.now(); } catch (error) { /* 忽略 */ }
      }, { capture: true, passive: true });
    }
    try {
      const observer = new MutationObserver((records) => { scanAdded(records); });
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['contenteditable', 'designmode', 'type']
      });
      state.observer = true;
    } catch (error) { latch('observer-failed'); }
    state.scan = scan;
    Object.defineProperty(globalThis, KEY, { value: state, configurable: true, writable: false, enumerable: false });
  } catch (error) { /* 注入失败：主进程按缺少状态处理，绝不当成安全 */ }
})()`

/** 快照查询：只返回受限的纯数据（reason 码 / 布尔 / 数字），绝不返回 DOM 或文本。 */
const SNAPSHOT_SOURCE = `(() => {
  'use strict';
  try {
    const KEY = '${BRIDGE_KEY}';
    const MAX_SCROLL = 10000000;
    const MAX_REASONS = 32;
    const state = globalThis[KEY];
    if (!state || typeof state !== 'object') return { ok: false, code: 'state-missing' };
    if (typeof state.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(state.nonce)) return { ok: false, code: 'state-inconsistent' };
    if (typeof state.scan !== 'function') return { ok: false, code: 'state-inconsistent' };
    try { state.scan(); } catch (error) { return { ok: false, code: 'scan-failed' }; }
    if (!Array.isArray(state.reasons)) return { ok: false, code: 'state-inconsistent' };
    const reasons = [];
    for (let i = 0; i < state.reasons.length && reasons.length < MAX_REASONS; i++) {
      const code = state.reasons[i];
      if (typeof code !== 'string' || code.length === 0 || code.length > 48 || !/^[a-z0-9-]+$/.test(code)) return { ok: false, code: 'state-inconsistent' };
      reasons.push(code);
    }
    const top = (() => { try { return window.top === window; } catch (error) { return false; } })();
    const activation = (() => {
      try {
        const activationState = navigator.userActivation;
        return !!(activationState && activationState.hasBeenActive === true);
      } catch (error) { return false; }
    })();
    const scrollY = (() => {
      try {
        const value = window.scrollY;
        if (typeof value !== 'number' || !isFinite(value)) return 0;
        return Math.min(MAX_SCROLL, Math.max(0, Math.round(value)));
      } catch (error) { return 0; }
    })();
    return {
      ok: true,
      nonce: state.nonce,
      readyState: typeof document.readyState === 'string' ? document.readyState : '',
      top: top,
      activation: activation,
      scrollY: scrollY,
      observer: state.observer === true,
      shadow: state.shadow === true,
      reasons: reasons
    };
  } catch (error) { return { ok: false, code: 'query-failed' }; }
})()`

/**
 * 滚动恢复脚本（隔离世界）：校验 nonce、遵守“用户/网页滚动优先”的静默窗口，
 * 单次 scrollTo 并回报实际位置；主进程最多重试 3 次 / 2 秒。
 */
const RESTORE_SOURCE = `((nonce, target) => {
  'use strict';
  try {
    const KEY = '${BRIDGE_KEY}';
    const MAX_SCROLL = 10000000;
    const state = globalThis[KEY];
    if (!state || typeof state !== 'object' || state.nonce !== nonce) return { ok: false, code: 'state-mismatch' };
    const read = () => {
      try {
        const value = window.scrollY;
        if (typeof value !== 'number' || !isFinite(value)) return 0;
        return Math.min(MAX_SCROLL, Math.max(0, Math.round(value)));
      } catch (error) { return 0; }
    };
    if (state.restoring === true) return { ok: true, skipped: true, nonce: nonce, scrollY: read() };
    const now = Date.now();
    if (now - (typeof state.lastUserIntentAt === 'number' ? state.lastUserIntentAt : 0) < 1000) {
      return { ok: true, skipped: true, nonce: nonce, scrollY: read() };
    }
    state.restoring = true;
    state.ownScrollY = target;
    state.ownScrollAt = now;
    state.restoreUntil = now + 250;
    try {
      window.scrollTo({ left: window.scrollX, top: target, behavior: 'auto' });
    } catch (error) {
      try { window.scrollTo(window.scrollX, target); } catch (error2) { /* 无法滚动 */ }
    }
    const y = read();
    state.scrollY = y;
    state.restoring = false;
    return { ok: true, nonce: nonce, skipped: false, scrollY: y };
  } catch (error) { return { ok: false, code: 'restore-failed' }; }
})(${NONCE_TOKEN}, ${TARGET_TOKEN})`

function createNonce(): string {
  return randomBytes(16).toString('hex')
}

function observationSource(nonce: string): string {
  return OBSERVER_SOURCE.replace(NONCE_TOKEN, nonce)
}

function restoreSource(nonce: string, target: number): string {
  return RESTORE_SOURCE.replace(NONCE_TOKEN, JSON.stringify(nonce)).replace(TARGET_TOKEN, String(target))
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    const unref = (timer as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(timer)
  })
}

// ---------------------------------------------------------------------------
// Session 请求观察（只记录，不取消 / 不改写请求）
// ---------------------------------------------------------------------------

function dispatchToGuards(
  ses: Session,
  webContentsId: unknown,
  action: (guard: ReloadablePageGuard) => void
): void {
  const binding = sessionBindings.get(ses)
  if (!binding || typeof webContentsId !== 'number') return
  const guards = binding.guards.get(webContentsId)
  if (!guards) return
  for (const guard of guards) action(guard)
}

function registerGuard(ses: Session, guestId: number, guard: ReloadablePageGuard): void {
  const binding = sessionBindings.get(ses)
  if (!binding || typeof guestId !== 'number') return
  const existing = binding.guards.get(guestId)
  if (existing) existing.add(guard)
  else binding.guards.set(guestId, new Set([guard]))
}

function unregisterGuard(ses: Session, guestId: number, guard: ReloadablePageGuard): void {
  const binding = sessionBindings.get(ses)
  if (!binding) return
  const existing = binding.guards.get(guestId)
  if (!existing) return
  existing.delete(guard)
  if (existing.size === 0) binding.guards.delete(guestId)
}

/**
 * 在应用自有 Session 上安装**请求观察**（不是闸门）：
 * - 每个 Session 只安装一次（WeakSet 去重）；
 * - 只记录每个 guest 的请求 id / method / type，`onCompleted` / `onErrorOccurred` 释放；
 * - 不取消、不重写、不改权限 / 代理，也不读取请求体；
 * - 拒绝只读分区（否则会和只读闸门抢同一个 `onBeforeRequest`）与非持久 Session。
 *
 * 注意：Electron 的 `webRequest.onBeforeRequest` 是**单监听器** API。调用方必须只在
 * 没有既有 webRequest 监听器的 Session 上调用（`persist:webbar` 目前没有，见报告）；
 * 本模块不会清除、合并或替换任何已有监听器。
 */
export function initializeReloadableSession(ses: Session): void {
  if (!ses || typeof ses !== 'object') {
    throw new TypeError('initializeReloadableSession 需要有效的 Electron.Session')
  }
  const native = ses as unknown as GuardSession
  if (!native.webRequest || typeof native.webRequest.onBeforeRequest !== 'function') {
    throw new TypeError('initializeReloadableSession 需要带 webRequest 的 Electron.Session')
  }
  if (initializedSessions.has(ses)) return
  if (hasReadonlySession(ses)) {
    throw new Error('只读分区的 Session 不支持可重载观察（会与只读请求闸门冲突）')
  }
  if (typeof native.isPersistent === 'function' && native.isPersistent() === false) {
    throw new Error('可重载观察只接受应用自有的持久 Session，拒绝一次性分区')
  }

  const binding: SessionBinding = { guards: new Map() }
  sessionBindings.set(ses, binding)

  native.webRequest.onBeforeRequest((details, callback) => {
    try {
      if (details && typeof details === 'object') {
        const id = typeof details.id === 'number' ? details.id : null
        if (id !== null && typeof details.webContentsId === 'number' && details.webContentsId > 0) {
          dispatchToGuards(ses, details.webContentsId, (guard) => {
            guard.noteRequest(
              id,
              typeof details.method === 'string' ? details.method : '',
              typeof details.resourceType === 'string' ? details.resourceType : ''
            )
          })
        } else {
          for (const guards of binding.guards.values()) for (const guard of guards) guard.block('request-observation-unknown')
        }
      }
    } catch {
      // 观察器异常绝不能变成取消 / 阻断请求。
    }
    callback({})
  })

  native.webRequest.onCompleted?.((details) => {
    try {
      if (details && typeof details === 'object' && typeof details.id === 'number') {
        dispatchToGuards(ses, details.webContentsId, (guard) => guard.releaseRequest(details.id as number))
      }
    } catch {
      // 释放失败最多让快照保守判定，不能影响网络栈。
    }
  })

  native.webRequest.onErrorOccurred?.((details) => {
    try {
      if (details && typeof details === 'object' && typeof details.id === 'number') {
        dispatchToGuards(ses, details.webContentsId, (guard) => guard.releaseRequest(details.id as number))
      }
    } catch {
      // 同上。
    }
  })

  // 下载属于文档级阻断信号；归属不到 guest 时保守地让本 Session 内所有观察器 blocked。
  native.on?.('will-download', (...args: unknown[]) => {
    try {
      const webContents = args[2]
      const guestId =
        webContents && typeof webContents === 'object' && typeof (webContents as { id?: unknown }).id === 'number'
          ? (webContents as { id: number }).id
          : null
      if (guestId !== null) {
        dispatchToGuards(ses, guestId, (guard) => guard.noteDownload())
        return
      }
      for (const guards of binding.guards.values()) {
        for (const guard of guards) guard.noteDownload()
      }
    } catch {
      // 忽略：下载事件本身已经由浏览流程处理。
    }
  })

  initializedSessions.add(ses)
}

// ---------------------------------------------------------------------------
// 观察器
// ---------------------------------------------------------------------------

/**
 * 单个 webview guest 的可重载观察器。
 *
 * 失败方向：
 * - `blocked`：确定不允许（含可编辑控件、按键、媒体、DevTools、非 GET、下载、调用方 block）；
 * - `unknown`：无法判定（销毁 / 崩溃 / 检查抛错 / 跨文档竞态 / Service Worker / shadow DOM）。
 * 两者都不等于 safe；safe 还需要运行时显式用户同意。
 */
export class ReloadablePageGuard {
  private readonly guest: GuardGuest
  private readonly expectedSession: Session
  private guestId = 0
  private readonly state: GuardState
  private readonly teardown: Array<() => void> = []
  private sessionOk = false
  private injection: Injection | null = null

  constructor(guest: WebContents, expectedSession: Session) {
    this.guest = guest as unknown as GuardGuest
    this.expectedSession = expectedSession
    this.guestId = 0
    this.state = {
      disposed: false,
      destroyed: false,
      detached: false,
      documentSeq: 0,
      documentNonce: null,
      observerSeq: null,
      latches: new Set(),
      requests: new Set(),
      requestOverflow: false,
    }

    try {
      if (!this.guest || typeof this.guest.isDestroyed !== 'function') {
        this.latch('inspection-failed')
        return
      }
      if (this.guest.isDestroyed()) {
        this.state.destroyed = true
        return
      }
      // 只接受调用方显式传入、且已 initializeReloadableSession 的同一个 Session。
      // 本模块从不到 session.defaultSession / fromPartition 自行取 Session。
      if (!expectedSession || !initializedSessions.has(expectedSession)) {
        this.latch('session-mismatch')
        return
      }
      if (this.guest.session !== expectedSession) {
        this.latch('session-mismatch')
        return
      }
      if (typeof this.guest.id !== 'number') {
        this.latch('inspection-failed')
        return
      }
      this.guestId = this.guest.id
      this.sessionOk = true
      registerGuard(expectedSession, this.guest.id, this)
      this.installListeners()
      // 构造时文档可能已经加载完成（没有后续 dom-ready）；此时立即安装观察器。
      let loading = true
      try {
        loading = this.guest.isLoadingMainFrame()
      } catch {
        loading = true
      }
      if (!loading) void this.ensureObserver().catch(() => {})
    } catch {
      this.sessionOk = false
      this.latch('inspection-failed')
    }
  }

  /**
   * 显式阻断当前文档。`reason` 只接受有界机器码；任何自由文本都被归一为
   * `explicit-block`，避免把用户文本写进状态。
   */
  block(reason?: string): void {
    const code = typeof reason === 'string' && REASON_PATTERN.test(reason) ? reason : 'explicit-block'
    this.latch(code)
  }

  /** 观察器快照；safe 的观察结果是否仍有效由运行时决定（这里不做 TTL）。 */
  async snapshot(): Promise<ReloadableSnapshot> {
    const first = this.nativeReasons()
    if (first.length > 0) return this.decide(first)

    const seqBeforeInstall = this.state.documentSeq
    const installed = await this.ensureObserver()
    const nonce = this.state.documentNonce
    if (!installed || nonce === null) {
      // 安装失败本身不能变成 safe；把安装期间的 latch / 导航一并带出，
      // 避免“执行异常”被压成普通的 observer-not-ready。
      const failureReasons = this.nativeReasons()
      if (this.state.documentSeq !== seqBeforeInstall) {
        failureReasons.push({ code: 'navigation-during-inspection', unknown: true })
      }
      if (failureReasons.length === 0) failureReasons.push({ code: 'observer-not-ready', unknown: false })
      return this.decide(failureReasons)
    }

    const second = this.nativeReasons()
    if (second.length > 0) return this.decide(second)

    const seq = this.state.documentSeq
    const url = this.readUrl()
    if (url === null) return this.decide([{ code: 'url-not-safe', unknown: false }])

    let raw: unknown = null
    let failed = false
    try {
      raw = await this.runScript(SNAPSHOT_SOURCE)
    } catch {
      failed = true
    }

    // 回包后重新采信原生状态：等待期间的 block() / 导航 / DevTools 都不能被旧文档覆盖。
    const reasons: Reason[] = [...this.nativeReasons()]
    if (failed) reasons.push({ code: 'inspection-failed', unknown: true })
    if (this.state.documentSeq !== seq || this.state.documentNonce !== nonce) {
      reasons.push({ code: 'navigation-during-inspection', unknown: true })
    }
    if (this.readUrl() !== url) {
      reasons.push({ code: 'navigation-during-inspection', unknown: true })
    }
    if (failed) return this.decide(reasons)

    const page = this.readPageState(raw, nonce)
    reasons.push(...page.reasons)
    if (reasons.length > 0) {
      const result = this.decide(reasons)
      // 新恢复的文档尚未被点击，不可再次休眠；这不应阻止已绑定 nonce 的滚动恢复。
      if (reasons.every(reason => reason.code === 'no-user-activation')) return { ...result, url, documentNonce: nonce, scrollY: page.scrollY }
      return result
    }

    return {
      decision: 'safe',
      reasonCodes: [],
      url,
      documentNonce: nonce,
      scrollY: page.scrollY,
    }
  }

  /**
   * 受限滚动恢复：最多 3 次 / 2 秒，只作用于同一 nonce 的当前文档。
   * 用户或网页自己的滚动优先（隔离世界里的静默窗口），任何导航都立即终止。
   */
  async restoreScroll(documentNonce: string, y: number): Promise<void> {
    if (typeof documentNonce !== 'string' || !NONCE_PATTERN.test(documentNonce)) return
    if (typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > MAX_SCROLL_Y) return
    const target = Math.round(y)
    if (this.state.disposed || this.state.destroyed) return
    if (this.state.documentNonce !== documentNonce) return
    const seq = this.state.documentSeq
    const url = this.readUrl()
    if (url === null) return

    const deadline = Date.now() + RESTORE_MAX_DURATION_MS
    let attempts = 0
    for (const delay of RESTORE_ATTEMPT_DELAYS_MS) {
      if (delay > 0) await wait(delay)
      if (this.state.disposed || this.state.destroyed) return
      if (this.state.documentSeq !== seq || this.state.documentNonce !== documentNonce || this.readUrl() !== url) return
      if (Date.now() > deadline) return
      if (attempts >= RESTORE_MAX_ATTEMPTS) return
      attempts += 1

      let raw: unknown = null
      let failed = false
      try {
        raw = await this.runScript(restoreSource(documentNonce, target), Math.max(1, deadline - Date.now()))
      } catch {
        failed = true
      }
      if (this.state.disposed || this.state.destroyed) return
      if (this.state.documentSeq !== seq || this.state.documentNonce !== documentNonce || this.readUrl() !== url) return
      if (failed) return
      const result = readRestoreResult(raw, documentNonce)
      if (result === null) return
      if (result.skipped) return
      if (Math.abs(result.scrollY - target) <= RESTORE_TOLERANCE_PX) return
    }
  }

  dispose(): void {
    if (this.state.disposed) return
    this.state.disposed = true
    this.state.observerSeq = null
    this.detach()
  }

  // -------------------------------------------------------------------------
  // Session 路由入口（@internal）
  // -------------------------------------------------------------------------

  /** @internal 仅由 Session 的 onBeforeRequest 观察器调用。 */
  noteRequest(id: number, method: string, resourceType: string): void {
    if (this.state.disposed || this.state.destroyed) return
    if (method.toUpperCase() !== 'GET') this.latch('non-get-request')
    if (resourceType.toLowerCase() === 'websocket') this.latch('websocket')
    if (!Number.isFinite(id)) return
    if (this.state.requests.has(id)) return
    if (this.state.requests.size >= MAX_PENDING_REQUESTS) {
      this.latch('request-overflow')
      return
    }
    this.state.requests.add(id)
  }

  /** @internal 仅由 Session 的 onCompleted / onErrorOccurred 观察器调用。 */
  releaseRequest(id: number): void {
    this.state.requests.delete(id)
  }

  /** @internal 仅由 Session 的 will-download 观察器调用。 */
  noteDownload(): void {
    this.latch('download')
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private latch(code: string): void {
    if (!REASON_PATTERN.test(code)) return
    if (this.state.latches.size >= MAX_LATCHES) return
    this.state.latches.add(code)
  }

  private readUrl(): string | null {
    try {
      const url = this.guest.getURL()
      return typeof url === 'string' ? url : null
    } catch {
      return null
    }
  }

  private sessionMatches(): boolean {
    if (!this.sessionOk) return false
    try {
      return this.guest.session === this.expectedSession && initializedSessions.has(this.expectedSession)
    } catch {
      return false
    }
  }

  private nativeReasons(): Reason[] {
    const reasons: Reason[] = []
    if (this.state.disposed) reasons.push({ code: 'guard-disposed', unknown: false })
    if (this.state.destroyed) {
      reasons.push({ code: 'guest-destroyed', unknown: true })
      return reasons
    }
    try {
      if (this.guest.isDestroyed()) {
        reasons.push({ code: 'guest-destroyed', unknown: true })
        return reasons
      }
    } catch {
      reasons.push({ code: 'inspection-failed', unknown: true })
      return reasons
    }

    if (!this.sessionMatches()) reasons.push({ code: 'session-mismatch', unknown: false })

    const url = this.readUrl()
    // URL 安全判定复用共享校验：只接受无 query / hash / userinfo / 敏感路径的 http(s)。
    if (url === null || shelfWebUrl(url) === undefined) reasons.push({ code: 'url-not-safe', unknown: false })

    try {
      if (this.guest.isLoadingMainFrame()) reasons.push({ code: 'page-loading', unknown: false })
      if (this.guest.isCrashed()) reasons.push({ code: 'renderer-crashed', unknown: true })
      if (this.guest.isCurrentlyAudible()) reasons.push({ code: 'page-audible', unknown: false })
      if (this.guest.isDevToolsOpened()) reasons.push({ code: 'devtools-open', unknown: false })
      if (this.guest.debugger?.isAttached?.() === true) reasons.push({ code: 'devtools-open', unknown: false })

      const frames = this.guest.mainFrame?.framesInSubtree
      if (!Array.isArray(frames)) reasons.push({ code: 'inspection-failed', unknown: true })
      else if (frames.length > 1) reasons.push({ code: 'subframe-present', unknown: false })
    } catch {
      reasons.push({ code: 'inspection-failed', unknown: true })
    }

    for (const code of this.state.latches) {
      reasons.push({ code, unknown: UNKNOWN_REASON_CODES.has(code) })
    }
    if (this.state.requests.size > 0) reasons.push({ code: 'request-pending', unknown: false })

    // Service Worker 无法按文档归属：Session 内只要有运行中的 worker 就保守 unknown。
    // `getAllRunning()` 在 Electron 43 是同步的；若变成 Promise（未知版本）则不能当空表。
    try {
      const serviceWorkers = this.expectedSession.serviceWorkers
      if (!serviceWorkers || typeof serviceWorkers.getAllRunning !== 'function') {
        reasons.push({ code: 'service-worker-unknown', unknown: true })
      } else {
        const running = serviceWorkers.getAllRunning()
        if (running && typeof (running as unknown as PromiseLike<unknown>).then === 'function') {
          reasons.push({ code: 'service-worker-unknown', unknown: true })
        } else if (!running || typeof running !== 'object' || Object.keys(running).length > 0) {
          reasons.push({ code: 'service-worker-active', unknown: true })
        }
      }
    } catch {
      reasons.push({ code: 'service-worker-unknown', unknown: true })
    }

    return reasons
  }

  private readPageState(raw: unknown, expectedNonce: string): { reasons: Reason[]; scrollY: number } {
    const inconsistent = (): { reasons: Reason[]; scrollY: number } => ({
      reasons: [{ code: 'state-inconsistent', unknown: true }],
      scrollY: 0,
    })
    if (!raw || typeof raw !== 'object') return inconsistent()
    const value = raw as Record<string, unknown>
    if (value.ok !== true) {
      const code = typeof value.code === 'string' && REASON_PATTERN.test(value.code) ? value.code : 'state-inconsistent'
      return { reasons: [{ code, unknown: true }], scrollY: 0 }
    }
    if (value.nonce !== expectedNonce) return inconsistent()
    if (typeof value.scrollY !== 'number' || !Number.isFinite(value.scrollY)) return inconsistent()
    const scrollY = Math.min(MAX_SCROLL_Y, Math.max(0, Math.round(value.scrollY)))
    const rawReasons = value.reasons
    if (!Array.isArray(rawReasons) || rawReasons.length > MAX_STATE_REASONS) return inconsistent()

    const reasons: Reason[] = []
    for (const code of rawReasons) {
      if (typeof code !== 'string' || !REASON_PATTERN.test(code)) return inconsistent()
      reasons.push({ code, unknown: UNKNOWN_REASON_CODES.has(code) })
    }

    if (value.readyState !== 'complete') reasons.push({ code: 'document-not-ready', unknown: false })
    if (value.top !== true) reasons.push({ code: 'not-top-frame', unknown: false })
    // beforeunload 必须“可触发”：没有粘性用户激活时，reload 可能被浏览器直接忽略。
    if (value.activation !== true) reasons.push({ code: 'no-user-activation', unknown: false })
    if (value.observer !== true) reasons.push({ code: 'observer-not-ready', unknown: false })
    if (value.shadow === true && !reasons.some((reason) => reason.code === 'custom-element-unknown')) {
      reasons.push({ code: 'custom-element-unknown', unknown: true })
    }
    return { reasons, scrollY }
  }

  private decide(reasons: Reason[]): ReloadableSnapshot {
    const codes: string[] = []
    const seen = new Set<string>()
    let blocked = false
    let unknown = false
    for (const reason of reasons) {
      if (reason.unknown) unknown = true
      else blocked = true
      if (seen.has(reason.code)) continue
      seen.add(reason.code)
      if (codes.length < MAX_REASON_CODES) codes.push(reason.code)
    }
    return {
      decision: blocked ? 'blocked' : unknown ? 'unknown' : 'safe',
      reasonCodes: codes,
    }
  }

  private installListeners(): void {
    // 主框架完整文档导航：换代 + 清空上一个文档的 latch / 请求（latch 语义只到下一次
    // 原生完整导航为止；页面自己“移除控件”不解除）。
    const onStartNavigation = (...args: unknown[]): void => {
      if (this.state.disposed || this.state.destroyed) return
      const details = args[0] && typeof args[0] === 'object' ? (args[0] as Record<string, unknown>) : null
      const mainFrame = details?.isMainFrame === true || args[3] === true
      if (!mainFrame) return
      const inPlace = details?.isInPlace === true || args[2] === true
      if (inPlace) return
      this.state.documentSeq += 1
      this.state.documentNonce = null
      this.state.observerSeq = null
      this.state.latches.clear()
      this.state.requests.clear()
      this.state.requestOverflow = false
    }
    this.listen('did-start-navigation', onStartNavigation)

    const onReady = (): void => {
      if (this.state.disposed || this.state.destroyed) return
      void this.ensureObserver().catch(() => {})
    }
    this.listen('dom-ready', onReady)
    this.listen('did-finish-load', onReady)

    const onRenderGone = (): void => {
      this.state.observerSeq = null
      this.latch('renderer-gone')
    }
    this.listen('render-process-gone', onRenderGone)

    // DevTools / debugger 改动当前文档后，关闭检查器也不能证明改动撤回：本导航内永久 blocked。
    const onDevTools = (): void => {
      this.latch('devtools-open')
    }
    this.listen('devtools-opened', onDevTools)
    try {
      const debuggerApi = this.guest.debugger
      if (debuggerApi && typeof debuggerApi.on === 'function') {
        debuggerApi.on('attach', onDevTools)
        debuggerApi.on('detach', onDevTools)
        this.teardown.push(() => {
          try {
            debuggerApi.removeListener?.('attach', onDevTools)
            debuggerApi.removeListener?.('detach', onDevTools)
          } catch {
            // 已销毁
          }
        })
      }
    } catch {
      // 取不到 debugger 时不额外阻断：isDevToolsOpened 仍会检查。
    }

    // 只检查 input.type，绝不读取 key / code / 文本值。鼠标 / 滚动不算文本输入。
    const onBeforeInput = (...args: unknown[]): void => {
      const input = args[1]
      const type =
        input && typeof input === 'object' && typeof (input as { type?: unknown }).type === 'string'
          ? (input as { type: string }).type
          : ''
      if (type !== '' && /^(mouse|scroll|gesture)/i.test(type)) return
      this.latch('key-input')
    }
    this.listen('before-input-event', onBeforeInput)

    const onMedia = (): void => {
      this.latch('media-playing')
    }
    this.listen('media-started-playing', onMedia)

    // 不调用 preventDefault：Electron 里那等于放行卸载；也不能删除网页自己的 beforeunload。
    const onPreventUnload = (): void => {
      this.latch('unload-prevented')
    }
    this.listen('will-prevent-unload', onPreventUnload)

    this.listen('destroyed', () => this.handleDestroyed())
  }

  private listen(event: string, handler: (...args: unknown[]) => void): void {
    try {
      this.guest.on(event, handler)
      this.teardown.push(() => {
        try {
          this.guest.removeListener(event, handler)
        } catch {
          // 已销毁
        }
      })
    } catch {
      this.latch('listener-failed')
    }
  }

  private async ensureObserver(): Promise<boolean> {
    if (this.state.disposed || this.state.destroyed || !this.sessionOk) return false
    const seq = this.state.documentSeq
    if (this.state.observerSeq === seq && this.state.documentNonce !== null) return true
    if (this.injection !== null && this.injection.seq === seq) return this.injection.promise

    const nonce = this.state.documentNonce ?? createNonce()
    if (!NONCE_PATTERN.test(nonce)) return false
    this.state.documentNonce = nonce
    const promise = this.injectObserver(seq, nonce)
    this.injection = { seq, promise }
    try {
      return await promise
    } finally {
      if (this.injection !== null && this.injection.promise === promise) this.injection = null
    }
  }

  private async injectObserver(seq: number, nonce: string): Promise<boolean> {
    try {
      await this.runScript(observationSource(nonce))
    } catch {
      this.latch('observer-failed')
      return false
    }
    if (this.state.disposed || this.state.destroyed) return false
    if (this.state.documentSeq !== seq || this.state.documentNonce !== nonce) return false
    this.state.observerSeq = seq
    return true
  }

  private runScript(code: string, budgetMs = 2000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        // 超时之后本导航保活，避免对无响应 renderer 不断堆积原生执行请求。
        this.latch('inspection-timeout')
        reject(new Error('Isolated document inspection timed out'))
      }, budgetMs)
      timer.unref?.()
      void Promise.resolve().then(() => this.guest.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }])).then(value => {
        if (settled) return
        settled = true; clearTimeout(timer); resolve(value)
      }, error => {
        if (settled) return
        settled = true; clearTimeout(timer); reject(error)
      })
    })
  }

  private handleDestroyed(): void {
    this.state.destroyed = true
    this.state.observerSeq = null
    this.detach()
  }

  private detach(): void {
    if (this.state.detached) return
    this.state.detached = true
    for (const teardown of this.teardown.splice(0)) teardown()
    if (this.sessionOk) unregisterGuard(this.expectedSession, this.guestId, this)
    this.state.requests.clear()
  }
}

function readRestoreResult(raw: unknown, nonce: string): { skipped: boolean; scrollY: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.ok !== true) return null
  if (value.nonce !== nonce) return null
  if (typeof value.scrollY !== 'number' || !Number.isFinite(value.scrollY)) return null
  return {
    skipped: value.skipped === true,
    scrollY: Math.min(MAX_SCROLL_Y, Math.max(0, Math.round(value.scrollY))),
  }
}
