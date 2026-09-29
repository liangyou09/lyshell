/**
 * view-icons 单元测试 -- SVG 图标净化（纯函数）与受限图标读取（注册表单例 + 临时目录）。
 *
 * readPluginViewIconDataUrl 依赖 view-registry 单例：用 initPluginViewRegistry 注入
 * 测试 deps（对齐 view-registry.test.ts 的临时目录模式）；「未初始化降级 null」用例
 * 依赖文件内首个用例先于任何 init 执行（vitest 单文件内按声明序、worker 隔离）。
 * symlink 用例 Windows 无特权时跳过（junction 仅对目录可用，这里对文件用 file 链接）。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sanitizeSvgForIcon, readPluginViewIconDataUrl, MAX_VIEW_ICON_BYTES } from './view-icons'
import { initPluginViewRegistry, type ViewRegistryDeps } from './view-registry'
import type { PluginRegistryEntry, PluginViewDefinition } from '@shared/plugin-types'

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

/** 组装并装配单例：p1 位于 {tmp}/p1，声明视图从内存表读取 */
function initRegistry(manifestViews: PluginViewDefinition[]): void {
  const deps: ViewRegistryDeps = {
    getEnabledEntries: () => [entry('p1', 'p1')],
    pluginDirOf: (e) => join(tmp, e.path),
    readManifestViews: (e) => (e.id === 'p1' ? manifestViews : []),
    broadcast: () => {}
  }
  // refreshAll 的声明式 FS 闸要求入口文件真实存在：按声明铺出 views/{id}.html
  for (const v of manifestViews) {
    mkdirSync(join(tmp, 'p1', 'views'), { recursive: true })
    writeFileSync(join(tmp, 'p1', 'views', `${v.id}.html`), `<html>${v.id}</html>`, 'utf-8')
  }
  initPluginViewRegistry(deps).refreshAll()
}

const viewDef = (id: string, icon?: string): PluginViewDefinition => ({
  id,
  title: `V ${id}`,
  entry: `views/${id}.html`,
  ...(icon !== undefined ? { icon } : {})
})

