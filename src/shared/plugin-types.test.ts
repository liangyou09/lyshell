import { describe, it, expect } from 'vitest'
import {
  validateManifest,
  checkEngines,
  getDefaultLifecycle,
  normalizeLifecycle,
  isLegacyPythonStartup,
  shouldActivateOnStartup,
  validateViewDefinition,
  validateViewDefinitionList,
  makePluginViewKey,
  parsePluginViewKey,
  isPluginViewKey,
  PLUGIN_MAX_VIEWS
} from './plugin-types'

/** 一份合法的清单基线，各用例在此基础上破坏单个字段 */
const validManifest: Record<string, unknown> = {
  id: 'my-rdp-connector',
  name: 'RDP Connector',
  version: '1.0.0',
  engines: { lyshell: '^1.0' },
  main: './dist/index.js',
  runtime: 'node',
  activationEvents: ['onCommand:rdp.connect', 'onConnectionType:rdp'],
  capabilities: ['sessionControl'],
  contributes: {
    commands: [{ id: 'rdp.connect', title: 'Connect RDP' }],
    connectionTypes: [{ type: 'rdp', label: 'RDP' }]
  }
}

describe('validateManifest', () => {
  it('接受合法清单', () => {
    const r = validateManifest(validManifest)
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.manifest).toBeDefined()
    expect(r.manifest?.id).toBe('my-rdp-connector')
  })

  it('接受 consumer 插件（无 main、空激活、空能力）', () => {
    const r = validateManifest({
      id: 'plain-consumer',
      name: 'Plain',
      version: '0.1.0',
      engines: { lyshell: '^1.0' },
      runtime: 'node',
      activationEvents: [],
      capabilities: []
    })
    expect(r.ok).toBe(true)
  })

  it('拒绝 main 含 .. 段 / 绝对路径 / 盘符(入口包围,评审 containment)', () => {
    for (const main of [
      '../evil.js',
      'dist/../../evil.js',
      'a/../b.js',
      '/etc/evil.js',
      'C:\\evil.js',
      'C:/evil.js'
    ]) {
      const r = validateManifest({ ...validManifest, main })
      expect(r.ok).toBe(false)
      expect(r.errors.some((e) => e.startsWith('main '))).toBe(true)
    }
  })

  it('接受相对安全的 main(含 ./ 前缀与子目录)', () => {
    for (const main of ['dist/main.js', './dist/main.js', 'main.js', 'dist/sub/main.js']) {
      const r = validateManifest({ ...validManifest, main })
      expect(r.ok).toBe(true)
    }
  })

  it('接受空 main(视为 consumer 无入口,不拒)', () => {
    const r = validateManifest({ ...validManifest, main: '' })
    expect(r.ok).toBe(true)
  })

  it('拒绝非对象', () => {
    expect(validateManifest(null).ok).toBe(false)
    expect(validateManifest('hello').ok).toBe(false)
    expect(validateManifest(42).ok).toBe(false)
  })

  it('拒绝非法 id（大写 / 下划线 / 空格）', () => {
    for (const id of ['My-Plugin', 'my_plugin', 'my plugin', '']) {
      const r = validateManifest({ ...validManifest, id })
      expect(r.ok).toBe(false)
      expect(r.errors.some((e) => e.startsWith('id '))).toBe(true)
    }
  })

  it('拒绝非 semver 版本', () => {
    for (const version of ['latest', '1', '1.0', '']) {
      const r = validateManifest({ ...validManifest, version })
      expect(r.ok).toBe(false)
      expect(r.errors.some((e) => e.startsWith('version '))).toBe(true)
    }
  })

  it('拒绝缺 engines.lyshell', () => {
    const r = validateManifest({ ...validManifest, engines: {} })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.startsWith('engines.'))).toBe(true)
  })

  it('拒绝非法 runtime', () => {
    const r = validateManifest({ ...validManifest, runtime: 'ruby' as unknown as never })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.startsWith('runtime '))).toBe(true)
  })

  it('拒绝非法 capability', () => {
    const r = validateManifest({ ...validManifest, capabilities: ['read', 'superuser' as unknown as never] })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.startsWith('invalid capability'))).toBe(true)
  })

  it('拒绝非法 activationEvent', () => {
    const r = validateManifest({ ...validManifest, activationEvents: ['onCommand:ok', 'onSomething:bad' as unknown as never] })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.startsWith('invalid activationEvent'))).toBe(true)
  })

  it('activationEvents 缺省合法（纯声明式清单不声明激活事件）', () => {
    const withoutEvents = { ...validManifest } as Record<string, unknown>
    delete withoutEvents.activationEvents
    const r = validateManifest(withoutEvents)
    expect(r.ok).toBe(true)
    expect(r.manifest?.activationEvents).toBeUndefined()
  })

  it('activationEvents 非数组仍拒绝', () => {
    const r = validateManifest({ ...validManifest, activationEvents: 'onStartup' as unknown as never })
    expect(r.ok).toBe(false)
    expect(r.errors).toContain('activationEvents must be an array')
  })

  it('接受所有合法 activationEvent 形态', () => {
    const r = validateManifest({
      ...validManifest,
      activationEvents: ['onStartup', '*', 'onCommand:x', 'onConnectionType:y']
    })
    expect(r.ok).toBe(true)
  })

  it('接受全部 8 种合法 capability（含 uiControl）', () => {
    const r = validateManifest({
      ...validManifest,
      capabilities: [
        'read',
        'interactiveWrite',
        'execute',
        'localExecute',
        'fileWrite',
        'sessionControl',
        'sessionMetadataWrite',
        'uiControl'
      ]
    })
    expect(r.ok).toBe(true)
  })

  it('接受 uiControl capability（视图/UI 动作专用）', () => {
    const r = validateManifest({ ...validManifest, capabilities: ['uiControl'] })
    expect(r.ok).toBe(true)
  })

  it('拒绝 main 不是字符串', () => {
    const r = validateManifest({ ...validManifest, main: 123 as unknown as never })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.startsWith('main '))).toBe(true)
  })

  it('累计多个错误', () => {
    const r = validateManifest({ id: 'UPPER', version: 'bad', runtime: 'x' })
    expect(r.ok).toBe(false)
    expect(r.errors.length).toBeGreaterThanOrEqual(4)
  })

  it('拒绝越界 pythonTimeoutMs', () => {
    for (const pythonTimeoutMs of [0, 999, 600001, 1.5, 'x'] as unknown[]) {
      const r = validateManifest({ ...validManifest, runtime: 'python', pythonTimeoutMs })
      expect(r.ok).toBe(false)
      expect(r.errors.some((e) => e.startsWith('pythonTimeoutMs '))).toBe(true)
    }
  })

  it('接受合法 pythonTimeoutMs', () => {
    const r = validateManifest({ ...validManifest, runtime: 'python', pythonTimeoutMs: 300000 })
    expect(r.ok).toBe(true)
  })

  it('接受合法 lifecycle', () => {
    expect(validateManifest({ ...validManifest, lifecycle: 'oneshot' }).ok).toBe(true)
    expect(validateManifest({ ...validManifest, lifecycle: 'persistent' }).ok).toBe(true)
  })

  it('拒绝非法 lifecycle', () => {
    const r = validateManifest({ ...validManifest, lifecycle: 'long' as unknown as never })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.startsWith('lifecycle '))).toBe(true)
  })

  it('缺失 lifecycle 时 validateManifest 仍合法', () => {
    const r = validateManifest(validManifest)
    expect(r.ok).toBe(true)
    expect(r.manifest).toBeDefined()
    expect(r.manifest?.lifecycle).toBeUndefined()
  })

  it('按 runtime 取默认生命周期', () => {
    expect(getDefaultLifecycle('node')).toBe('persistent')
    expect(getDefaultLifecycle('python')).toBe('oneshot')
  })

  it('归一化生命周期：显式值优先，缺失取默认值', () => {
    expect(normalizeLifecycle('node', 'oneshot')).toBe('oneshot')
    expect(normalizeLifecycle('node', 'persistent')).toBe('persistent')
    expect(normalizeLifecycle('node')).toBe('persistent')
    expect(normalizeLifecycle('python')).toBe('oneshot')
    expect(normalizeLifecycle('python', 'persistent')).toBe('persistent')
  })

  it('仅未声明 lifecycle 的 Python 插件走 legacy 启动时运行一次兼容路径', () => {
    expect(isLegacyPythonStartup('python')).toBe(true)
    expect(isLegacyPythonStartup('python', 'oneshot')).toBe(false)
    expect(isLegacyPythonStartup('python', 'persistent')).toBe(false)
    expect(isLegacyPythonStartup('node')).toBe(false)
  })

  it('shouldActivateOnStartup: 仅 onStartup/* 立即激活', () => {
    expect(shouldActivateOnStartup(['onStartup'])).toBe(true)
    expect(shouldActivateOnStartup(['*'])).toBe(true)
    expect(shouldActivateOnStartup(['onStartup', 'onCommand:x'])).toBe(true)
    expect(shouldActivateOnStartup([])).toBe(false)
    expect(shouldActivateOnStartup(['onCommand:rdp.connect'])).toBe(false)
    expect(shouldActivateOnStartup(['onConnectionType:rdp'])).toBe(false)
  })
})

