import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// electron-log 在 Node 测试环境不存在，mock 掉（对齐 harness-env-profile-repository.test.ts）
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))

import { presetCodexBaseUrl } from './base-url-preset'

// codexHome 解析链要读系统 CODEX_HOME —— 测试全程钉死为未设置，避免宿主机环境泄漏进断言
const origCodexHome = process.env.CODEX_HOME

let dir: string

beforeEach(() => {
  delete process.env.CODEX_HOME
  dir = mkdtempSync(join(tmpdir(), 'codex-preset-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (origCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = origCodexHome
})

const configPath = () => join(dir, 'config.toml')

/** 用户真实布局样例：顶层 model_provider 选中 [model_providers.custom] */
const REAL_LAYOUT = [
  'model_provider = "custom"',
  'model = "GLM-5.2"',
  'model_reasoning_effort = "medium"',
  '',
  '[model_providers.custom]',
  'name = "custom"',
  'wire_api = "responses"',
  'base_url = "http://127.0.0.1:18443/v1"',
  '',
  '[projects.\'d:\\workspace\\claude\\lyshell\']',
  'trust_level = "trusted"',
  ''
].join('\n')

describe('presetCodexBaseUrl', () => {
  it('更新当前 provider 表的 base_url，其余内容逐字保留', () => {
    writeFileSync(configPath(), REAL_LAYOUT, 'utf-8')
    const r = presetCodexBaseUrl({
      CODEX_HOME: dir,
      OPENAI_BASE_URL: 'https://1.1.1.3:8443/v1'
    })
    expect(r).toEqual({ ok: true })
    const after = readFileSync(configPath(), 'utf-8')
    expect(after).toContain('base_url = "https://1.1.1.3:8443/v1"')
    expect(after).toContain('model = "GLM-5.2"')
    expect(after).toContain('wire_api = "responses"')
    expect(after).toContain('trust_level = "trusted"')
    expect(after).not.toContain('127.0.0.1:18443')
  })

  it('env 未提供 OPENAI_BASE_URL 时完全不动文件（存在则内容不变，缺失则不创建）', () => {
    writeFileSync(configPath(), REAL_LAYOUT, 'utf-8')
    expect(presetCodexBaseUrl({ CODEX_HOME: dir })).toEqual({ ok: true })
    expect(presetCodexBaseUrl({ CODEX_HOME: dir, OPENAI_BASE_URL: '   ' })).toEqual({ ok: true })
    expect(readFileSync(configPath(), 'utf-8')).toBe(REAL_LAYOUT)

    const emptyDir = join(dir, 'nested')
    expect(presetCodexBaseUrl({ CODEX_HOME: emptyDir })).toEqual({ ok: true })
    expect(existsSync(join(emptyDir, 'config.toml'))).toBe(false)
  })

  it('文件缺失时创建最小配置（model_provider + provider 表 + 尾换行）', () => {
    const r = presetCodexBaseUrl({ CODEX_HOME: dir, OPENAI_BASE_URL: 'https://relay/v1' })
    expect(r).toEqual({ ok: true })
    expect(readFileSync(configPath(), 'utf-8')).toBe(
      [
        'model_provider = "lyshell"',
        '',
        '[model_providers.lyshell]',
        'name = "lyshell"',
        'base_url = "https://relay/v1"',
        ''
      ].join('\n')
    )
  })

  it('顶层缺 model_provider 但已有其它内容：选择器插在首个表头之前', () => {
    writeFileSync(configPath(), ['model = "GLM-5.2"', '', '[tui]', 'notify = true', ''].join('\n'), 'utf-8')
    const r = presetCodexBaseUrl({ CODEX_HOME: dir, OPENAI_BASE_URL: 'https://relay/v1' })
    expect(r).toEqual({ ok: true })
    const after = readFileSync(configPath(), 'utf-8')
    expect(after.indexOf('model_provider = "lyshell"')).toBeLessThan(after.indexOf('[tui]'))
    expect(after).toContain('[model_providers.lyshell]')
    expect(after).toContain('notify = true')
  })

  it('目标表内没有 base_url 时紧随表头插入', () => {
    writeFileSync(
      configPath(),
      ['model_provider = "p1"', '', '[model_providers.p1]', 'name = "p1"', ''].join('\n'),
      'utf-8'
    )
    const r = presetCodexBaseUrl({ CODEX_HOME: dir, OPENAI_BASE_URL: 'https://relay/v1' })
    expect(r).toEqual({ ok: true })
    const after = readFileSync(configPath(), 'utf-8')
    expect(after).toContain('[model_providers.p1]\nbase_url = "https://relay/v1"\nname = "p1"')
  })

  it('model_provider 指向不存在的表时文件末尾补建该表', () => {
    writeFileSync(
      configPath(),
      ['model_provider = "zhipu"', 'model = "GLM-5.2"', ''].join('\n'),
      'utf-8'
    )
    const r = presetCodexBaseUrl({ CODEX_HOME: dir, OPENAI_BASE_URL: 'https://relay/v1' })
    expect(r).toEqual({ ok: true })
    const after = readFileSync(configPath(), 'utf-8')
    expect(after).toContain('[model_providers.zhipu]')
    expect(after).toContain('name = "zhipu"')
    expect(after).toContain('base_url = "https://relay/v1"')
    // 顶层键仍在表头之前
    expect(after.indexOf('model = "GLM-5.2"')).toBeLessThan(after.indexOf('[model_providers.zhipu]'))
  })

  it('幂等：同值二次调用不重写，.bak 只在首改时建一份', () => {
    writeFileSync(configPath(), REAL_LAYOUT, 'utf-8')
    presetCodexBaseUrl({ CODEX_HOME: dir, OPENAI_BASE_URL: 'https://relay/v1' })
    const once = readFileSync(configPath(), 'utf-8')
    expect(existsSync(`${configPath()}.bak`)).toBe(true)
    expect(existsSync(`${configPath()}.tmp`)).toBe(false)

    presetCodexBaseUrl({ CODEX_HOME: dir, OPENAI_BASE_URL: 'https://relay/v1' })
    expect(readFileSync(configPath(), 'utf-8')).toBe(once)

    // .bak 保留的是首改前的原始内容，不被后续写入覆盖
    expect(readFileSync(`${configPath()}.bak`, 'utf-8')).toBe(REAL_LAYOUT)
  })

  it('CODEX_HOME 解析链：变量组 env 优先，其次系统环境变量，最后 ~/.codex', () => {
    const homeA = join(dir, 'a')
    const homeB = join(dir, 'b')
    process.env.CODEX_HOME = homeB
    // 变量组有值 → 写 A
    presetCodexBaseUrl({ CODEX_HOME: homeA, OPENAI_BASE_URL: 'https://relay/v1' })
    expect(existsSync(join(homeA, 'config.toml'))).toBe(true)
    expect(existsSync(join(homeB, 'config.toml'))).toBe(false)
    // 变量组没给 CODEX_HOME → 落系统值 B（同一变量组缺 CODEX_HOME 的情况）
    process.env.CODEX_HOME = homeA
    presetCodexBaseUrl({ OPENAI_BASE_URL: 'https://relay/v1' })
    expect(existsSync(join(homeA, 'config.toml'))).toBe(true)
  })

  it('值含双引号或换行时拒绝写入', () => {
    writeFileSync(configPath(), REAL_LAYOUT, 'utf-8')
    expect(presetCodexBaseUrl({ CODEX_HOME: dir, OPENAI_BASE_URL: 'https://x/"y"' })).toMatchObject({ ok: false })
    expect(presetCodexBaseUrl({ CODEX_HOME: dir, OPENAI_BASE_URL: 'https://x/\ny' })).toMatchObject({ ok: false })
    expect(readFileSync(configPath(), 'utf-8')).toBe(REAL_LAYOUT)
  })

  it('值含反斜杠（Windows 路径风格）时正确转义', () => {
    writeFileSync(
      configPath(),
      ['model_provider = "p"', '', '[model_providers.p]', 'base_url = "old"', ''].join('\n'),
      'utf-8'
    )
    const r = presetCodexBaseUrl({ CODEX_HOME: dir, OPENAI_BASE_URL: 'https://x/y\\z' })
    expect(r).toEqual({ ok: true })
    expect(readFileSync(configPath(), 'utf-8')).toContain('base_url = "https://x/y\\\\z"')
  })

  it('带引号的 provider id（[model_providers."a.b"] 形态）也能匹配', () => {
    writeFileSync(
      configPath(),
      [
        'model_provider = "a.b"',
        '',
        '[model_providers."a.b"]',
        'name = "ab"',
        'base_url = "old"',
        ''
      ].join('\n'),
      'utf-8'
    )
    const r = presetCodexBaseUrl({ CODEX_HOME: dir, OPENAI_BASE_URL: 'https://relay/v1' })
    expect(r).toEqual({ ok: true })
    const after = readFileSync(configPath(), 'utf-8')
    expect(after).toContain('base_url = "https://relay/v1"')
    expect(after).toContain('[model_providers."a.b"]')
  })
})