describe('sanitizeSvgForIcon（纯函数）', () => {
  it('剥除 script 元素（成对/自闭合/未闭合）', () => {
    expect(sanitizeSvgForIcon('<svg><script>alert(1)</script><circle r="1"/></svg>')).not.toContain('alert')
    expect(sanitizeSvgForIcon('<svg><script src="https://evil.example/x.js"/></svg>')).not.toContain('script')
    // 未闭合 script 的标签本身剥除；残留内容是纯文本节点，无执行向量
    expect(sanitizeSvgForIcon('<svg><script>alert(1)</svg>')).not.toContain('<script')
  })

  it('剥除 foreignObject 与注释 / DOCTYPE / ENTITY', () => {
    expect(sanitizeSvgForIcon('<svg><foreignObject><body onload="x()"/></foreignObject></svg>')).not.toContain('foreignObject')
    expect(sanitizeSvgForIcon('<svg><!-- <script>alert(1)</script> --></svg>')).not.toContain('script')
    expect(sanitizeSvgForIcon('<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///c:/win.ini">]><svg/>')).not.toContain('ENTITY')
  })

  it('剥除 on* 事件属性', () => {
    const out = sanitizeSvgForIcon('<svg onload="alert(1)" width="10"><rect onmouseover="x()"/></svg>')
    expect(out).not.toContain('onload')
    expect(out).not.toContain('onmouseover')
    expect(out).toContain('width="10"') // 良性属性保留
  })

  it('危险协议 URL（javascript:/vbscript:/data:text/html）清空', () => {
    expect(sanitizeSvgForIcon('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript')
    expect(sanitizeSvgForIcon('<a xlink:href="vbscript:x">x</a>')).not.toContain('vbscript')
    expect(sanitizeSvgForIcon('<image src="data:text/html;base64,PHNjcmlwdD4=" />')).not.toContain('data:text/html')
    expect(sanitizeSvgForIcon('<a href="https://example.com/ok">x</a>')).toContain('https://example.com/ok')
  })

  it('use 引用仅允许同文档 #fragment；良性 SVG 原样保留', () => {
    expect(sanitizeSvgForIcon('<use href="https://evil.example/s.svg#x"/>')).not.toContain('evil.example')
    expect(sanitizeSvgForIcon('<use href="#shape"/>')).toContain('#shape')
    const benign = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 2l7 7"/></svg>'
    expect(sanitizeSvgForIcon(benign)).toBe(benign)
  })
})

describe('readPluginViewIconDataUrl', () => {
  it('注册表未初始化降级 null（不抛错）', () => {
    expect(readPluginViewIconDataUrl('p1', 'panel')).toBeNull()
  })

  it('视图不存在 / 未声明 icon 返回 null', () => {
    tmp = mkdtempSync(join(tmpdir(), 'lyshell-viewicon-'))
    try {
      initRegistry([viewDef('panel')])
      expect(readPluginViewIconDataUrl('p1', 'nope')).toBeNull()
      expect(readPluginViewIconDataUrl('p1', 'panel')).toBeNull()
      expect(readPluginViewIconDataUrl('other', 'panel')).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('扩展名白名单（仅 .svg/.png）', () => {
    tmp = mkdtempSync(join(tmpdir(), 'lyshell-viewicon-'))
    try {
      mkdirSync(join(tmp, 'p1'), { recursive: true })
      writeFileSync(join(tmp, 'p1', 'icon.gif'), 'gif', 'utf-8')
      initRegistry([viewDef('panel', 'icon.gif')])
      expect(readPluginViewIconDataUrl('p1', 'panel')).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('文件缺失 / 空文件 / 超限 / 隐藏文件返回 null', () => {
    tmp = mkdtempSync(join(tmpdir(), 'lyshell-viewicon-'))
    try {
      mkdirSync(join(tmp, 'p1'), { recursive: true })
      writeFileSync(join(tmp, 'p1', 'empty.svg'), '', 'utf-8')
      const big = '<svg>' + 'a'.repeat(MAX_VIEW_ICON_BYTES) + '</svg>'
      writeFileSync(join(tmp, 'p1', 'big.svg'), big, 'utf-8')
      expect(statSync(join(tmp, 'p1', 'big.svg')).size).toBeGreaterThan(MAX_VIEW_ICON_BYTES)
      writeFileSync(join(tmp, 'p1', '.secret.svg'), '<svg/>', 'utf-8')
      initRegistry([
        viewDef('a', 'missing.svg'),
        viewDef('b', 'empty.svg'),
        viewDef('c', 'big.svg'),
        viewDef('d', '.secret.svg')
      ])
      expect(readPluginViewIconDataUrl('p1', 'a')).toBeNull()
      expect(readPluginViewIconDataUrl('p1', 'b')).toBeNull()
      expect(readPluginViewIconDataUrl('p1', 'c')).toBeNull()
      expect(readPluginViewIconDataUrl('p1', 'd')).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('SVG 经净化后以 data URL 返回', () => {
    tmp = mkdtempSync(join(tmpdir(), 'lyshell-viewicon-'))
    try {
      mkdirSync(join(tmp, 'p1'), { recursive: true })
      writeFileSync(join(tmp, 'p1', 'icon.svg'), '<svg onload="x()"><script>alert(1)</script><circle r="1"/></svg>', 'utf-8')
      initRegistry([viewDef('panel', 'icon.svg')])
      const url = readPluginViewIconDataUrl('p1', 'panel')
      expect(url).toMatch(/^data:image\/svg\+xml;base64,/)
      const decoded = Buffer.from(url!.slice(url!.indexOf(',') + 1), 'base64').toString('utf-8')
      expect(decoded).toContain('<circle')
      expect(decoded).not.toContain('script')
      expect(decoded).not.toContain('onload')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('PNG 原样以 data URL 返回（不做净化）', () => {
    tmp = mkdtempSync(join(tmpdir(), 'lyshell-viewicon-'))
    try {
      mkdirSync(join(tmp, 'p1'), { recursive: true })
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      writeFileSync(join(tmp, 'p1', 'icon.png'), png)
      initRegistry([viewDef('panel', 'icon.png')])
      const url = readPluginViewIconDataUrl('p1', 'panel')
      expect(url).toBe(`data:image/png;base64,${png.toString('base64')}`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('symlink 指向插件根外拒绝（无特权平台跳过）', () => {
    tmp = mkdtempSync(join(tmpdir(), 'lyshell-viewicon-'))
    try {
      mkdirSync(join(tmp, 'p1'), { recursive: true })
      const outside = join(tmp, 'outside')
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, 'evil.svg'), '<svg/>', 'utf-8')
      try {
        symlinkSync(join(outside, 'evil.svg'), join(tmp, 'p1', 'icon.svg'), 'file')
      } catch {
        return // Windows 无符号链接特权：跳过
      }
      initRegistry([viewDef('panel', 'icon.svg')])
      expect(readPluginViewIconDataUrl('p1', 'panel')).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