describe('checkEngines', () => {
  it('^1.0 兼容 1.2.3', () => {
    expect(checkEngines('^1.0', '1.2.3').ok).toBe(true)
  })

  it('^2.0 不兼容 1.2.3', () => {
    const r = checkEngines('^2.0', '1.2.3')
    expect(r.ok).toBe(false)
    expect(r.warning).toBeTruthy()
  })

  it('* / 空串 兼容任意', () => {
    expect(checkEngines('*', '1.2.3').ok).toBe(true)
    expect(checkEngines('', '1.2.3').ok).toBe(true)
  })

  it('1.x 兼容 1.9.9 不兼容 2.0.0', () => {
    expect(checkEngines('1.x', '1.9.9').ok).toBe(true)
    expect(checkEngines('1.x', '2.0.0').ok).toBe(false)
  })

  it('1.2.x 兼容 1.2.5 不兼容 1.3.0', () => {
    expect(checkEngines('1.2.x', '1.2.5').ok).toBe(true)
    expect(checkEngines('1.2.x', '1.3.0').ok).toBe(false)
  })

  it('AND 组合 >=1.0 <2.0', () => {
    expect(checkEngines('>=1.0 <2.0', '1.5.0').ok).toBe(true)
    expect(checkEngines('>=1.0 <2.0', '2.0.0').ok).toBe(false)
    expect(checkEngines('>=1.0 <2.0', '0.9.0').ok).toBe(false)
  })

  it('|| OR 组合', () => {
    expect(checkEngines('^1.0 || ^2.0', '2.1.0').ok).toBe(true)
    expect(checkEngines('^1.0 || ^2.0', '3.0.0').ok).toBe(false)
  })

  it('~1.2 兼容 1.2.9 不兼容 1.3.0', () => {
    expect(checkEngines('~1.2', '1.2.9').ok).toBe(true)
    expect(checkEngines('~1.2', '1.3.0').ok).toBe(false)
  })

  it('~1 兼容 1.9.9 不兼容 2.0.0', () => {
    expect(checkEngines('~1', '1.9.9').ok).toBe(true)
    expect(checkEngines('~1', '2.0.0').ok).toBe(false)
  })

  it('=1.2.3 精确匹配', () => {
    expect(checkEngines('=1.2.3', '1.2.3').ok).toBe(true)
    expect(checkEngines('=1.2.3', '1.2.4').ok).toBe(false)
  })

  it('^0.2.0 兼容 0.2.5 不兼容 0.3.0', () => {
    expect(checkEngines('^0.2.0', '0.2.5').ok).toBe(true)
    expect(checkEngines('^0.2.0', '0.3.0').ok).toBe(false)
  })

  it('无法解析 range -> ok=false + warning', () => {
    const r = checkEngines('abc', '1.2.3')
    expect(r.ok).toBe(false)
    expect(r.warning).toBeTruthy()
  })

  it('无法解析 appVersion -> ok=false + warning', () => {
    const r = checkEngines('^1.0', 'not-a-version')
    expect(r.ok).toBe(false)
    expect(r.warning).toBeTruthy()
  })
})

