/**
 * view-registry 单元测试 -- 合并排序、运行时注册/注销、生命周期清理、真实路径包围。
 *
 * 纯逻辑 + 临时目录 IO（对齐 install-zip.test.ts 模式）。symlink 用 fs.symlinkSync
 * 现造（Windows 需开发者模式/管理员；junction 可无特权创建目录链接，这里对目录用
 * junction、对文件在失败时跳过对应用例）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  PluginViewRegistry,
  ViewRegistrationError,
  isPathStrictlyInside,
  verifyViewFiles,
  type ViewRegistryDeps
} from './view-registry'
import type { PluginRegistryEntry, PluginViewDefinition } from '@shared/plugin-types'

/** enabled 插件条目基线 */
const entry = (id: string, dir: string): PluginRegistryEntry => ({
  id,
  version: '1.0.0',
  path: dir,
  dev: true,
  enabled: true,
  source: 'dev',
  installedAt: '2026-01-01T00:00:00.000Z',
  grantedCapabilities: ['uiControl']
})

let tmp: string
let broadcastCount: number

/**
 * 组装 deps：entries 顺序即安装顺序；manifest 视图从内存表读取。
 * refreshAll 现对声明式视图过 FS 闸（verifyViewFiles），默认按 manifest 声明铺出
 * 真实入口文件让既有用例语义不变（均用 viewDef 默认 entry = views/{id}.html）；
 * FS 闸用例以 layoutFiles:false 关掉，自行控制盘面。logWarn 落 warnings 供断言。
 */
function makeDeps(
  entries: PluginRegistryEntry[],
  manifestViews: Map<string, PluginViewDefinition[]>,
  opts: { layoutFiles?: boolean } = {}
): ViewRegistryDeps & { entries: PluginRegistryEntry[]; warnings: string[] } {
  if (opts.layoutFiles !== false) {
    for (const [pid, views] of manifestViews) {
      for (const v of views) layOutView(join(tmp, pid), v.id)
    }
  }
  const deps: ViewRegistryDeps & { entries: PluginRegistryEntry[]; warnings: string[] } = {
    entries,
    warnings: [],
    getEnabledEntries: () => deps.entries.filter((e) => e.enabled),
    pluginDirOf: (e) => join(tmp, e.path),
    readManifestViews: (e) => manifestViews.get(e.id) ?? [],
    broadcast: () => {
      broadcastCount++
    },
    logWarn: (msg, ...rest) => {
      deps.warnings.push([msg, ...rest].join(' '))
    }
  }
  return deps
}

const viewDef = (id: string, extra: Partial<PluginViewDefinition> = {}): PluginViewDefinition => ({
  id,
  title: `V ${id}`,
  entry: `views/${id}.html`,
  ...extra
})

