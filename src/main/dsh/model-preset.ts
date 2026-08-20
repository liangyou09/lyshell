import { homedir } from 'os'
import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'fs'
import { load, dump, Type, DEFAULT_SCHEMA } from 'js-yaml'
import log from 'electron-log'

/**
 * 预设 dsh-tui 启动模型 —— 维护 `$DSH_HOME/profiles/dsh-tui/cordis.patch.yml` 里的 dsh-tui 条目。
 *
 * dsh-TUI 的模型不能通过环境变量设置，唯一入口是用户补丁里的 `dsh-tui` 条目：
 *   provider + model 需同时配置才构成显式路由。provider 固定为 DeepSeek 官方适配器
 *   路由名 `deepseek-official`；model 由工作区字段传入。
 *
 * 关键语义：
 * - `config` 是整块替换而非深合并（见 dsh-TUI configuration.md），合并时须保留用户已有
 *   config 字段，仅覆盖 provider / model。
 * - 该文件是全局用户补丁，model 却是 per-workspace 字段，二者语义冲突：启动工作区 A
 *   （model=X）会改写全局补丁，之后启动无 model 的工作区 B 若不清除，仍会拿到 X。
 *   因此「留空」必须显式移除 provider / model 回落 dsh-TUI 默认（clearDshTuiModel），
 *   而非什么都不做。即便这样，仍是 last-write-wins：以最后一次启动的模型为准。
 * - 写入是幂等的（内容未变不重写，避免每次启动都抹掉用户注释/排版）＋原子写
 *   （临时文件 + rename，防崩溃写坏文件）＋首写前备份 `.bak`（保留注释的恢复点）。
 * - 该文件支持 `!!js` 系列表达式（`!!js` / `!!js/undefined` / `!!js/function` /
 *   `!!js/regexp`），故注册对应标量类型保证往返不抛 unknown tag、且原文不丢失。
 */

/** DeepSeek 官方适配器路由名 —— 显式模型路由须 provider 与 model 同时钉住 */
export const DSH_TUI_PROVIDER = 'deepseek-official'

/** 保留 `!!js*` 表达式原文的包装基类：解析时 construct，序列化时 represent 还原 */
class TagExpr {
  constructor(public readonly expr: string) {}
}

// 每种 tag 一个独立子类：dump 时按 instanceOf 精确定位对应 tag，避免多个类型争抢同一实例。
class JsExpr extends TagExpr {}
class JsUndefinedExpr extends TagExpr {}
class JsFunctionExpr extends TagExpr {}
class JsRegexpExpr extends TagExpr {}

/** 构造一个「解析→包装、序列化→还原原文」的透传标量类型 */
function passthroughTag(tag: string, TagClass: new (expr: string) => TagExpr): Type {
  return new Type(tag, {
    kind: 'scalar',
    // 接受任意标量（含 !!js/undefined 这类无值标量，data 为 null）
    resolve: () => true,
    construct: (data: unknown) => new TagClass(data == null ? '' : String(data)),
    represent: (data: unknown) => (data as TagExpr).expr,
    instanceOf: TagClass
  })
}

const PATCH_SCHEMA = DEFAULT_SCHEMA.extend([
  passthroughTag('tag:yaml.org,2002:js', JsExpr),
  passthroughTag('tag:yaml.org,2002:js/undefined', JsUndefinedExpr),
  passthroughTag('tag:yaml.org,2002:js/function', JsFunctionExpr),
  passthroughTag('tag:yaml.org,2002:js/regexp', JsRegexpExpr)
])