// ====================== 界面视图（contributes.views / 运行时注册） ======================

const validView: Record<string, unknown> = {
  id: 'status-panel',
  title: 'Status Panel',
  entry: 'views/panel.html'
}

describe('validateViewDefinition', () => {
  it('接受合法定义（含 icon）', () => {
    const r = validateViewDefinition({ ...validView, icon: 'assets/icon.svg' })
    expect(r.ok).toBe(true)
    expect(r.view?.entry).toBe('views/panel.html')
    expect(r.view?.icon).toBe('assets/icon.svg')
  })

  it('接受子目录 views 下的 entry', () => {
    expect(validateViewDefinition({ ...validView, entry: 'views/sub/page.html' }).ok).toBe(true)
  })

  it('拒绝非对象 / 缺字段 / 空字段', () => {
    for (const raw of [null, 'x', 42, [], {}, { id: 'a', entry: 'views/a.html' }, { title: 't', entry: 'views/a.html' }, { id: 'a', title: 't' }]) {
      expect(validateViewDefinition(raw).ok).toBe(false)
    }
  })

  it('拒绝非法 id（大写开头 / 下划线 / 空格 / 过长）', () => {
    for (const id of ['Bad', '1abc', 'has_underscore', 'has space', '', 'a'.repeat(65)]) {
      const r = validateViewDefinition({ ...validView, id })
      expect(r.ok).toBe(false)
      expect(r.errors.some((e) => e.startsWith('view.id'))).toBe(true)
    }
  })

  it('接受 64 字符以内 id，拒绝超长', () => {
    expect(validateViewDefinition({ ...validView, id: 'a'.repeat(64) }).ok).toBe(true)
    expect(validateViewDefinition({ ...validView, id: 'a'.repeat(65) }).ok).toBe(false)
  })

  it('拒绝空标题 / 超长标题', () => {
    expect(validateViewDefinition({ ...validView, title: '' }).ok).toBe(false)
    expect(validateViewDefinition({ ...validView, title: '   ' }).ok).toBe(false)
    expect(validateViewDefinition({ ...validView, title: 'x'.repeat(65) }).ok).toBe(false)
  })

  it('entry 必须位于 views/ 目录下且为 .html', () => {
    for (const entry of ['panel.html', 'src/panel.html', 'views/panel.js', 'views/panel.htm', 'views/', 'views//a.html', 'viewsx/a.html', 'VIEWS/a.html', 'views/./panel.html', 'views/./sub/panel.html', 'views/sub/./panel.html']) {
      const r = validateViewDefinition({ ...validView, entry })
      expect(r.ok).toBe(false)
      expect(r.errors.some((e) => e.startsWith('view.entry'))).toBe(true)
    }
  })

  it('拒绝 ./ 段：URL 会规范化掉它，入口身份匹配与重复 entry 校验都按原始字符串比对', () => {
    // 绕过路径：views/./panel.html 与 views/panel.html 是同一 URL 身份，
    // 不拒绝则 connectOrigins 反查落空 + 重复 entry 去重被绕过（P2 评审）
    const r = validateViewDefinitionList([
      { id: 'a', title: 'A', entry: 'views/panel.html' },
      { id: 'b', title: 'B', entry: 'views/./panel.html' }
    ])
    expect(r.ok).toBe(false)
  })

  it('拒绝编码遍历 / .. 段 / 反斜杠', () => {
    for (const entry of ['views/../secret.txt', 'views/%2e%2e/secret.txt', 'views/a/../../evil.html', 'views\\panel.html', 'views/..\\evil.html']) {
      const r = validateViewDefinition({ ...validView, entry })
      expect(r.ok).toBe(false)
    }
  })

  it('拒绝盘符 / 绝对路径 / NUL / 查询串 / fragment / 空路径', () => {
    for (const entry of ['C:\\evil.html', 'C:/evil.html', '/etc/evil.html', 'views/a.html\0', 'views/a.html?x=1', 'views/a.html#frag', '']) {
      const r = validateViewDefinition({ ...validView, entry })
      expect(r.ok).toBe(false)
      expect(r.errors.length).toBeGreaterThan(0)
    }
  })

  it('icon 仅接受 .svg/.png 且受同样路径规则约束', () => {
    expect(validateViewDefinition({ ...validView, icon: 'icon.svg' }).ok).toBe(true)
    expect(validateViewDefinition({ ...validView, icon: 'icon.png' }).ok).toBe(true)
    expect(validateViewDefinition({ ...validView, icon: 'icon.exe' }).ok).toBe(false)
    expect(validateViewDefinition({ ...validView, icon: '../icon.svg' }).ok).toBe(false)
    expect(validateViewDefinition({ ...validView, icon: '/abs/icon.svg' }).ok).toBe(false)
    expect(validateViewDefinition({ ...validView, icon: '' }).ok).toBe(false)
  })

  it('icon 为 undefined 时可选省略', () => {
    const r = validateViewDefinition(validView)
    expect(r.ok).toBe(true)
    expect(r.view?.icon).toBeUndefined()
  })

  it('connectOrigins 接受 localhost 来源并原样写回', () => {
    const r = validateViewDefinition({
      ...validView,
      connectOrigins: ['http://127.0.0.1:31517', 'ws://localhost:5173', 'wss://[::1]:9000', 'https://localhost']
    })
    expect(r.ok).toBe(true)
    expect(r.view?.connectOrigins).toEqual([
      'http://127.0.0.1:31517',
      'ws://localhost:5173',
      'wss://[::1]:9000',
      'https://localhost'
    ])
  })

  it('connectOrigins 未声明时省略', () => {
    expect(validateViewDefinition(validView).view?.connectOrigins).toBeUndefined()
  })

  it('connectOrigins 拒绝远程主机 / 带路径 / 带查询 / 用户信息', () => {
    for (const origin of [
      'http://192.168.1.1:31517',
      'http://evil.com',
      'https://localhost.evil.com',
      'http://127.0.0.1:31517/ui/chat/',
      'ws://127.0.0.1:31517/?x=1',
      'http://user@127.0.0.1:31517',
      'ftp://127.0.0.1:31517',
      'http://localhost:70000',
      'file:///etc/passwd',
      '127.0.0.1:31517',
      ''
    ]) {
      const r = validateViewDefinition({ ...validView, connectOrigins: [origin] })
      expect(r.ok).toBe(false)
      expect(r.errors.some((e) => e.startsWith('view.connectOrigins'))).toBe(true)
    }
  })

  it('connectOrigins 拒绝非数组 / 非字符串项', () => {
    expect(validateViewDefinition({ ...validView, connectOrigins: 'http://127.0.0.1:1' }).ok).toBe(false)
    expect(validateViewDefinition({ ...validView, connectOrigins: [42] }).ok).toBe(false)
  })

  it('connectOrigins 最多 8 项且拒绝重复', () => {
    const eight = Array.from({ length: 8 }, (_, i) => `http://127.0.0.1:${30000 + i}`)
    expect(validateViewDefinition({ ...validView, connectOrigins: eight }).ok).toBe(true)
    const nine = [...eight, 'http://localhost:1']
    expect(
      validateViewDefinition({ ...validView, connectOrigins: nine }).errors.some((e) => e.includes('at most 8'))
    ).toBe(true)
    const dup = validateViewDefinition({
      ...validView,
      connectOrigins: ['http://127.0.0.1:31517', 'http://127.0.0.1:31517']
    })
    expect(dup.ok).toBe(false)
    expect(dup.errors.some((e) => e.includes('duplicate'))).toBe(true)
  })
})

