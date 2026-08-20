/**
 * 启动命令构造 —— 仅 codex/claude 走「CLI + 可选 --model 参数」路径；
 * dsh 的启动命令是固定的 `dsh-tui`（模型走 cordis.patch.yml，见 config.ts 的 prepareModel）。
 *
 * 模型串由用户在工作区配置里填写，最终以单条命令字符串交给 shell 执行，
 * 故做保守白名单校验，拒绝空格/引号/`$`/反引号等 shell 元字符，避免命令注入。
 */

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
 * 构造 `binary [--model X]`。model 缺省时只返回 binary；存在则校验并拼接。
 * 校验失败返回 error（由 launch handler 拒绝启动，而非静默丢弃模型）。
 */
export function buildCliLaunchCommand(binary: string, model?: string): LaunchCommandResult {
  if (!model) return { ok: true, command: binary }
  const r = validateModelArg(model)
  if (!r.ok) return r
  return { ok: true, command: `${binary} --model ${r.value}` }
}
