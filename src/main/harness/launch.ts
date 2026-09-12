/**
 * 启动命令构造 —— 仅 codex/claude 走「CLI + 可选 --model 参数」路径；
 * dsh 的启动命令是固定的 `dsh-tui`（模型走 cordis.patch.yml，见 config.ts 的 prepareModel）。
 * claude 另可拼 --dangerously-skip-permissions / --permission-mode <mode>（工作区权限模式下拉，
 * 见 HarnessWorkspace.claudePermissions）；codex 另可拼 -c default_permissions=<档位>
 * （工作区下拉，见 HarnessWorkspace.codexPermissions；danger 档同时拼 -c approval_policy=never
 * —— 与 Codex /permissions 菜单的 Full Access 预设对齐）。
 *
 * 模型串由用户在工作区配置里填写，最终以单条命令字符串交给 shell 执行，
 * 故做保守白名单校验，拒绝空格/引号/`$`/反引号等 shell 元字符，避免命令注入。
 */

import { isClaudePermissionMode, isCodexPermissionProfile, type ClaudePermissionMode, type CodexPermissionProfile } from '@shared/harness'

export type LaunchCommandResult = { ok: true; command: string } | { ok: false; error: string }

/** 模型名白名单：字母/数字/点/下划线/冒号/连字符（覆盖 gpt-5-codex、claude-sonnet-5 等常见命名） */
const MODEL_RE = /^[A-Za-z0-9._:-]+$/

/** 校验模型名，返回归一化结果；空串/非法字符拒绝。 */
export function validateModelArg(model: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = model.trim()
  if (trimmed.length === 0) return { ok: false, error: 'workspace.model must not be empty' }
  if (!MODEL_RE.test(trimmed)) {
    return { ok: false, error: 'workspace.model contains characters not allowed in a CLI argument' }
  }
  return { ok: true, value: trimmed }
}

/**
 * 构造 `binary [--model X] [--dangerously-skip-permissions | --permission-mode M] [-c default_permissions=P]`。
 * model 缺省时省略 --model；claudePermissions 仅 claude 传值（枚举字面量，无注入面，仍过
 * isClaudePermissionMode 兜底 —— 手工编辑 JSON 可绕过 add/update 校验）：bypassPermissions
 * 档拼 --dangerously-skip-permissions 直连 flag（--permission-mode bypassPermissions 形态
 * 需 allowDangerouslySkipPermissions 设置才生效），acceptEdits/plan 档拼
 * --permission-mode <mode>，default/缺省不追加；codexPermissions 仅 codex 传值（同款兜底）。
 * danger 档另拼 `-c approval_policy=never`：只关沙箱不关审批时 codex /status 显示
 * 「No Sandbox (Ask for approval)」仍会弹审批，加上这条才是菜单 Full Access 预设的
 * 完整语义（见 codex-rs utils/approval-presets 的 full-access 项）。
 * 校验失败返回 error（由 launch handler 拒绝启动，而非静默丢弃模型/档位）。
 */
export function buildCliLaunchCommand(
  binary: string,
  model?: string,
  claudePermissions?: ClaudePermissionMode,
  codexPermissions?: CodexPermissionProfile
): LaunchCommandResult {
  const parts = [binary]
  if (model) {
    const r = validateModelArg(model)
    if (!r.ok) return r
    parts.push(`--model ${r.value}`)
  }
  if (claudePermissions !== undefined && claudePermissions !== 'default') {
    // 值若非枚举字面量即拒绝：档位串最终进 shell 命令行，白名单是唯一防线
    if (!isClaudePermissionMode(claudePermissions)) {
      return { ok: false, error: 'workspace.claudePermissions is not a valid permission mode' }
    }
    if (claudePermissions === 'bypassPermissions') {
      parts.push('--dangerously-skip-permissions')
    } else {
      parts.push(`--permission-mode ${claudePermissions}`)
    }
  }
  if (codexPermissions !== undefined) {
    // 值若非枚举字面量即拒绝：档位串最终进 shell 命令行，白名单是唯一防线
    if (!isCodexPermissionProfile(codexPermissions)) {
      return { ok: false, error: 'workspace.codexPermissions is not a valid permission profile' }
    }
    parts.push(`-c default_permissions=${codexPermissions}`)
    if (codexPermissions === ':danger-full-access') {
      parts.push('-c approval_policy=never')
    }
  }
  return { ok: true, command: parts.join(' ') }
}