describe('validateViewDefinitionList', () => {
  const view = (id: string) => ({ id, title: `V ${id}`, entry: `views/${id}.html` })

  it('接受最多 8 个视图', () => {
    const views = Array.from({ length: PLUGIN_MAX_VIEWS }, (_, i) => view(`v${i}`))
    const r = validateViewDefinitionList(views)
    expect(r.ok).toBe(true)
    expect(r.views).toHaveLength(PLUGIN_MAX_VIEWS)
  })

  it('拒绝超过 8 个视图', () => {
    const views = Array.from({ length: PLUGIN_MAX_VIEWS + 1 }, (_, i) => view(`v${i}`))
    const r = validateViewDefinitionList(views)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('at most 8'))).toBe(true)
  })

  it('拒绝重复 ID', () => {
    const r = validateViewDefinitionList([view('dup'), view('dup')])
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('duplicate view id'))).toBe(true)
  })

  it('拒绝重复 entry：entry 是请求期视图身份，共用入口会让后者继承前者的 connectOrigins CSP', () => {
    const shared = { id: 'a', title: 'A', entry: 'views/same.html' }
    const r = validateViewDefinitionList([shared, { ...shared, id: 'b', title: 'B' }])
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('duplicate view entry'))).toBe(true)
    expect(r.views).toHaveLength(1)
  })

  it('拒绝大小写不同的重复 entry（Windows 文件系统不区分大小写）', () => {
    const r = validateViewDefinitionList([
      { id: 'a', title: 'A', entry: 'views/panel.html' },
      { id: 'b', title: 'B', entry: 'views/Panel.html' }
    ])
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('duplicate view entry'))).toBe(true)
  })

  it('拒绝非数组', () => {
    expect(validateViewDefinitionList('x').ok).toBe(false)
    expect(validateViewDefinitionList({}).ok).toBe(false)
  })

  it('逐项校验并汇总错误', () => {
    const r = validateViewDefinitionList([view('ok1'), { ...view('bad'), entry: '../evil.html' }])
    expect(r.ok).toBe(false)
    expect(r.views).toHaveLength(1)
    expect(r.errors.length).toBeGreaterThan(0)
  })
})

