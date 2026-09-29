/**
 * view-protocol-core 单元测试 -- URL 清洗、查询串校验、真实路径包围。
 *
 * 纯逻辑 + 临时目录 IO（对齐 view-registry.test.ts 模式）。经 initPluginViewRegistry
 * 注入临时目录 deps，覆盖：正常资源、禁用拒服、跨插件、symlink/junction 越界、
 * 隐藏/敏感文件拒服、MIME 映射、dialogId 查询容错。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  cleanViewUrlPath,
  checkUrlSearch,
  resolveViewFileUrl,
  makeViewEntryUrl,
  makeViewDialogEntryUrl,
  pluginViewPartition,
  buildViewCsp,
  PLUGIN_VIEW_CSP,
  ViewProtocolError,
  MIME_BY_EXT
} from './view-protocol-core'
import { initPluginViewRegistry } from './view-registry'
import type { PluginRegistryEntry, PluginViewDefinition } from '@shared/plugin-types'

const throwStatus = (fn: () => unknown): number => {
  try {
    fn()
  } catch (e) {
    if (e instanceof ViewProtocolError) return e.status
    throw e
  }
  throw new Error('expected ViewProtocolError')
}

describe('buildViewCsp', () => {
  it('零来源时与默认 PLUGIN_VIEW_CSP 完全一致（现网基线不漂移）', () => {
    expect(buildViewCsp()).toBe(PLUGIN_VIEW_CSP)
    expect(buildViewCsp([])).toBe(PLUGIN_VIEW_CSP)
    // 基线仍锁死脚本/框架/表单方向
    expect(PLUGIN_VIEW_CSP).toContain("script-src 'self'")
    expect(PLUGIN_VIEW_CSP).toContain('default-src \'none\'')
    expect(PLUGIN_VIEW_CSP).toContain("connect-src 'self'")
  })

  it('把来源合并进 connect-src 与 img-src，其余指令不变', () => {
    const csp = buildViewCsp(['http://127.0.0.1:31517', 'ws://localhost:5173'])
    expect(csp).toContain("connect-src 'self' http://127.0.0.1:31517 ws://localhost:5173")
    expect(csp).toContain("img-src 'self' data: http://127.0.0.1:31517 ws://localhost:5173")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain('default-src \'none\'')
    // 不重复出现在无关指令里
    expect(csp).not.toMatch(/font-src[^;]*127\.0\.0\.1/)
  })

  it('WebSocket 必须显式声明 ws:// 来源：http:// 不覆盖 ws://（CSP3 无 http→ws/wss 方向）', () => {
    // 只声明 http:// 时 CSP 里没有任何 ws 来源，页面发起的 WebSocket 会被 connect-src
    // 拦截（CSP3 的 scheme 匹配只有 http→https、ws→wss 的安全升级，没有 http→ws/wss 方向）。
    // 字符串级测试无法验证引擎语义，这里断言的是我们依赖的事实：没显式声明就没有 ws 来源。
    const httpOnly = buildViewCsp(['http://127.0.0.1:31517'])
    expect(httpOnly).not.toMatch(/connect-src[^;]*\bws:/)
    // 要连 WebSocket 的视图必须把 ws://（或 wss://）列进 connectOrigins
    const withWs = buildViewCsp(['http://127.0.0.1:31517', 'ws://127.0.0.1:31517'])
    expect(withWs).toContain("connect-src 'self' http://127.0.0.1:31517 ws://127.0.0.1:31517")
    expect(withWs.match(/127\.0\.0\.1:31517/g)).toHaveLength(4) // connect-src/img-src 各两次（http + ws）
  })
})

describe('cleanViewUrlPath', () => {
  it('接受普通/嵌套/编码路径并解码', () => {
    expect(cleanViewUrlPath('/panel.html')).toBe('panel.html')
    expect(cleanViewUrlPath('/assets/app.css')).toBe('assets/app.css')
    expect(cleanViewUrlPath('/sub%20dir/pic.png')).toBe('sub dir/pic.png')
    expect(cleanViewUrlPath('/a/b/c.js')).toBe('a/b/c.js')
  })

  it('拒绝编码遍历 / .. 段 / 反斜杠 / NUL / 空段 / 盘符 / 畸形编码', () => {
    for (const p of [
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/../secret.txt',
      '/a/../../evil.html',
      '/views\\evil.html',
      '/a%00.html',
      '/a//b.html',
      '/./a.html',
      '/C:/evil.html',
      '/a/b/',
      '/%',
      '/a%2.html'
    ]) {
      expect(() => cleanViewUrlPath(p)).toThrow(ViewProtocolError)
    }
  })

  it('拒绝非 / 开头形态', () => {
    expect(() => cleanViewUrlPath('panel.html')).toThrow(ViewProtocolError)
    expect(() => cleanViewUrlPath('')).toThrow(ViewProtocolError)
  })
})

describe('checkUrlSearch', () => {
  it('无查询串返回 false', () => {
    expect(checkUrlSearch('')).toBe(false)
  })

  it('单个 dialogId 返回 true（协议读文件不拼接参数）', () => {
    expect(checkUrlSearch('?dialogId=abc-DEF_123')).toBe(true)
  })

  it('拒绝其他参数 / 多参数 / 非法 dialogId', () => {
    for (const s of ['?x=1', '?dialogId=a&x=1', '?dialogId=', '?dialogId=' + 'x'.repeat(129), '?dialogId=a/b', '?dialogId=a b']) {
      expect(() => checkUrlSearch(s)).toThrow(ViewProtocolError)
    }
  })
})

describe('resolveViewFileUrl（临时目录 + 注入注册表）', () => {
  let tmp: string
  let registryEntries: PluginRegistryEntry[]

  const pluginUrl = (host: string, path: string, search = ''): string =>
    `lyshell-plugin://${host}${path}${search}`

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lyshell-viewproto-'))
    // 铺插件：views/panel.html + assets/app.css + img.png + 隐藏文件 + 根部 manifest
    const root = join(tmp, 'p1')
    mkdirSync(join(root, 'views', 'assets'), { recursive: true })
    writeFileSync(join(root, 'views', 'panel.html'), '<html></html>')
    writeFileSync(join(root, 'views', 'assets', 'app.css'), 'body{}')
    writeFileSync(join(root, 'views', 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(join(root, 'views', 'img.png'), Buffer.from([0x89, 0x50]))
    writeFileSync(join(root, 'views', '.secret'), 'hidden')
    writeFileSync(join(root, 'lyshell-plugin.json'), '{}')
    registryEntries = [
      { id: 'p1', version: '1.0.0', path: root, dev: true, enabled: true, source: 'dev', installedAt: '', grantedCapabilities: [] },
      { id: 'p2', version: '1.0.0', path: join(tmp, 'p2'), dev: true, enabled: true, source: 'dev', installedAt: '', grantedCapabilities: [] }
    ]
    initPluginViewRegistry({
      getEnabledEntries: () => registryEntries.filter((e) => e.enabled),
      pluginDirOf: (e) => e.path,
      readManifestViews: () => [makeView('panel')],
      broadcast: () => {}
    })
  })

  const makeView = (id: string): PluginViewDefinition => ({ id, title: id, entry: `views/${id}.html` })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('正常 HTML/CSS/JS/图片解析 + MIME 正确', () => {
    expect(resolveViewFileUrl('p1', pluginUrl('p1', '/panel.html'))).toMatchObject({
      mime: MIME_BY_EXT['.html'],
      rel: 'panel.html'
    })
    expect(resolveViewFileUrl('p1', pluginUrl('p1', '/assets/app.css')).mime).toBe('text/css; charset=utf-8')
    expect(resolveViewFileUrl('p1', pluginUrl('p1', '/assets/app.js')).mime).toBe('text/javascript; charset=utf-8')
    expect(resolveViewFileUrl('p1', pluginUrl('p1', '/img.png')).mime).toBe('image/png')
  })

  it('dialogId 查询参数被容忍且不拼进文件路径', () => {
    const r = resolveViewFileUrl('p1', pluginUrl('p1', '/panel.html', '?dialogId=abc123'))
    expect(r.mime).toBe(MIME_BY_EXT['.html'])
  })

  it('禁用插件拒服（403）', () => {
    registryEntries[0].enabled = false
    expect(throwStatus(() => resolveViewFileUrl('p1', pluginUrl('p1', '/panel.html')))).toBe(403)
  })

  it('跨插件 URL 拒服（host 与 partition 绑定 pluginId 不一致，403）', () => {
    expect(throwStatus(() => resolveViewFileUrl('p1', pluginUrl('p2', '/panel.html')))).toBe(403)
  })

  it('symlink/junction 越界拒服', () => {
    const root = join(tmp, 'p1')
    const outside = join(tmp, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'evil.html'), 'evil')
    try {
      // views/link -> 插件根外目录（junction 无特权可建）
      symlinkSync(outside, join(root, 'views', 'link'), 'junction')
    } catch {
      return // 无链接特权环境跳过
    }
    expect(
      throwStatus(() => resolveViewFileUrl('p1', pluginUrl('p1', '/link/evil.html')))
    ).toBe(403)
  })

  it('views 内 symlink 指向插件根部文件拒服（manifest 不在服务范围）', () => {
    const root = join(tmp, 'p1')
    try {
      symlinkSync(join(root, 'lyshell-plugin.json'), join(root, 'views', 'manifest-link.json'), 'file')
    } catch {
      return
    }
    expect(
      throwStatus(() => resolveViewFileUrl('p1', pluginUrl('p1', '/manifest-link.json')))
    ).toBe(403)
  })

  it('隐藏/凭据文件拒服（403）', () => {
    expect(throwStatus(() => resolveViewFileUrl('p1', pluginUrl('p1', '/.secret')))).toBe(403)
  })

  it('缺失文件 404 / 目录请求 403 / 非法查询 403 / 路径遍历 403', () => {
    expect(throwStatus(() => resolveViewFileUrl('p1', pluginUrl('p1', '/nope.html')))).toBe(404)
    expect(throwStatus(() => resolveViewFileUrl('p1', pluginUrl('p1', '/assets')))).toBe(403)
    expect(throwStatus(() => resolveViewFileUrl('p1', pluginUrl('p1', '/panel.html', '?x=1')))).toBe(403)
    expect(throwStatus(() => resolveViewFileUrl('p1', pluginUrl('p1', '/..%2F..%2Fevil.html')))).toBe(403)
  })

  it('未知插件 / 未知扩展名处理', () => {
    expect(throwStatus(() => resolveViewFileUrl('ghost', pluginUrl('ghost', '/panel.html')))).toBe(403)
    writeFileSync(join(tmp, 'p1', 'views', 'data.bin'), '\x00\x01')
    expect(resolveViewFileUrl('p1', pluginUrl('p1', '/data.bin')).mime).toBe('application/octet-stream')
  })
})

describe('URL/partition 辅助', () => {
  it('makeViewEntryUrl 剥离 views/ 前缀', () => {
    expect(makeViewEntryUrl('my-plugin', 'views/panel.html')).toBe('lyshell-plugin://my-plugin/panel.html')
    expect(makeViewEntryUrl('my-plugin', 'views/sub/page.html')).toBe('lyshell-plugin://my-plugin/sub/page.html')
  })

  it('makeViewDialogEntryUrl 带单一 dialogId 参数且与协议层/attach 闸形态对齐（回归：弹窗曾被当面板挂载）', () => {
    const dialogId = 'abc123_-XYZ'
    const url = makeViewDialogEntryUrl('my-plugin', 'views/picker.html', dialogId)
    expect(url).toBe(`lyshell-plugin://my-plugin/picker.html?dialogId=${dialogId}`)
    const parsed = new URL(url)
    // attach 闸：单参数 + 路径命中已注册入口形态
    expect(parsed.search).toBe(`?dialogId=${dialogId}`)
    expect(checkUrlSearch(parsed.search)).toBe(true)
    // base64url（randomBytes().toString('base64url')）在协议层白名单内
    expect(checkUrlSearch('?dialogId=P0STq8fH2kLmN0pQrStU1v2W3x4Y')).toBe(true)
  })

  it('pluginViewPartition 拼法', () => {
    expect(pluginViewPartition('my-plugin')).toBe('pluginviews:my-plugin')
  })
})
