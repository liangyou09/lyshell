import { describe, expect, it, vi } from 'vitest'
import type { Session, WebContents, WebPreferences } from 'electron'
import {
  READONLY_CHANNELS,
  READONLY_CSP,
  READONLY_PARTITION,
  READONLY_PERMISSIONS_POLICY,
  READONLY_PROVIDER,
  applyReadonlyPreferences,
  classifyReadonlyRequest,
  hasReadonlySession,
  initializeReadonlySession,
  isReadonlyGuest,
  readonlyProtection,
  withReadonlyHeaders,
} from './shelf-readonly-contract'

// ---------------------------------------------------------------------------
// 原生 API mock：只实现契约用到的表面，验证“主进程原生检查”而不是 UI。
// ---------------------------------------------------------------------------

interface BeforeRequestDetails {
  url: string
  method: string
  resourceType: string
}

type BeforeRequestCallback = (response: { cancel?: boolean }) => void
type BeforeRequestHandler = (
  details: BeforeRequestDetails,
  callback: BeforeRequestCallback
) => void

interface HeadersDetails {
  responseHeaders?: Record<string, string | string[]>
  resourceType?: string
  statusCode?: number
}

type HeadersCallback = (response: { responseHeaders?: Record<string, string | string[]>; cancel?: boolean }) => void
type HeadersHandler = (details: HeadersDetails, callback: HeadersCallback) => void

type PermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void
) => void
type PermissionCheckHandler = () => boolean
type DisplayMediaHandler = (
  request: unknown,
  callback: (streams: Record<string, unknown>) => void
) => void
type DownloadHandler = (event: { preventDefault: () => void }) => void

interface SessionMock {
  session: Session
  beforeRequest: BeforeRequestHandler[]
  headersReceived: HeadersHandler[]
  permissionRequests: PermissionRequestHandler[]
  permissionChecks: PermissionCheckHandler[]
  devicePermissions: PermissionCheckHandler[]
  displayMedia: DisplayMediaHandler[]
  spellChecker: boolean[]
  downloads: DownloadHandler[]
}

function createSessionMock(persistent = false): SessionMock {
  const mock: SessionMock = {
    session: undefined as unknown as Session,
    beforeRequest: [],
    headersReceived: [],
    permissionRequests: [],
    permissionChecks: [],
    devicePermissions: [],
    displayMedia: [],
    spellChecker: [],
    downloads: [],
  }

  const session = {
    isPersistent: () => persistent,
    webRequest: {
      onBeforeRequest: (handler: BeforeRequestHandler) => {
        mock.beforeRequest.push(handler)
      },
      onHeadersReceived: (handler: HeadersHandler) => {
        mock.headersReceived.push(handler)
      },
    },
    setPermissionRequestHandler: (handler: PermissionRequestHandler) => {
      mock.permissionRequests.push(handler)
    },
    setPermissionCheckHandler: (handler: PermissionCheckHandler) => {
      mock.permissionChecks.push(handler)
    },
    setDevicePermissionHandler: (handler: PermissionCheckHandler) => {
      mock.devicePermissions.push(handler)
    },
    setDisplayMediaRequestHandler: (handler: DisplayMediaHandler) => {
      mock.displayMedia.push(handler)
    },
    setSpellCheckerEnabled: (enabled: boolean) => {
      mock.spellChecker.push(enabled)
    },
    on: (event: string, handler: DownloadHandler) => {
      if (event === 'will-download') mock.downloads.push(handler)
    },
  }

  mock.session = session as unknown as Session
  return mock
}

function createInitializedSession(): SessionMock {
  const mock = createSessionMock()
  initializeReadonlySession(mock.session)
  return mock
}

interface GuestState {
  destroyed: boolean
  devToolsOpened: boolean
  loadingMainFrame: boolean
  audible: boolean
  crashed: boolean
}

interface GuestMock {
  guest: WebContents
  state: GuestState
}

function readonlyPreferences(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    partition: READONLY_PARTITION,
    javascript: true,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    ...overrides,
  }
}

function createGuest(
  session: Session,
  preferences: Record<string, unknown> | null,
  overrides: Partial<GuestState> = {}
): GuestMock {
  const state: GuestState = {
    destroyed: false,
    devToolsOpened: false,
    loadingMainFrame: false,
    audible: false,
    crashed: false,
    ...overrides,
  }

  const guest = {
    session,
    isDestroyed: () => state.destroyed,
    isDevToolsOpened: () => state.devToolsOpened,
    isLoadingMainFrame: () => state.loadingMainFrame,
    isCurrentlyAudible: () => state.audible,
    isCrashed: () => state.crashed,
    getLastWebPreferences: () => preferences,
  }

  return { guest: guest as unknown as WebContents, state }
}

