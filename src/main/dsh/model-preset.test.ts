import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'

// electron-log 在 Node 测试环境不存在，mock 掉（对齐 repository.test.ts）
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))

import { presetDshTuiModel, clearDshTuiModel, DSH_TUI_PROVIDER } from './model-preset'

let tmpHome: string
const ORIGINAL_DSH_HOME = process.env.DSH_HOME

function patchPath(): string {
  return join(tmpHome, 'profiles', 'dsh-tui', 'cordis.patch.yml')
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'lyshell-dsh-home-'))
  process.env.DSH_HOME = tmpHome
  // 预建 profiles/dsh-tui 目录，便于测试直接写已有补丁文件
  mkdirSync(join(tmpHome, 'profiles', 'dsh-tui'), { recursive: true })
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = ORIGINAL_DSH_HOME
})

describe('presetDshTuiModel', () => {
  it('文件不存在时生成含 provider/model 的最小补丁', () => {
    const res = presetDshTuiModel('deepseek-v4-pro')
    expect(res.ok).toBe(true)
    const content = readFileSync(patchPath(), 'utf-8')
    expect(content).toContain(`provider: ${DSH_TUI_PROVIDER}`)
    expect(content).toContain('model: deepseek-v4-pro')
  })

  it('文件存在但无 dsh-tui 条目时追加，并保留其它条目', () => {
    writeFileSync(patchPath(), '- id: other-plugin\n  config:\n    foo: bar\n')
    const res = presetDshTuiModel('deepseek-v4-flash')
    expect(res.ok).toBe(true)
    const content = readFileSync(patchPath(), 'utf-8')
    expect(content).toContain('id: other-plugin')
    expect(content).toContain('foo: bar')
    expect(content).toContain('id: dsh-tui')
    expect(content).toContain('model: deepseek-v4-flash')
  })

  it('覆盖已有 dsh-tui 条目的 provider/model，保留其它 config 字段', () => {
    writeFileSync(
      patchPath(),
      '- id: dsh-tui\n  config:\n    fullscreen: true\n    effort: max\n    provider: deepseek-official\n    model: deepseek-v4-flash\n'
    )
    const res = presetDshTuiModel('deepseek-v4-pro')
    expect(res.ok).toBe(true)
    const content = readFileSync(patchPath(), 'utf-8')
    expect(content).toContain('model: deepseek-v4-pro')
    // config 整块替换语义下，用户已有字段必须保留
    expect(content).toContain('fullscreen: true')
    expect(content).toContain('effort: max')
    expect(content).toContain(`provider: ${DSH_TUI_PROVIDER}`)
  })

  it('保留用户补丁中的 !!js 表达式', () => {
    writeFileSync(
      patchPath(),
      '- id: dsh-tui\n  config:\n    preset: !!js process.env.DSH_TUI_PRESET ?? undefined\n'
    )
    const res = presetDshTuiModel('deepseek-v4-flash')
    expect(res.ok).toBe(true)
    const content = readFileSync(patchPath(), 'utf-8')
    expect(content).toContain('!!js')
    expect(content).toContain('DSH_TUI_PRESET')
    expect(content).toContain('model: deepseek-v4-flash')
  })

  it('顶层非数组时返回 error 且不写入', () => {
    writeFileSync(patchPath(), 'just: a mapping\n')
    const before = readFileSync(patchPath(), 'utf-8')
    const res = presetDshTuiModel('deepseek-v4-flash')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('array')
    expect(readFileSync(patchPath(), 'utf-8')).toBe(before)
  })

  it('解析失败时报 parse（而非 read）错误且不覆盖原文件', () => {
    const broken = '- id: dsh-tui\n  config: [unclosed\n'
    writeFileSync(patchPath(), broken)
    const res = presetDshTuiModel('deepseek-v4-flash')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('Failed to parse')
    expect(readFileSync(patchPath(), 'utf-8')).toBe(broken)
  })

  it('保留用户补丁中的 !!js/undefined 表达式（不抛 unknown tag）', () => {
    writeFileSync(
      patchPath(),
      '- id: dsh-tui\n  config:\n    preset: !!js/undefined\n'
    )
    const res = presetDshTuiModel('deepseek-v4-flash')
    expect(res.ok).toBe(true)
    const content = readFileSync(patchPath(), 'utf-8')
    expect(content).toContain('!!js/undefined')
    expect(content).toContain('model: deepseek-v4-flash')
  })

  it('首次写前备份原始文件到 .bak（保留用户注释恢复点）', () => {
    const original = '# 手写注释\n- id: other-plugin\n  config:\n    foo: bar\n'
    writeFileSync(patchPath(), original)
    const res = presetDshTuiModel('deepseek-v4-flash')
    expect(res.ok).toBe(true)
    expect(readFileSync(`${patchPath()}.bak`, 'utf-8')).toBe(original)
  })

  it('遇到用户自定义 provider 时返回冲突错误且不覆盖', () => {
    const original = '- id: dsh-tui\n  config:\n    provider: my-custom-provider\n    model: my-model\n'
    writeFileSync(patchPath(), original)
    const res = presetDshTuiModel('deepseek-v4-flash')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('custom provider')
    expect(readFileSync(patchPath(), 'utf-8')).toBe(original)
  })

  it('存在多条 dsh-tui 条目时返回冲突错误且不写入', () => {
    const original =
      '- id: dsh-tui\n  config:\n    provider: deepseek-official\n    model: a\n' +
      '- id: dsh-tui\n  config:\n    provider: deepseek-official\n    model: b\n'
    writeFileSync(patchPath(), original)
    const res = presetDshTuiModel('deepseek-v4-flash')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('refusing to guess')
    expect(readFileSync(patchPath(), 'utf-8')).toBe(original)
  })

  it('dsh-tui.config 为数组时返回冲突错误且不覆盖', () => {
    const original = '- id: dsh-tui\n  config:\n    - a\n    - b\n'
    writeFileSync(patchPath(), original)
    const res = presetDshTuiModel('deepseek-v4-flash')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('not a mapping')
    expect(readFileSync(patchPath(), 'utf-8')).toBe(original)
  })

  it('dsh-tui.config 为标量时返回冲突错误且不覆盖', () => {
    const original = '- id: dsh-tui\n  config: just-a-string\n'
    writeFileSync(patchPath(), original)
    const res = presetDshTuiModel('deepseek-v4-flash')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('not a mapping')
    expect(readFileSync(patchPath(), 'utf-8')).toBe(original)
  })

  it('工作区 env.DSH_HOME 覆盖时写入对应目录而非主进程 DSH_HOME', () => {
    const other = mkdtempSync(join(tmpdir(), 'lyshell-dsh-env-home-'))
    try {
      mkdirSync(join(other, 'profiles', 'dsh-tui'), { recursive: true })
      const res = presetDshTuiModel('deepseek-v4-flash', { DSH_HOME: other })
      expect(res.ok).toBe(true)
      expect(readFileSync(join(other, 'profiles', 'dsh-tui', 'cordis.patch.yml'), 'utf-8')).toContain('model: deepseek-v4-flash')
      // 主进程 DSH_HOME 下不应落盘
      expect(existsSync(patchPath())).toBe(false)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('clearDshTuiModel', () => {
  it('移除 provider/model，保留其它 config 字段', () => {
    writeFileSync(
      patchPath(),
      '- id: dsh-tui\n  config:\n    fullscreen: true\n    effort: max\n    provider: deepseek-official\n    model: deepseek-v4-flash\n'
    )
    const res = clearDshTuiModel()
    expect(res.ok).toBe(true)
    const content = readFileSync(patchPath(), 'utf-8')
    expect(content).not.toContain('model:')
    expect(content).not.toContain('provider:')
    expect(content).toContain('fullscreen: true')
    expect(content).toContain('effort: max')
  })

  it('config 清空且无其它字段时移除整个 dsh-tui 条目', () => {
    writeFileSync(
      patchPath(),
      '- id: dsh-tui\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-flash\n'
    )
    const res = clearDshTuiModel()
    expect(res.ok).toBe(true)
    const content = readFileSync(patchPath(), 'utf-8')
    expect(content).not.toContain('dsh-tui')
    expect(content).not.toContain('model:')
  })

  it('无 dsh-tui 条目时清除为幂等 no-op（不写文件）', () => {
    const original = '- id: other-plugin\n  config:\n    foo: bar\n'
    writeFileSync(patchPath(), original)
    const res = clearDshTuiModel()
    expect(res.ok).toBe(true)
    expect(readFileSync(patchPath(), 'utf-8')).toBe(original)
  })

  it('dsh-tui 条目无 provider/model 时清除为幂等 no-op（不写文件）', () => {
    const original = '- id: dsh-tui\n  config:\n    fullscreen: true\n'
    writeFileSync(patchPath(), original)
    const res = clearDshTuiModel()
    expect(res.ok).toBe(true)
    expect(readFileSync(patchPath(), 'utf-8')).toBe(original)
  })

  it('用户自己的 provider/model 路由（非 deepseek-official）不被清除', () => {
    const original = '- id: dsh-tui\n  config:\n    provider: my-custom-provider\n    model: my-model\n'
    writeFileSync(patchPath(), original)
    const res = clearDshTuiModel()
    expect(res.ok).toBe(true)
    expect(readFileSync(patchPath(), 'utf-8')).toBe(original)
  })

  it('仅有用户自写的 model（无 provider）不被清除', () => {
    const original = '- id: dsh-tui\n  config:\n    model: my-model\n'
    writeFileSync(patchPath(), original)
    const res = clearDshTuiModel()
    expect(res.ok).toBe(true)
    expect(readFileSync(patchPath(), 'utf-8')).toBe(original)
  })

  it('存在多条 dsh-tui 条目时清除返回冲突错误且不写入', () => {
    const original =
      '- id: dsh-tui\n  config:\n    provider: deepseek-official\n    model: a\n' +
      '- id: dsh-tui\n  config:\n    provider: deepseek-official\n    model: b\n'
    writeFileSync(patchPath(), original)
    const res = clearDshTuiModel()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('refusing to guess')
    expect(readFileSync(patchPath(), 'utf-8')).toBe(original)
  })

  it('工作区 env.DSH_HOME 覆盖时清除对应目录', () => {
    const other = mkdtempSync(join(tmpdir(), 'lyshell-dsh-env-home-clear-'))
    try {
      mkdirSync(join(other, 'profiles', 'dsh-tui'), { recursive: true })
      const patch = join(other, 'profiles', 'dsh-tui', 'cordis.patch.yml')
      writeFileSync(patch, '- id: dsh-tui\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-flash\n')
      const res = clearDshTuiModel({ DSH_HOME: other })
      expect(res.ok).toBe(true)
      expect(readFileSync(patch, 'utf-8')).not.toContain('model:')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})
