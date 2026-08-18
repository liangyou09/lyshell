import { describe, it, expect } from 'vitest'
import { validateModelArg, buildCliLaunchCommand } from './launch'

/**
 * 安全敏感纯函数测试：validateModelArg / buildCliLaunchCommand 的模型名白名单
 * （MODEL_RE）是防命令注入的唯一防线 —— 模型串最终经 PTY 按键送入交互式 shell 解释。
 * 覆盖：合法模型、空模型（省略 --model）、含 shell 元字符的注入串（拒绝）。
 */

describe('validateModelArg', () => {
  it('接受合法模型名', () => {
    expect(validateModelArg('gpt-5-codex')).toEqual({ ok: true, value: 'gpt-5-codex' })
    expect(validateModelArg('claude-sonnet-5')).toEqual({ ok: true, value: 'claude-sonnet-5' })
    expect(validateModelArg('o3')).toEqual({ ok: true, value: 'o3' })
  })

  it('接受白名单内的分隔符（点/下划线/冒号/连字符）', () => {
    expect(validateModelArg('gpt-5.1:codex_v2')).toEqual({ ok: true, value: 'gpt-5.1:codex_v2' })
  })

  it('trim 前后空白后接受', () => {
    expect(validateModelArg('  claude-sonnet-5  ')).toEqual({ ok: true, value: 'claude-sonnet-5' })
  })

  it('空串/纯空白拒绝', () => {
    expect(validateModelArg('')).toEqual({ ok: false, error: 'workspace.model must not be empty' })
    expect(validateModelArg('   ')).toEqual({ ok: false, error: 'workspace.model must not be empty' })
  })

  it('拒绝 shell 注入元字符（空格/引号/分号/$/反引号等）', () => {
    const injections = [
      'gpt-5; rm -rf /', // 分号 + 空格
      'gpt-5 --model x', // 空格（额外参数）
      'gpt-5 && echo',   // & 拼接
      'gpt"5',           // 双引号
      "gpt'5",           // 单引号
      '$(id)',           // $ 命令替换
      '`id`',            // 反引号
      'gpt|cat',         // 管道
      'gpt>file',        // 重定向
      'gpt\nls',         // 换行
      'anthropic/claude-3-5-sonnet' // 斜杠（不在白名单）
    ]
    for (const m of injections) {
      expect(validateModelArg(m).ok).toBe(false)
    }
  })
})

describe('buildCliLaunchCommand', () => {
  it('model 缺省时只返回 binary', () => {
    expect(buildCliLaunchCommand('codex')).toEqual({ ok: true, command: 'codex' })
    expect(buildCliLaunchCommand('claude', undefined)).toEqual({ ok: true, command: 'claude' })
  })

  it('空串 model 视为缺省，省略 --model', () => {
    expect(buildCliLaunchCommand('codex', '')).toEqual({ ok: true, command: 'codex' })
  })

  it('合法模型拼接 --model', () => {
    expect(buildCliLaunchCommand('codex', 'gpt-5-codex')).toEqual({ ok: true, command: 'codex --model gpt-5-codex' })
    expect(buildCliLaunchCommand('claude', 'claude-sonnet-5')).toEqual({ ok: true, command: 'claude --model claude-sonnet-5' })
  })

  it('非法模型拒绝启动（不拼进命令）', () => {
    expect(buildCliLaunchCommand('codex', 'gpt-5; rm -rf /').ok).toBe(false)
    expect(buildCliLaunchCommand('claude', '`id`').ok).toBe(false)
    expect(buildCliLaunchCommand('claude', 'x"y').ok).toBe(false)
  })
})