function requestDecision(
  handler: BeforeRequestHandler,
  details: BeforeRequestDetails
): { cancel?: boolean } {
  let response: { cancel?: boolean } = {}
  handler(details, (value) => {
    response = value
  })
  return response
}

function responseHeadersAfter(
  handler: HeadersHandler,
  responseHeaders?: Record<string, string | string[]>
): Record<string, string | string[]> {
  let response: { responseHeaders?: Record<string, string | string[]> } = {}
  handler({ responseHeaders }, (value) => {
    response = value
  })
  return response.responseHeaders ?? {}
}

// ---------------------------------------------------------------------------

describe('只读契约常量', () => {
  it('使用内存态专用分区，而不是 persist: 前缀', () => {
    expect(READONLY_PARTITION).toBe('shelf-readonly-v1')
    expect(READONLY_PARTITION.startsWith('persist:')).toBe(false)
    expect(READONLY_PROVIDER).toBe('app:readonly-v1')
  })

  it('固定 IPC 通道名，preload 与主进程必须一致', () => {
    expect(READONLY_CHANNELS).toEqual({
      attach: 'shelf-browser:attach',
      blocked: 'shelf-browser:readonly-blocked',
      scrollCommand: 'shelf-browser:scroll',
      scrollTelemetry: 'shelf-browser:readonly-scroll',
    })
  })

  it('CSP 关闭脚本/子框架/连接/表单/worker，并保留同源渲染', () => {
    expect(READONLY_CSP).toContain('sandbox allow-same-origin')
    expect(READONLY_CSP).toContain("script-src 'none'")
    expect(READONLY_CSP).toContain("object-src 'none'")
    expect(READONLY_CSP).toContain("frame-src 'none'")
    expect(READONLY_CSP).toContain("worker-src 'none'")
    expect(READONLY_CSP).toContain("connect-src 'none'")
    expect(READONLY_CSP).toContain("form-action 'none'")
    expect(READONLY_CSP).toContain("base-uri 'none'")
    expect(READONLY_PERMISSIONS_POLICY).toBe(
      'camera=(), microphone=(), geolocation=(), display-capture=()'
    )
  })
})

