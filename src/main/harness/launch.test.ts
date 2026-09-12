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

  it('claudePermissions 四档各自拼参：bypass 档直连 flag，acceptEdits/plan 走 --permission-mode', () => {
    // bypassPermissions 拼直连 flag（--permission-mode bypassPermissions 形态需额外设置）
    expect(buildCliLaunchCommand('claude', undefined, 'bypassPermissions')).toEqual({
      ok: true,
      command: 'claude --dangerously-skip-permissions'
    })
    expect(buildCliLaunchCommand('claude', 'claude-sonnet-5', 'bypassPermissions')).toEqual({
      ok: true,
      command: 'claude --model claude-sonnet-5 --dangerously-skip-permissions'
    })
    expect(buildCliLaunchCommand('claude', undefined, 'acceptEdits')).toEqual({
      ok: true,
      command: 'claude --permission-mode acceptEdits'
    })
    expect(buildCliLaunchCommand('claude', undefined, 'plan')).toEqual({
      ok: true,
      command: 'claude --permission-mode plan'
    })
  })

  it('claudePermissions default/缺省不追加参数（claude CLI 默认形态）', () => {
    expect(buildCliLaunchCommand('claude', undefined, 'default')).toEqual({ ok: true, command: 'claude' })
    expect(buildCliLaunchCommand('claude', undefined, undefined)).toEqual({ ok: true, command: 'claude' })
    // codex 路径不受 claude 档位参数影响（字段仅 claude 有意义）
    expect(buildCliLaunchCommand('codex', 'gpt-5', 'default')).toEqual({ ok: true, command: 'codex --model gpt-5' })
  })

  it('claudePermissions 非枚举字面量拒绝启动（防手工 JSON 绕过 IPC 校验）', () => {
    // @ts-expect-error 脏数据路径：运行期值可能来自手工编辑的 JSON，非枚举字面量
    expect(buildCliLaunchCommand('claude', undefined, 'bypass').ok).toBe(false)
    // @ts-expect-error 同上 —— 注入串同样按非法档位拒绝
    expect(buildCliLaunchCommand('claude', undefined, 'default; rm -rf /').ok).toBe(false)
    // @ts-expect-error 同上 —— auto/dontAsk 是 CLI 有但面板不收的档位
    expect(buildCliLaunchCommand('claude', undefined, 'auto').ok).toBe(false)
    // @ts-expect-error 同上 —— dontAsk 同为面板不收的档位
    expect(buildCliLaunchCommand('claude', undefined, 'dontAsk').ok).toBe(false)
  })

  it('codexPermissions 三档各自拼 -c default_permissions=<档位>（不加引号，值无 shell 元字符）', () => {
    expect(buildCliLaunchCommand('codex', undefined, undefined, ':read-only')).toEqual({
      ok: true,
      command: 'codex -c default_permissions=:read-only'
    })
    expect(buildCliLaunchCommand('codex', undefined, undefined, ':workspace')).toEqual({
      ok: true,
      command: 'codex -c default_permissions=:workspace'
    })
    // danger 档同时关审批 —— 只关沙箱不关审批不是菜单 Full Access 预设的完整语义
    expect(buildCliLaunchCommand('codex', undefined, undefined, ':danger-full-access')).toEqual({
      ok: true,
      command: 'codex -c default_permissions=:danger-full-access -c approval_policy=never'
    })
  })

  it('codexPermissions 与 --model 同时出现时按序拼接', () => {
    expect(buildCliLaunchCommand('codex', 'gpt-5-codex', undefined, ':danger-full-access')).toEqual({
      ok: true,
      command: 'codex --model gpt-5-codex -c default_permissions=:danger-full-access -c approval_policy=never'
    })
  })

  it('codexPermissions 非枚举字面量拒绝启动（防手工 JSON 绕过 IPC 校验）', () => {
    // @ts-expect-error 脏数据路径：运行期值可能来自手工编辑的 JSON，非枚举字面量
    expect(buildCliLaunchCommand('codex', undefined, undefined, 'danger-full-access').ok).toBe(false)
    // @ts-expect-error 同上 —— 注入串同样按非法档位拒绝
    expect(buildCliLaunchCommand('codex', undefined, undefined, ':workspace; rm -rf /').ok).toBe(false)
    // @ts-expect-error 同上 —— 空串拒绝
    expect(buildCliLaunchCommand('codex', undefined, undefined, '').ok).toBe(false)
  })

  it('codexPermissions 缺省（undefined）不追加参数，跟随 Codex 默认链', () => {
    expect(buildCliLaunchCommand('codex', 'gpt-5', undefined, undefined)).toEqual({
      ok: true,
      command: 'codex --model gpt-5'
    })
  })

  it('claude 路径不受 codexPermissions 影响（字段仅 codex 有意义）', () => {
    expect(buildCliLaunchCommand('claude', 'claude-sonnet-5', 'bypassPermissions', undefined)).toEqual({
      ok: true,
      command: 'claude --model claude-sonnet-5 --dangerously-skip-permissions'
    })
  })
})