describe('插件视图复合键（plugin:{pluginId}:{viewId}）', () => {
  it('构造 + 解析往返', () => {
    const key = makePluginViewKey('my-view-plugin', 'status-panel')
    expect(key).toBe('plugin:my-view-plugin:status-panel')
    expect(isPluginViewKey(key)).toBe(true)
    expect(parsePluginViewKey(key)).toEqual({ pluginId: 'my-view-plugin', viewId: 'status-panel' })
  })

  it('viewId 含连字符与数字', () => {
    const key = makePluginViewKey('plugin-1', 'view-2x')
    expect(parsePluginViewKey(key)).toEqual({ pluginId: 'plugin-1', viewId: 'view-2x' })
  })

  it('拒绝非插件键 / 空段 / 非法 id', () => {
    for (const key of [
      'sessions',
      'web:1',
      'plugin:',
      'plugin:abc',
      'plugin::view',
      'plugin:abc:',
      'plugin:abc:View',
      'plugin:abc:view_id',
      'plugin:Abc:view',
      '',
      'pluginx:abc:view'
    ]) {
      expect(isPluginViewKey(key)).toBe(false)
      expect(parsePluginViewKey(key)).toBeNull()
    }
  })

  it('pluginId 允许数字开头（插件 id 规则），viewId 不允许', () => {
    expect(parsePluginViewKey(makePluginViewKey('1plugin', 'view'))).toEqual({ pluginId: '1plugin', viewId: 'view' })
    expect(isPluginViewKey('plugin:1p:1view')).toBe(false)
  })

  it('只取第一个冒号分段，后续冒号落入 viewId 并被 id 规则拒绝', () => {
    expect(isPluginViewKey('plugin:abc:view:extra')).toBe(false)
  })
})