describe('classifyReadonlyRequest：请求闸门', () => {
  it('放行 http(s) + GET + mainFrame/stylesheet/image/font', () => {
    for (const resourceType of ['mainFrame', 'stylesheet', 'image', 'font']) {
      expect(
        classifyReadonlyRequest({
          url: 'https://example.com/docs',
          method: 'GET',
          resourceType,
        })
      ).toEqual({ allowed: true })
    }
    expect(
      classifyReadonlyRequest({
        url: 'http://example.com/',
        method: 'GET',
        resourceType: 'mainFrame',
      })
    ).toEqual({ allowed: true })
  })

  it('拒绝一切非 GET 请求', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(
        classifyReadonlyRequest({
          url: 'https://example.com/',
          method,
          resourceType: 'mainFrame',
        })
      ).toEqual({ allowed: false, reason: 'method' })
    }
  })

  it('拒绝脚本 / XHR / 媒体 / 对象 / 子框架 / WebSocket / 其他资源类型', () => {
    for (const resourceType of [
      'script',
      'xhr',
      'media',
      'object',
      'subFrame',
      'webSocket',
      'other',
      'ping',
      'cspReport',
      'unexpected',
    ]) {
      expect(
        classifyReadonlyRequest({
          url: 'https://example.com/a',
          method: 'GET',
          resourceType,
        })
      ).toEqual({ allowed: false, reason: 'resource-type' })
    }
  })

  it('拒绝无法解析的 URL', () => {
    for (const url of ['http://[::1', 'https://exa mple.com/', 'not a url']) {
      expect(
        classifyReadonlyRequest({ url, method: 'GET', resourceType: 'mainFrame' })
      ).toEqual({ allowed: false, reason: 'malformed-url' })
    }
  })

  it('只允许 http(s)，拒绝 file/data/javascript/blob/about 等协议', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/a.css',
      'data:text/html,<h1>hi</h1>',
      'javascript:alert(1)',
      'about:blank',
      'blob:https://example.com/0000',
    ]) {
      expect(
        classifyReadonlyRequest({ url, method: 'GET', resourceType: 'mainFrame' })
      ).toEqual({ allowed: false, reason: 'scheme' })
    }
  })

  it('拒绝 URL 内嵌凭据（含子资源）', () => {
    expect(
      classifyReadonlyRequest({
        url: 'https://user:secret@example.com/',
        method: 'GET',
        resourceType: 'mainFrame',
      })
    ).toEqual({ allowed: false, reason: 'credentials' })
    expect(
      classifyReadonlyRequest({
        url: 'https://user:secret@cdn.example.com/a.css',
        method: 'GET',
        resourceType: 'stylesheet',
      })
    ).toEqual({ allowed: false, reason: 'credentials' })
  })

  it('拒绝 mainFrame 的敏感 query（键名大小写与分隔符不敏感）', () => {
    for (const url of [
      'https://example.com/?token=abc',
      'https://example.com/?access_token=abc',
      'https://example.com/?API-KEY=abc',
      'https://example.com/?Password=abc',
      'https://example.com/?client_secret=abc',
      'https://example.com/?signature=abc',
      'https://example.com/?session_id=abc',
    ]) {
      expect(
        classifyReadonlyRequest({ url, method: 'GET', resourceType: 'mainFrame' })
      ).toEqual({ allowed: false, reason: 'query-sensitive' })
    }
  })

  it('普通 query 也拒绝，避免隐含一次性操作', () => {
    expect(
      classifyReadonlyRequest({
        url: 'https://example.com/docs?page=2&sort=asc&q=readonly',
        method: 'GET',
        resourceType: 'mainFrame',
      })
    ).toEqual({ allowed: false, reason: 'query-sensitive' })
  })

  it('mainFrame 的敏感 hash 和普通锚点均拒绝', () => {
    for (const url of [
      'https://example.com/#access_token=abc',
      'https://example.com/#token=abc',
    ]) {
      expect(
        classifyReadonlyRequest({ url, method: 'GET', resourceType: 'mainFrame' })
      ).toEqual({ allowed: false, reason: 'hash-sensitive' })
    }
    expect(
      classifyReadonlyRequest({
        url: 'https://example.com/docs#section-2',
        method: 'GET',
        resourceType: 'mainFrame',
      })
    ).toEqual({ allowed: false, reason: 'hash-sensitive' })
  })

  it('子资源允许带签名 query（只有 mainFrame 检查敏感键）', () => {
    expect(
      classifyReadonlyRequest({
        url: 'https://cdn.example.com/a.css?token=cdn-signed',
        method: 'GET',
        resourceType: 'stylesheet',
      })
    ).toEqual({ allowed: true })
  })
})

describe('withReadonlyHeaders：响应头加固', () => {
  it('无响应头时新建独立 CSP 与 Permissions-Policy', () => {
    const headers = withReadonlyHeaders(undefined)
    expect(headers['content-security-policy']).toEqual([READONLY_CSP])
    expect(headers['permissions-policy']).toEqual([READONLY_PERMISSIONS_POLICY])
  })

  it('保留站点原有 CSP，并追加一条独立的值', () => {
    const original = { 'content-security-policy': ["default-src 'self'"], 'x-other': ['1'] }
    const headers = withReadonlyHeaders(original)
    expect(headers['content-security-policy']).toEqual(["default-src 'self'", READONLY_CSP])
    expect(headers['x-other']).toEqual(['1'])
    // 不修改入参
    expect(original['content-security-policy']).toEqual(["default-src 'self'"])
  })

  it('大小写不同的已有头不被覆盖、也不重复新增', () => {
    const headers = withReadonlyHeaders({
      'Content-Security-Policy': ["default-src 'none'"],
      'Permissions-Policy': ['camera=(self)'],
    })
    expect(headers['Content-Security-Policy']).toEqual(["default-src 'none'", READONLY_CSP])
    expect(headers['Permissions-Policy']).toEqual([
      'camera=(self)',
      READONLY_PERMISSIONS_POLICY,
    ])
    expect(Object.keys(headers).filter((key) => key.toLowerCase() === 'content-security-policy'))
      .toHaveLength(1)
    expect(Object.keys(headers).filter((key) => key.toLowerCase() === 'permissions-policy'))
      .toHaveLength(1)
  })

  it('单字符串形式的既有头也归一化为数组后再追加', () => {
    const headers = withReadonlyHeaders({ 'content-security-policy': 'default-src none' })
    expect(headers['content-security-policy']).toEqual(['default-src none', READONLY_CSP])
  })

  it('只缺 Permissions-Policy 时同时补齐两者', () => {
    const headers = withReadonlyHeaders({ 'Permissions-Policy': ['geolocation=()'] })
    expect(headers['Permissions-Policy']).toEqual([
      'geolocation=()',
      READONLY_PERMISSIONS_POLICY,
    ])
    expect(headers['content-security-policy']).toEqual([READONLY_CSP])
  })
})