/** cordis.patch.yml 顶层是数组，元素通常为 `{ id, config }` 或 `{ insert }` */
interface PatchEntry {
  id?: unknown
  config?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * 确定 $DSH_HOME（dsh 未显式设置时默认 ~/.dsh）。
 * 工作区 env 可覆盖 DSH_HOME（LocalConnector 以 {...process.env, ...workspace.env} 启动），
 * 故这里优先取 env.DSH_HOME，保证补丁写入位置与 dsh-tui 子进程实际读取的位置一致，
 * 否则会出现「写到主进程 DSH_HOME、子进程却读另一个 DSH_HOME」的错位。
 */
function dshHome(env?: Record<string, string>): string {
  // 空/纯空白 DSH_HOME 一律视为未设置（回落默认），避免子进程读到 "" 而主进程按默认写，二者错位
  const fromEnv = env?.DSH_HOME?.trim()
  if (fromEnv) return fromEnv
  const fromProc = process.env.DSH_HOME?.trim()
  if (fromProc) return fromProc
  return join(homedir(), '.dsh')
}

/** 用户补丁文件路径 */
function patchFilePath(env?: Record<string, string>): string {
  return join(dshHome(env), 'profiles', 'dsh-tui', 'cordis.patch.yml')
}

/** 读取现有补丁数组；文件缺失/空白返回空数组，损坏或非数组返回 error（不覆盖原始文件） */
function loadPatches(filePath: string): { patches: PatchEntry[]; error?: string } {
  if (!existsSync(filePath)) return { patches: [] }

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (error) {
    // 区分 IO 读错误（权限等）与解析错误，避免把 EACCES 误报成 parse 失败
    return { patches: [], error: `Failed to read cordis.patch.yml: ${(error as Error).message}` }
  }
  if (!raw.trim()) return { patches: [] }

  try {
    const parsed = load(raw, { schema: PATCH_SCHEMA })
    if (!Array.isArray(parsed)) {
      return { patches: [], error: 'cordis.patch.yml must be a top-level YAML array' }
    }
    return { patches: parsed as PatchEntry[] }
  } catch (error) {
    return { patches: [], error: `Failed to parse cordis.patch.yml: ${(error as Error).message}` }
  }
}

/**
 * 定位所有 id === 'dsh-tui' 的条目；数组/标量一律不匹配（typeof null/object 对数组也为 true，
 * 须显式排除）。返回全部匹配而非首个 —— 存在多条时预设/清除哪个会歧义，须由调用方报冲突。
 */
function findDshTuiEntries(patches: PatchEntry[]): PatchEntry[] {
  return patches.filter(
    (p) => p !== null && typeof p === 'object' && !Array.isArray(p) && p.id === 'dsh-tui'
  )
}

/** 仅当值为普通对象（非数组/非 null）时返回其自身，否则 null */
function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function serialize(patches: PatchEntry[]): string {
  return dump(patches, { schema: PATCH_SCHEMA, lineWidth: -1, noRefs: true })
}

/**
 * 幂等 + 原子 + 首写备份的写盘。内容与磁盘一致时跳过（避免每次启动重写抹掉注释）；
 * 否则先备份原始文件（仅首次、`.bak` 不存在时）再经临时文件 rename 原子落盘。
 */
function writePatches(filePath: string, content: string): PresetModelResult {
  try {
    if (existsSync(filePath)) {
      try {
        if (readFileSync(filePath, 'utf-8') === content) return { ok: true }
      } catch {
        // 读失败（权限等）继续走写入流程，由下方 writeFileSync 抛出真实错误
      }
    }

    mkdirSync(dirname(filePath), { recursive: true })

    // 首次覆盖前备份原始文件，保留用户手写注释的恢复点（.bak 只建一次，不被后续覆盖）
    const bakPath = `${filePath}.bak`
    if (existsSync(filePath) && !existsSync(bakPath)) {
      copyFileSync(filePath, bakPath)
    }

    const tmpPath = `${filePath}.tmp`
    writeFileSync(tmpPath, content, 'utf-8')
    renameSync(tmpPath, filePath)
    return { ok: true }
  } catch (writeError) {
    log.error('Failed to write cordis.patch.yml:', writeError)
    return { ok: false, error: (writeError as Error).message }
  }
}

export type PresetModelResult = { ok: true } | { ok: false; error: string }

/**
 * 将 dsh-tui 的启动模型预设为 `model`（provider 固定 DSH_TUI_PROVIDER）。
 * 保留用户已有的 dsh-tui config 字段与其它条目；文件无法解析时不写入、返回 error。
 * 与 clearDshTuiModel 对称：用户手工配置了非 deepseek-official 的 provider 时，直接返回
 * 冲突错误而非悄悄覆盖，避免用户自定义路由被永久替换。
 */
export function presetDshTuiModel(model: string, env?: Record<string, string>): PresetModelResult {
  const filePath = patchFilePath(env)
  const { patches, error } = loadPatches(filePath)
  if (error) return { ok: false, error }

  const entries = findDshTuiEntries(patches)
  // 多条 dsh-tui 条目时，dsh-TUI 实际生效哪个不明确，盲目改首个可能改错目标，直接报冲突。
  if (entries.length > 1) {
    return {
      ok: false,
      error: `cordis.patch.yml has ${entries.length} dsh-tui entries; refusing to guess which one to preset. Merge them manually first.`
    }
  }

  let entry = entries[0]
  if (!entry) {
    entry = { id: 'dsh-tui', config: {} }
    patches.push(entry)
  }

  // config 是数组/标量（非映射）时，整块替换会静默毁掉用户手写数据，直接报冲突而非覆盖。
  const rawConfig = entry.config
  if (rawConfig !== undefined && rawConfig !== null && !asPlainObject(rawConfig)) {
    return {
      ok: false,
      error: 'dsh-tui.config in cordis.patch.yml is not a mapping (array/scalar); refusing to overwrite it with a model preset. Fix the entry manually first.'
    }
  }

  // config 整块替换语义：先展开用户已有字段，再覆盖 provider / model
  const existing = asPlainObject(rawConfig)
  // 用户手工配置的 provider（非 deepseek-official）不被覆盖 —— clear 不清非 LyShell 路由，
  // preset 也不应悄悄替换它。provider 缺失或已是 deepseek-official 时正常写入。
  if (existing && existing.provider !== undefined && existing.provider !== DSH_TUI_PROVIDER) {
    return {
      ok: false,
      error: `dsh-tui already sets a custom provider "${String(existing.provider)}" in cordis.patch.yml; refusing to overwrite. Remove it or set provider to "${DSH_TUI_PROVIDER}" before launching with a workspace model.`
    }
  }

  const config = existing ? { ...existing } : {}
  config.provider = DSH_TUI_PROVIDER
  config.model = model
  entry.config = config

  return writePatches(filePath, serialize(patches))
}

/**
 * 清除预设：移除 dsh-tui.config 的 provider / model，回落 dsh-TUI 默认模型路由。
 * 仅当 provider === DSH_TUI_PROVIDER（即 LyShell 自己写入的路由）时才动手 —— 用户在
 * cordis.patch.yml 手工配置的 provider/model（可能非 deepseek-official）原样保留，
 * 避免启动一个「留空」工作区就误删用户自己的模型路由。
 * 幂等 —— 无 provider/model 时不写文件；条目除 id/config 外无其它字段且 config 清空后，
 * 整个条目一并移除，避免留下空壳 `config: {}`。
 */
export function clearDshTuiModel(env?: Record<string, string>): PresetModelResult {
  const filePath = patchFilePath(env)
  const { patches, error } = loadPatches(filePath)
  if (error) return { ok: false, error }

  const entries = findDshTuiEntries(patches)
  // 与 preset 对称：多条 dsh-tui 条目时不清除，避免删错目标。
  if (entries.length > 1) {
    return {
      ok: false,
      error: `cordis.patch.yml has ${entries.length} dsh-tui entries; refusing to guess which one to clear. Merge them manually first.`
    }
  }

  const entry = entries[0]
  if (!entry) return { ok: true } // 无 dsh-tui 条目，无可清除

  const existing = asPlainObject(entry.config)
  if (!existing) return { ok: true } // config 缺失/非对象（含数组/标量），无 provider/model 可清

  // LyShell 只会在 provider === DSH_TUI_PROVIDER 时写入路由；provider 是其它值（或缺失）
  // 说明是用户自己的配置，不动文件。
  if (existing.provider !== DSH_TUI_PROVIDER) return { ok: true }

  const config = { ...existing }
  delete config.provider
  delete config.model

  // 仅当条目除 id/config 外无其它字段、且 config 已清空时，移除整个条目（避免误删用户其它字段）
  const hasOtherFields = Object.keys(entry).some((key) => key !== 'id' && key !== 'config')
  if (Object.keys(config).length === 0 && !hasOtherFields) {
    const idx = patches.indexOf(entry)
    if (idx !== -1) patches.splice(idx, 1)
  } else {
    entry.config = config
  }

  return writePatches(filePath, serialize(patches))
}