/** 在插件目录里铺一个最小可用视图：views/{id}.html（可选 icon） */
function layOutView(pluginDir: string, id: string, opts: { icon?: string } = {}): void {
  const views = join(pluginDir, 'views')
  mkdirSync(views, { recursive: true })
  writeFileSync(join(views, `${id}.html`), `<html>${id}</html>`, 'utf-8')
  if (opts.icon) {
    const iconPath = join(pluginDir, opts.icon)
    mkdirSync(join(iconPath, '..'), { recursive: true })
    writeFileSync(iconPath, '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf-8')
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lyshell-viewreg-'))
  broadcastCount = 0
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('PluginViewRegistry 合并与排序', () => {
  it('声明式视图按插件安装序 + manifest 序排列，source=manifest', () => {
    const manifestViews = new Map<string, PluginViewDefinition[]>([
      ['p2', [viewDef('b'), viewDef('a')]],
      ['p1', [viewDef('z')]]
    ])
    // deps.entries 顺序即安装顺序：p1 在 p2 前
    const reg = new PluginViewRegistry(makeDeps([entry('p1', 'p1'), entry('p2', 'p2')], manifestViews))
    reg.refreshAll()
    const views = reg.listViews()
    expect(views.map((v) => `${v.pluginId}/${v.id}`)).toEqual(['p1/z', 'p2/b', 'p2/a'])
    expect(views.every((v) => v.source === 'manifest')).toBe(true)
    expect(views[0]).toMatchObject({ pluginId: 'p1', id: 'z', title: 'V z', entry: 'views/z.html' })
  })

  it('运行时视图排在同插件声明式之后，按注册序', () => {
    const manifestViews = new Map([['p1', [viewDef('m1'), viewDef('m2')]]])
    const deps = makeDeps([entry('p1', 'p1')], manifestViews)
    const reg = new PluginViewRegistry(deps)
    reg.refreshAll()
    layOutView(join(tmp, 'p1'), 'r1')
    layOutView(join(tmp, 'p1'), 'r2')
    reg.registerRuntimeView('p1', viewDef('r2'))
    reg.registerRuntimeView('p1', viewDef('r1'))
    expect(reg.listViews().map((v) => `${v.source}:${v.id}`)).toEqual([
      'manifest:m1',
      'manifest:m2',
      'runtime:r2',
      'runtime:r1'
    ])
  })

  it('禁用插件不出现在 listViews；getView 对禁用插件返回 null', () => {
    const manifestViews = new Map([['p1', [viewDef('m1')]]])
    const deps = makeDeps([entry('p1', 'p1')], manifestViews)
    const reg = new PluginViewRegistry(deps)
    reg.refreshAll()
    expect(reg.listViews()).toHaveLength(1)
    deps.entries[0].enabled = false
    expect(reg.listViews()).toHaveLength(0)
    expect(reg.getView('p1', 'm1')).toBeNull()
    expect(reg.isPluginEnabled('p1')).toBe(false)
  })

  it('getView 命中与未命中', () => {
    const manifestViews = new Map([['p1', [viewDef('m1')]]])
    const reg = new PluginViewRegistry(makeDeps([entry('p1', 'p1')], manifestViews))
    reg.refreshAll()
    expect(reg.getView('p1', 'm1')?.source).toBe('manifest')
    expect(reg.getView('p1', 'nope')).toBeNull()
    expect(reg.getView('other', 'm1')).toBeNull()
  })

  it('getViewByEntry 按 URL 相对路径（已剥 views/ 前缀）命中并携带 connectOrigins', () => {
    const manifestViews = new Map([
      ['p1', [viewDef('m1', { connectOrigins: ['http://127.0.0.1:31517'] }), viewDef('sub', { entry: 'views/sub/page.html' })]]
    ])
    const reg = new PluginViewRegistry(makeDeps([entry('p1', 'p1')], manifestViews))
    // 子目录 entry 需手动铺设（layOutView 只铺 views/{id}.html）
    mkdirSync(join(tmp, 'p1', 'views', 'sub'), { recursive: true })
    writeFileSync(join(tmp, 'p1', 'views', 'sub', 'page.html'), '<html>sub</html>', 'utf-8')
    reg.refreshAll()
    expect(reg.getViewByEntry('p1', 'm1.html')?.connectOrigins).toEqual(['http://127.0.0.1:31517'])
    expect(reg.getViewByEntry('p1', 'sub/page.html')?.id).toBe('sub')
    expect(reg.getViewByEntry('p1', 'nope.html')).toBeNull()
    expect(reg.getViewByEntry('other', 'm1.html')).toBeNull()
  })
})

describe('registerRuntimeView', () => {
  function makeReg(manifestViews: Map<string, PluginViewDefinition[]> = new Map()) {
    const deps = makeDeps([entry('p1', 'p1')], manifestViews)
    const reg = new PluginViewRegistry(deps)
    reg.refreshAll()
    return { reg, deps }
  }

  it('合法定义注册成功并广播', () => {
    const { reg } = makeReg()
    layOutView(join(tmp, 'p1'), 'r1', { icon: 'icon.svg' })
    const before = broadcastCount
    const meta = reg.registerRuntimeView('p1', viewDef('r1', { icon: 'icon.svg' }))
    expect(meta).toMatchObject({ id: 'r1', pluginId: 'p1', source: 'runtime' })
    expect(broadcastCount).toBe(before + 1)
  })

  it('拒绝未启用插件', () => {
    const { reg, deps } = makeReg()
    deps.entries[0].enabled = false
    expect(() => reg.registerRuntimeView('p1', viewDef('r1'))).toThrow(ViewRegistrationError)
  })

  it('拒绝与声明式/运行时重复 ID（不覆盖）', () => {
    const { reg } = makeReg(new Map([['p1', [viewDef('m1')]]]))
    layOutView(join(tmp, 'p1'), 'm1')
    expect(() => reg.registerRuntimeView('p1', viewDef('m1'))).toThrow(/already registered/)
    layOutView(join(tmp, 'p1'), 'r1')
    reg.registerRuntimeView('p1', viewDef('r1'))
    expect(() => reg.registerRuntimeView('p1', viewDef('r1'))).toThrow(/already registered/)
    // 冲突后原定义未被覆盖
    expect(reg.getView('p1', 'r1')?.title).toBe('V r1')
  })

  it('拒绝与声明式/运行时重复 entry：entry 是请求期视图身份，共用入口会拿错 connectOrigins CSP', () => {
    const { reg } = makeReg(new Map([['p1', [viewDef('m1')]]]))
    layOutView(join(tmp, 'p1'), 'm1')
    // 与声明式视图同 entry、不同 id
    expect(() => reg.registerRuntimeView('p1', viewDef('x1', { entry: 'views/m1.html' }))).toThrow(
      /entry already registered/
    )
    layOutView(join(tmp, 'p1'), 'r1')
    reg.registerRuntimeView('p1', viewDef('r1'))
    // 与既有运行时视图同 entry
    expect(() => reg.registerRuntimeView('p1', viewDef('x2', { entry: 'views/r1.html' }))).toThrow(
      /entry already registered/
    )
    // 大小写变体同拒（Windows 文件系统不区分大小写）
    expect(() => reg.registerRuntimeView('p1', viewDef('x3', { entry: 'views/R1.html' }))).toThrow(
      /entry already registered/
    )
    // 冲突后既有定义未被覆盖
    expect(reg.getView('p1', 'r1')?.title).toBe('V r1')
    expect(reg.getView('p1', 'x1')).toBeNull()
  })

  it('声明式 + 运行时合计超过 8 拒绝', () => {
    const manifest = Array.from({ length: 6 }, (_, i) => viewDef(`m${i}`))
    const { reg } = makeReg(new Map([['p1', manifest]]))
    for (let i = 0; i < 2; i++) {
      layOutView(join(tmp, 'p1'), `r${i}`)
      reg.registerRuntimeView('p1', viewDef(`r${i}`))
    }
    layOutView(join(tmp, 'p1'), 'r9')
    expect(() => reg.registerRuntimeView('p1', viewDef('r9'))).toThrow(/at most 8/)
  })

  it('拒绝非法定义（复用共享校验器）', () => {
    const { reg } = makeReg()
    expect(() => reg.registerRuntimeView('p1', { id: 'Bad', title: 't', entry: 'views/a.html' })).toThrow(
      /invalid view definition/
    )
    expect(() => reg.registerRuntimeView('p1', { id: 'ok', title: 't', entry: '../evil.html' })).toThrow(
      /invalid view definition/
    )
  })

  it('entry/icon 文件缺失拒绝', () => {
    const { reg } = makeReg()
    mkdirSync(join(tmp, 'p1', 'views'), { recursive: true })
    expect(() => reg.registerRuntimeView('p1', viewDef('ghost'))).toThrow(/entry file not found/)
    layOutView(join(tmp, 'p1'), 'ok1')
    expect(() => reg.registerRuntimeView('p1', viewDef('ok1', { icon: 'nope.svg' }))).toThrow(/icon file not found/)
  })

  it('声明式与运行时 ID 冲突后 refreshAll 不丢运行时', () => {
    const { reg } = makeReg()
    layOutView(join(tmp, 'p1'), 'r1')
    reg.registerRuntimeView('p1', viewDef('r1'))
    reg.refreshAll()
    expect(reg.getView('p1', 'r1')?.source).toBe('runtime')
  })
})

describe('unregisterRuntimeView', () => {
  it('注销存在的运行时视图并广播；注销不存在的幂等返回 false', () => {
    const manifestViews = new Map([['p1', [viewDef('m1')]]])
    const deps = makeDeps([entry('p1', 'p1')], manifestViews)
    const reg = new PluginViewRegistry(deps)
    reg.refreshAll()
    layOutView(join(tmp, 'p1'), 'r1')
    reg.registerRuntimeView('p1', viewDef('r1'))
    const before = broadcastCount
    expect(reg.unregisterRuntimeView('p1', 'r1')).toBe(true)
    expect(broadcastCount).toBe(before + 1)
    expect(reg.getView('p1', 'r1')).toBeNull()
    expect(reg.unregisterRuntimeView('p1', 'r1')).toBe(false)
    expect(reg.hasRuntimeViews('p1')).toBe(false)
  })

  it('不能注销声明式视图', () => {
    const manifestViews = new Map([['p1', [viewDef('m1')]]])
    const reg = new PluginViewRegistry(makeDeps([entry('p1', 'p1')], manifestViews))
    reg.refreshAll()
    expect(reg.unregisterRuntimeView('p1', 'm1')).toBe(false)
    expect(reg.getView('p1', 'm1')).not.toBeNull()
  })
})

describe('生命周期清理', () => {
  const manifestViews = new Map([['p1', [viewDef('m1')]], ['p2', [viewDef('m2')]]])

  function makeTwoPlugins() {
    const deps = makeDeps([entry('p1', 'p1'), entry('p2', 'p2')], manifestViews)
    const reg = new PluginViewRegistry(deps)
    reg.refreshAll()
    for (const p of ['p1', 'p2']) {
      layOutView(join(tmp, p), 'rt')
      reg.registerRuntimeView(p, viewDef('rt'))
    }
    return { reg, deps }
  }

  it('clearRuntimeForPlugin 只清该插件运行时，声明式保持', () => {
    const { reg } = makeTwoPlugins()
    const removed = reg.clearRuntimeForPlugin('p1')
    expect(removed).toEqual(['rt'])
    expect(reg.getView('p1', 'rt')).toBeNull()
    expect(reg.getView('p1', 'm1')).not.toBeNull()
    expect(reg.getView('p2', 'rt')).not.toBeNull()
  })

  it('clearRuntimeForPlugins 批量清（node host 退出语义）', () => {
    const { reg } = makeTwoPlugins()
    const removed = reg.clearRuntimeForPlugins(['p1', 'p2', 'p3'])
    expect(removed).toEqual([['rt'], ['rt'], []])
    expect(reg.listViews().every((v) => v.source === 'manifest')).toBe(true)
  })

  it('clearAllRuntime 清空并广播；空表不广播', () => {
    const { reg } = makeTwoPlugins()
    const before = broadcastCount
    reg.clearAllRuntime()
    expect(broadcastCount).toBe(before + 1)
    reg.clearAllRuntime()
    expect(broadcastCount).toBe(before + 1)
  })

  it('refreshAll 丢弃已禁用插件的声明式与运行时视图并广播', () => {
    const { reg, deps } = makeTwoPlugins()
    deps.entries[0].enabled = false
    const before = broadcastCount
    reg.refreshAll()
    expect(broadcastCount).toBeGreaterThan(before)
    expect(reg.getView('p1', 'm1')).toBeNull()
    expect(reg.getView('p2', 'm2')).not.toBeNull()
    expect(reg.hasRuntimeViews('p1')).toBe(false)
  })

  it('refreshAll 无变化不广播', () => {
    const manifestViews = new Map([['p1', [viewDef('m1')]]])
    const reg = new PluginViewRegistry(makeDeps([entry('p1', 'p1')], manifestViews))
    reg.refreshAll()
    const before = broadcastCount
    reg.refreshAll()
    expect(broadcastCount).toBe(before)
  })

  it('refreshAll 感知 manifest 声明变化（重启用为刷新点）', () => {
    const manifestViews = new Map([['p1', [viewDef('m1')]]])
    const deps = makeDeps([entry('p1', 'p1')], manifestViews)
    const reg = new PluginViewRegistry(deps)
    reg.refreshAll()
    manifestViews.set('p1', [viewDef('m1'), viewDef('m-new')])
    layOutView(join(tmp, 'p1'), 'm-new') // FS 闸要求新声明的入口文件真实存在
    reg.refreshAll()
    expect(reg.getView('p1', 'm-new')).not.toBeNull()
  })

  it('refreshAll 无变化不广播', () => {
    const manifestViews = new Map([['p1', [viewDef('m1')]]])
    const reg = new PluginViewRegistry(makeDeps([entry('p1', 'p1')], manifestViews))
    reg.refreshAll()
    const before = broadcastCount
    reg.refreshAll()
    expect(broadcastCount).toBe(before)
  })
})

describe('声明式 FS 闸（refreshAll 逐项过 verifyViewFiles）', () => {
  it('entry 文件缺失的声明式视图被丢弃并告警，同插件合法视图保留', () => {
    const manifestViews = new Map([['p1', [viewDef('ghost'), viewDef('real')]]])
    const deps = makeDeps([entry('p1', 'p1')], manifestViews, { layoutFiles: false })
    const reg = new PluginViewRegistry(deps)
    layOutView(join(tmp, 'p1'), 'real')
    reg.refreshAll()
    expect(reg.getView('p1', 'real')).not.toBeNull()
    expect(reg.getView('p1', 'ghost')).toBeNull()
    expect(deps.warnings.some((w) => w.includes('p1/ghost') && w.includes('entry file not found'))).toBe(true)
  })

  it('插件目录/views/ 整体缺失：全部声明式视图丢弃（不再出现点了才失败的轨道槽位）', () => {
    const manifestViews = new Map([['p1', [viewDef('m1'), viewDef('m2')]]])
    const reg = new PluginViewRegistry(makeDeps([entry('p1', 'p1')], manifestViews, { layoutFiles: false }))
    reg.refreshAll()
    expect(reg.listViews()).toHaveLength(0)
  })

  it('文件补齐后再次 refreshAll 视图恢复（重启用/重装为刷新点）', () => {
    const manifestViews = new Map([['p1', [viewDef('m1')]]])
    const reg = new PluginViewRegistry(makeDeps([entry('p1', 'p1')], manifestViews, { layoutFiles: false }))
    reg.refreshAll()
    expect(reg.getView('p1', 'm1')).toBeNull()
    layOutView(join(tmp, 'p1'), 'm1')
    reg.refreshAll()
    expect(reg.getView('p1', 'm1')).not.toBeNull()
  })
})

describe('isPathStrictlyInside / verifyViewFiles', () => {
  it('isPathStrictlyInside 基本语义', () => {
    const parent = join(tmp, 'root')
    const child = join(parent, 'views')
    expect(isPathStrictlyInside(child, parent)).toBe(true)
    expect(isPathStrictlyInside(parent, parent)).toBe(false)
    expect(isPathStrictlyInside(tmp, parent)).toBe(false)
  })

  it('verifyViewFiles 接受合法定义', () => {
    const root = join(tmp, 'plug')
    layOutView(root, 'panel', { icon: 'assets/icon.svg' })
    expect(verifyViewFiles(root, viewDef('panel', { icon: 'assets/icon.svg' }))).toBeNull()
  })

  it('verifyViewFiles 拒绝缺失目录/文件', () => {
    const root = join(tmp, 'plug2')
    mkdirSync(root, { recursive: true })
    expect(verifyViewFiles(root, viewDef('panel'))).toMatch(/views\/.* does not exist|directory does not exist/)
    layOutView(root, 'panel')
    expect(verifyViewFiles(root, viewDef('panel'))).toBeNull()
    expect(verifyViewFiles(join(tmp, 'missing-root'), viewDef('panel'))).toMatch(/does not exist/)
  })

  it('verifyViewFiles 拒绝隐藏文件 entry/icon', () => {
    const root = join(tmp, 'plug3')
    layOutView(root, '.secret')
    expect(verifyViewFiles(root, viewDef('.secret'))).toMatch(/hidden file/)
    const root2 = join(tmp, 'plug4')
    layOutView(root2, 'panel', { icon: '.env.svg' })
    expect(verifyViewFiles(root2, viewDef('panel', { icon: '.env.svg' }))).toMatch(/hidden file/)
  })

  it('verifyViewFiles 拒绝 symlink 越界（dev 插件 junction 指向插件根外）', () => {
    const root = join(tmp, 'plug5')
    const outside = join(tmp, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'evil.html'), 'evil', 'utf-8')
    mkdirSync(join(root, 'views'), { recursive: true })
    try {
      symlinkSync(outside, join(root, 'views', 'link'), 'junction')
    } catch {
      // Windows 无符号链接特权：跳过该用例（CI/开发者模式可跑）
      return
    }
    // entry 经 junction 逃出插件根（views/link/evil.html 真实路径在 outside 下）
    expect(verifyViewFiles(root, viewDef('link-evil', { entry: 'views/link/evil.html' }))).toMatch(
      /inside the plugin/
    )
    // icon symlink 越界
    try {
      symlinkSync(join(outside, 'evil.html'), join(root, 'icon.svg'), 'file')
    } catch {
      return
    }
    expect(verifyViewFiles(root, viewDef('panel', { entry: 'views/x.html', icon: 'icon.svg' }))).toMatch(
      /inside the plugin root/
    )
  })

  it('verifyViewFiles 拒绝 entry 为目录', () => {
    const root = join(tmp, 'plug6')
    mkdirSync(join(root, 'views', 'panel.html'), { recursive: true })
    expect(verifyViewFiles(root, viewDef('panel'))).toMatch(/must be a file/)
  })
})

describe('视图目录铺设辅助（测试自身一致性）', () => {
  it('layOutView 生成的文件确实存在', () => {
    const root = join(tmp, 'plugX')
    layOutView(root, 'a', { icon: 'icon.svg' })
    expect(existsSync(join(root, 'views', 'a.html'))).toBe(true)
    expect(existsSync(join(root, 'icon.svg'))).toBe(true)
  })
})