describe('initializeReadonlySession：会话加固', () => {
  it('每个 Session 只安装一次闸门', () => {
    const mock = createSessionMock()
    initializeReadonlySession(mock.session)
    initializeReadonlySession(mock.session)
    initializeReadonlySession(mock.session)
    expect(mock.beforeRequest).toHaveLength(1)
    expect(mock.headersReceived).toHaveLength(1)
    expect(mock.permissionRequests).toHaveLength(1)
    expect(mock.downloads).toHaveLength(1)
    expect(hasReadonlySession(mock.session)).toBe(true)
  })

  it('不同 Session 各自独立安装', () => {
    const first = createInitializedSession()
    const second = createInitializedSession()
    expect(first.beforeRequest).toHaveLength(1)
    expect(second.beforeRequest).toHaveLength(1)
    expect(first.beforeRequest[0]).not.toBe(second.beforeRequest[0])
    expect(hasReadonlySession(first.session)).toBe(true)
    expect(hasReadonlySession(second.session)).toBe(true)
  })

  it('拒绝持久化分区，且不安装任何处理器', () => {
    const mock = createSessionMock(true)
    expect(() => initializeReadonlySession(mock.session)).toThrow(/一次性隔离分区/)
    expect(mock.beforeRequest).toHaveLength(0)
    expect(mock.headersReceived).toHaveLength(0)
    expect(hasReadonlySession(mock.session)).toBe(false)
  })

  it('拒绝空 Session', () => {
    expect(() => initializeReadonlySession(undefined as unknown as Session)).toThrow(TypeError)
  })

  it('闸门实际拦截脚本与 POST，放行文档请求', () => {
    const mock = createInitializedSession()
    const handler = mock.beforeRequest[0]
    expect(
      requestDecision(handler, {
        url: 'https://example.com/app.js',
        method: 'GET',
        resourceType: 'script',
      })
    ).toEqual({ cancel: true })
    expect(
      requestDecision(handler, {
        url: 'https://example.com/',
        method: 'POST',
        resourceType: 'mainFrame',
      })
    ).toEqual({ cancel: true })
    expect(
      requestDecision(handler, {
        url: 'https://example.com/',
        method: 'GET',
        resourceType: 'mainFrame',
      })
    ).toEqual({})
  })

  it('响应头钩子追加只读 CSP', () => {
    const mock = createInitializedSession()
    const headers = responseHeadersAfter(mock.headersReceived[0], {
      'content-security-policy': ["default-src 'self'"],
    })
    expect(headers['content-security-policy']).toEqual(["default-src 'self'", READONLY_CSP])
    expect(headers['permissions-policy']).toEqual([READONLY_PERMISSIONS_POLICY])
  })
  it('主文档只接受 HTML/纯文本，拒绝 PDF、SVG、下载和未知类型', () => {
    const mock = createInitializedSession()
    for (const mime of ['application/pdf', 'image/svg+xml', 'application/octet-stream', '']) {
      let cancelled = false
      mock.headersReceived[0]({ resourceType: 'mainFrame', statusCode: 200, responseHeaders: { 'Content-Type': [mime] } }, result => { cancelled = result.cancel === true })
      expect(cancelled).toBe(true)
    }
    let headers: Record<string, string | string[]> | undefined
    mock.headersReceived[0]({ resourceType: 'mainFrame', statusCode: 200, responseHeaders: { 'content-type': ['text/html; charset=utf-8'] } }, result => { headers = result.responseHeaders })
    expect(headers?.['content-security-policy']).toContain(READONLY_CSP)
  })
  it('部分初始化失败不登记可信契约', () => {
    const mock = createSessionMock()
    vi.spyOn(mock.session, 'setPermissionCheckHandler').mockImplementation(() => { throw Error('native failure') })
    expect(() => initializeReadonlySession(mock.session)).toThrow('native failure')
    expect(hasReadonlySession(mock.session)).toBe(false)
  })

  it('拒绝全部权限、显示捕获、下载与拼写检查', () => {
    const mock = createInitializedSession()

    let permissionGranted: boolean | undefined
    mock.permissionRequests[0](null, 'media', (granted) => {
      permissionGranted = granted
    })
    expect(permissionGranted).toBe(false)

    expect(mock.permissionChecks[0]()).toBe(false)
    expect(mock.devicePermissions[0]()).toBe(false)

    let streams: Record<string, unknown> | undefined
    mock.displayMedia[0](null, (value) => {
      streams = value
    })
    expect(streams).toEqual({})

    const preventDefault = vi.fn()
    mock.downloads[0]({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)

    expect(mock.spellChecker).toEqual([false])
  })
})

describe('applyReadonlyPreferences：WebPreferences 加固', () => {
  it('强制只读开关，覆盖调用方的敌意配置', () => {
    const preferences = {
      javascript: true,
      plugins: true,
      disableDialogs: false,
      spellcheck: true,
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      webviewTag: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
      navigateOnDragDrop: true,
      experimentalFeatures: true,
      partition: 'persist:evil',
      preload: '/tmp/evil.js',
      additionalArguments: ['--foo'],
      zoomFactor: 1.5,
    } as unknown as WebPreferences

    applyReadonlyPreferences(preferences)

    expect(preferences.javascript).toBe(true)
    expect(preferences.plugins).toBe(false)
    expect(preferences.disableDialogs).toBe(true)
    expect(preferences.spellcheck).toBe(false)
    expect(preferences.sandbox).toBe(true)
    expect(preferences.contextIsolation).toBe(true)
    expect(preferences.nodeIntegration).toBe(false)
    expect(preferences.nodeIntegrationInSubFrames).toBe(false)
    expect(preferences.nodeIntegrationInWorker).toBe(false)
    expect(preferences.webviewTag).toBe(false)
    expect(preferences.webSecurity).toBe(true)
    expect(preferences.allowRunningInsecureContent).toBe(false)
    expect(preferences.navigateOnDragDrop).toBe(false)
    expect(preferences.experimentalFeatures).toBe(false)
    expect(preferences.partition).toBe(READONLY_PARTITION)
  })

  it('保留调用方的 preload 与附加参数（只读 preload 由主进程注入）', () => {
    const preferences = {
      preload: '/tmp/shelf-readonly.js',
      additionalArguments: ['--lyshell-shelf-permit=abc'],
      zoomFactor: 0.9,
    } as WebPreferences

    applyReadonlyPreferences(preferences)

    expect(preferences.preload).toBe('/tmp/shelf-readonly.js')
    expect(preferences.additionalArguments).toEqual(['--lyshell-shelf-permit=abc'])
    expect(preferences.zoomFactor).toBe(0.9)
  })
})

describe('isReadonlyGuest：契约校验', () => {
  it('已初始化分区 + 安全 WebPreferences 才为 true', () => {
    const mock = createInitializedSession()
    const { guest } = createGuest(mock.session, readonlyPreferences())
    expect(isReadonlyGuest(guest)).toBe(true)
  })

  it('分区未初始化时即使字符串一致也返回 false', () => {
    const mock = createSessionMock()
    const { guest } = createGuest(mock.session, readonlyPreferences())
    expect(isReadonlyGuest(guest)).toBe(false)
  })

  it('已销毁的 guest 返回 false', () => {
    const mock = createInitializedSession()
    const { guest } = createGuest(mock.session, readonlyPreferences(), { destroyed: true })
    expect(isReadonlyGuest(guest)).toBe(false)
  })

  it('任一安全开关被破坏都返回 false', () => {
    const mock = createInitializedSession()
    for (const overrides of [
      { javascript: false },
      { sandbox: false },
      { contextIsolation: false },
      { nodeIntegration: true },
      { nodeIntegrationInSubFrames: true },
      { webviewTag: true },
      { partition: 'persist:shelf-readonly-v1' },
      { partition: 'persist:other' },
    ]) {
      const { guest } = createGuest(mock.session, readonlyPreferences(overrides))
      expect(isReadonlyGuest(guest)).toBe(false)
    }
  })

  it('partition 缺失时仍以 Session 身份为准', () => {
    const mock = createInitializedSession()
    const { guest } = createGuest(mock.session, { ...readonlyPreferences(), partition: undefined })
    expect(isReadonlyGuest(guest)).toBe(true)
  })

  it('缺少 getLastWebPreferences 探针时 fail closed', () => {
    const mock = createInitializedSession()
    const guest = {
      session: mock.session,
      isDestroyed: () => false,
    } as unknown as WebContents
    expect(isReadonlyGuest(guest)).toBe(false)
  })

  it('探针抛错或返回 null 时 fail closed', () => {
    const mock = createInitializedSession()
    const throwing = {
      session: mock.session,
      isDestroyed: () => false,
      getLastWebPreferences: () => {
        throw new Error('boom')
      },
    } as unknown as WebContents
    expect(isReadonlyGuest(throwing)).toBe(false)

    const { guest } = createGuest(mock.session, null)
    expect(isReadonlyGuest(guest)).toBe(false)
  })
})

describe('readonlyProtection：原生只读保护判定', () => {
  it('契约核实且原生状态干净时才返回 safe', () => {
    const mock = createInitializedSession()
    const { guest } = createGuest(mock.session, readonlyPreferences())
    expect(readonlyProtection(guest)).toEqual({ decision: 'safe', reasonCodes: [] })
  })

  it.each([
    ['devtools', { devToolsOpened: true }, 'devtools-open'],
    ['loading', { loadingMainFrame: true }, 'page-loading'],
    ['audible', { audible: true }, 'page-audible'],
    ['crashed', { crashed: true }, 'renderer-crashed'],
  ] as const)('%s 状态下返回 blocked', (_name, overrides, reason) => {
    const mock = createInitializedSession()
    const { guest } = createGuest(mock.session, readonlyPreferences(), overrides)
    expect(readonlyProtection(guest)).toEqual({ decision: 'blocked', reasonCodes: [reason] })
  })

  it('多个风险同时出现时按固定顺序聚合原因码', () => {
    const mock = createInitializedSession()
    const { guest } = createGuest(mock.session, readonlyPreferences(), {
      devToolsOpened: true,
      loadingMainFrame: true,
      audible: true,
      crashed: true,
    })
    expect(readonlyProtection(guest)).toEqual({
      decision: 'blocked',
      reasonCodes: ['devtools-open', 'page-loading', 'page-audible', 'renderer-crashed'],
    })
  })

  it('销毁后的 guest 为 unknown，绝不返回 safe', () => {
    const mock = createInitializedSession()
    const { guest } = createGuest(mock.session, readonlyPreferences(), { destroyed: true })
    expect(readonlyProtection(guest)).toEqual({
      decision: 'unknown',
      reasonCodes: ['guest-destroyed'],
    })
  })

  it('分区未初始化为 blocked，即使原生状态干净', () => {
    const mock = createSessionMock()
    const { guest } = createGuest(mock.session, readonlyPreferences())
    expect(readonlyProtection(guest)).toEqual({
      decision: 'blocked',
      reasonCodes: ['contract-unverified'],
    })
  })

  it('WebPreferences 缺失为 blocked（preferences-missing）', () => {
    const mock = createInitializedSession()
    const { guest } = createGuest(mock.session, null)
    expect(readonlyProtection(guest)).toEqual({
      decision: 'blocked',
      reasonCodes: ['preferences-missing'],
    })
  })

  it('WebPreferences 被篡改为 blocked（contract-unverified）', () => {
    const mock = createInitializedSession()
    const { guest } = createGuest(mock.session, readonlyPreferences({ javascript: false }))
    expect(readonlyProtection(guest)).toEqual({
      decision: 'blocked',
      reasonCodes: ['contract-unverified'],
    })
  })

  it('原生探针抛错为 unknown（inspection-failed），并保留已发现的原因', () => {
    const mock = createInitializedSession()
    const guest = {
      session: mock.session,
      isDestroyed: () => false,
      isDevToolsOpened: () => {
        throw new Error('boom')
      },
      isLoadingMainFrame: () => false,
      isCurrentlyAudible: () => false,
      isCrashed: () => false,
      getLastWebPreferences: () => readonlyPreferences(),
    } as unknown as WebContents
    expect(readonlyProtection(guest)).toEqual({
      decision: 'unknown',
      reasonCodes: ['inspection-failed'],
    })
  })
})
