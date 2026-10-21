import type { HarnessEnvProfile } from '@shared/harness'

/**
 * 变量组配置 JSON 解析：Settings > Environment > 新增 里「粘贴 JSON」的唯一真相源。
 * 纯函数，不碰 Node API、不发 IPC —— 解析结果交给调用方走既有 env-profile:add 链路，
 * 落盘校验仍由主进程 IPC 兜底（本文件的上限与它保持一致，不做第二套语义）。
 *
 * 失败只回稳定错误码：JSON 内容（尤其 apiKey）不进错误字符串，也不写日志。
 */
export type EnvProfileJsonResult =
  | { success: true; profile: Omit<HarnessEnvProfile, 'id' | 'order'> }
  | { success: false; error: 'invalidJson' | 'invalidConfig' }

/** 长度/条数上限 —— 与主进程 env-profile:add / :update 的断言逐项对齐，越界即拒。 */
const LIMITS = {
  name: 120,
  note: 2000,
  baseUrl: 2048,
  apiKey: 32768,
  envEntries: 256,
  envKey: 1024,
  envValue: 32768,
  models: 64,
  model: 256
} as const

/**
 * 「像一份变量组配置」的字段集：复制配置只产出这些键。至少出现一个才继续解析，
 * 避免把任意无关 JSON（恰好是对象）当成空的配置草稿吞下去。
 * id / order / activation 是本地记录属性，复制时就不带，出现也一律忽略。
 */
const RECOGNIZED_FIELDS = ['name', 'note', 'baseUrl', 'apiKey', 'env', 'models'] as const

/**
 * 附加变量的禁用键：三个名字会给后续的对象拷贝（materializeProfileEnv 的展开、
 * 对象字面量合并）留原型污染面，直接拒绝而不是静默改名 —— 用户看得见自己的 JSON 没被吃。
 */
const FORBIDDEN_ENV_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 内部哨兵：任一字段不合规即抛出，顶层统一折叠成 invalidConfig，不向调用方暴露细节。 */
class InvalidConfig extends Error {}

/**
 * 解析粘贴进来的 JSON 文本。
 *
 * 成功时返回可直接提交给 env-profile:add 的配置：name 缺省为空串、env 缺省为空记录，
 * note/baseUrl/apiKey/models 缺省则保持「未提供」（不写 undefined 键）。
 * 文本值原样保留（不 trim、不去重、不做 URL 判定）—— 空串是合法草稿，Base URL 语义
 * 交给表单既有预检，规范化交给正常保存链路。
 */
export function parseEnvProfileJson(text: string): EnvProfileJsonResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { success: false, error: 'invalidJson' }
  }

  // 根必须是普通对象：null / 数组 / 标量都是合法 JSON，但不是变量组配置
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { success: false, error: 'invalidConfig' }
  }
  const root = raw as Record<string, unknown>
  if (!RECOGNIZED_FIELDS.some(field => Object.hasOwn(root, field))) {
    return { success: false, error: 'invalidConfig' }
  }

  try {
    const env = parseEnv(root.env)
    const profile: Omit<HarnessEnvProfile, 'id' | 'order'> = {
      // 名称缺失按空串草稿处理，缺失与空串同一语义；长度仍受 120 上限约束
      name: parseOptionalString(root.name, LIMITS.name) ?? '',
      env
    }
    const note = parseOptionalString(root.note, LIMITS.note)
    if (note !== undefined) profile.note = note
    const baseUrl = parseOptionalString(root.baseUrl, LIMITS.baseUrl)
    if (baseUrl !== undefined) profile.baseUrl = baseUrl
    const apiKey = parseOptionalString(root.apiKey, LIMITS.apiKey)
    if (apiKey !== undefined) profile.apiKey = apiKey
    const models = parseModels(root.models)
    if (models !== undefined) profile.models = models
    return { success: true, profile }
  } catch (error) {
    if (error instanceof InvalidConfig) return { success: false, error: 'invalidConfig' }
    throw error
  }
}

/** 可选字符串字段：缺键/undefined 视为「未提供」，其余一律严格 string（不转换数字/布尔/null）。 */
function parseOptionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new InvalidConfig()
  if (value.length > maxLength) throw new InvalidConfig()
  return value
}

/**
 * 附加变量：缺省为空记录（纯凭据组合法）；出现在 JSON 里则必须是 string→string 的普通对象。
 * 键要求 trim 后非空、无 NUL、≤1024 且不在禁用集；值必须是字符串、无 NUL、≤32768。
 * 用 Object.fromEntries 建自有属性 —— 即便键名特殊也只落成普通属性，不改原型。
 */
function parseEnv(raw: unknown): Record<string, string> {
  if (raw === undefined) return {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidConfig()
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > LIMITS.envEntries) throw new InvalidConfig()
  const pairs: Array<[string, string]> = []
  for (const [key, value] of entries) {
    if (key.trim().length === 0) throw new InvalidConfig()
    if (key.length > LIMITS.envKey) throw new InvalidConfig()
    if (key.includes('\0')) throw new InvalidConfig()
    // 表单保存会 trim 键名，需按相同规则检查，避免特殊键绕过校验后丢失。
    if (FORBIDDEN_ENV_KEYS.has(key.trim())) throw new InvalidConfig()
    if (typeof value !== 'string') throw new InvalidConfig()
    if (value.length > LIMITS.envValue) throw new InvalidConfig()
    if (value.includes('\0')) throw new InvalidConfig()
    pairs.push([key, value])
  }
  return Object.fromEntries(pairs)
}

/** 模型建议列表：缺省为「未提供」，出现则每项严格 string、≤256，整体 ≤64 项。 */
function parseModels(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new InvalidConfig()
  if (raw.length > LIMITS.models) throw new InvalidConfig()
  const models: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.length > LIMITS.model) throw new InvalidConfig()
    models.push(item)
  }
  return models
}
