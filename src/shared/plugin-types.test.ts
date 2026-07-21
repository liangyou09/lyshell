import { describe, it, expect } from 'vitest'
import { validateManifest, checkEngines } from './plugin-types'

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

  it('接受所有合法 activationEvent 形态', () => {
    const r = validateManifest({
      ...validManifest,
      activationEvents: ['onStartup', '*', 'onCommand:x', 'onConnectionType:y']
    })
    expect(r.ok).toBe(true)
  })

  it('接受全部 7 种合法 capability', () => {
    const r = validateManifest({
      ...validManifest,
      capabilities: [
        'read',
        'interactiveWrite',
        'execute',
        'localExecute',
        'fileWrite',
        'sessionControl',
        'sessionMetadataWrite'
      ]
    })
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
