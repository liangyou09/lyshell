import { homedir } from 'os'
import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'fs'
import log from 'electron-log'

/**
 * 预设 codex 启动上游地址 —— 把变量组里的 OPENAI_BASE_URL 落进 $CODEX_HOME/config.toml。
 *
 * codex（Rust 版）不读 OPENAI_BASE_URL 环境变量，上游地址唯一入口是 config.toml 里
 * 顶层 `model_provider` 选中的 `[model_providers.<id>]` 表的 `base_url`。变量组提供的值
 * 必须在启动前写进该表；环境变量注入照旧（对其它读 OPENAI_BASE_URL 的工具可见）。
 *
 * 关键语义：
 * - 行级手术式编辑而非 parse/serialize：只改目标 provider 表的 base_url 一行（表内缺失
 *   则紧随表头插入），注释/排版/其它 provider 表/trust 等用户配置逐字保留。
 * - env 未提供 OPENAI_BASE_URL（空白同未提供）时完全不动文件 —— 与 dsh 模型预设不同，
 *   这里没有「留空=清除」：无法区分文件里的 base_url 是 LyShell 写的还是用户手写的，
 *   乱删会毁掉用户自己的路由。想在变量组间切换上游，每组都写各自的 OPENAI_BASE_URL。
 * - 目标表 = 顶层 model_provider 的值；该表缺失则文件末尾补建（只写 name + base_url，
 *   wire_api 等留给用户按上游补）；顶层缺 model_provider 时补 `model_provider = "lyshell"`
 *   并新建同名表（codex 无该键时走内置 openai，不碰任何 [model_providers.*]）。
 * - 写入幂等（内容未变不重写）+ 原子（临时文件 + rename）+ 首改前备份 .bak（只建一次）。
 * - CODEX_HOME 解析链与子进程实际读取位置一致：变量组 env → 系统环境变量 → ~/.codex
 *   （LocalConnector 以 {...process.env, ...launchEnv} 启动，两侧取值同源不会错位）。
 *
 * 支持边界（手写行级解析，明确不做完整 TOML 语法）：顶层键、[table]/[[array]] 表头
 * （含引号键段）、单行字符串值（"…"/'…'/裸值去行尾注释）。不支持：跨行数组/多行字符串
 * 中以 `[` 起始的续行（会被误判为表头）、表内重复 base_url（取首处）。codex config.toml
 * 实际形态均在此边界内；若上游配置复杂度超出，再考虑引入 TOML 解析库（代价是丢注释）。
 */

export type CodexPresetResult = { ok: true } | { ok: false; error: string }

/** 顶层无 model_provider 时 LyShell 自建并选中的 provider id */
const DEFAULT_PROVIDER_ID = 'lyshell'

/**
 * 确定 $CODEX_HOME（codex 未显式设置时默认 ~/.codex）。
 * 优先取 env.CODEX_HOME（变量组），保证写入位置与 codex 子进程实际读取的位置一致；
 * 空白串一律视为未设置，避免主进程按默认写、子进程却读到 "" 的错位。
 */
function codexHome(env?: Record<string, string>): string {
  const fromEnv = env?.CODEX_HOME?.trim()
  if (fromEnv) return fromEnv
  const fromProc = process.env.CODEX_HOME?.trim()
  if (fromProc) return fromProc
  return join(homedir(), '.codex')
}

/** 表头行（[table] / [[array]]）→ 归一化键路径（去引号/空白），非表头行返回 null */
function sectionKeyOf(line: string): string | null {
  const m = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?/.exec(line)
  return m ? m[1].replace(/["']/g, '') : null
}

/** TOML 值 → 字符串：支持 "…" / '…' / 裸值（去行尾注释） */
function parseStringValue(raw: string): string {
  const v = raw.trim()
  const dq = /^"([^"]*)"/.exec(v)
  if (dq) return dq[1]
  const sq = /^'([^']*)'/.exec(v)
  if (sq) return sq[1]
  return v.split('#')[0].trim()
}

/** 字符串 → TOML 基本串字面量（转义反斜杠与双引号） */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 定位名为 section 的表头行区间 [start, end) —— end 为下一个表头行或文件尾 */
function findSectionRange(lines: string[], section: string): { start: number; end: number } | null {
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const key = sectionKeyOf(lines[i])
    if (key === null) continue
    if (start === -1) {
      if (key === section) start = i
    } else {
      return { start, end: i }
    }
  }
  return start === -1 ? null : { start, end: lines.length }
}

/** 幂等 + 原子 + 首改备份的写盘（对齐 dsh/model-preset.ts 的 writePatches 纪律） */
function writeConfig(filePath: string, content: string): CodexPresetResult {
  try {
    if (existsSync(filePath)) {
      try {
        if (readFileSync(filePath, 'utf-8') === content) return { ok: true }
      } catch {
        // 读失败（权限等）继续走写入流程，由下方 writeFileSync 抛出真实错误
      }
      // 首次修改前备份原始文件，保留用户手写注释的恢复点（.bak 只建一次，不被后续覆盖）
      const bakPath = `${filePath}.bak`
      if (!existsSync(bakPath)) copyFileSync(filePath, bakPath)
    }

    mkdirSync(dirname(filePath), { recursive: true })

    const tmpPath = `${filePath}.tmp`
    writeFileSync(tmpPath, content, 'utf-8')
    renameSync(tmpPath, filePath)
    return { ok: true }
  } catch (error) {
    log.error('Failed to write codex config.toml:', error)
    return { ok: false, error: (error as Error).message }
  }
}

/**
 * 将 config.toml 中当前 provider 表的 base_url 预设为 env.OPENAI_BASE_URL。
 * env 未提供该键时为幂等 no-op（不读不写）；文件无法写入时返回 error（调用方拒绝启动）。
 */
export function presetCodexBaseUrl(env?: Record<string, string>): CodexPresetResult {
  const baseUrl = env?.OPENAI_BASE_URL?.trim()
  // 空白/缺失 = 「不由 LyShell 管」，完全不动配置文件（见文件头注释的语义说明）
  if (!baseUrl) return { ok: true }
  // 换行无法进 TOML 单行值、双引号转义后易与手写值混淆，直接拒绝而非静默改写
  if (/[\r\n"]/.test(baseUrl)) {
    return { ok: false, error: 'OPENAI_BASE_URL must be a single-line URL without double quotes' }
  }

  const filePath = join(codexHome(env), 'config.toml')

  let raw: string
  try {
    raw = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  } catch (error) {
    return { ok: false, error: `Failed to read codex config.toml: ${(error as Error).message}` }
  }

  // split 语义：'a\n' → ['a','']，末尾空串代表文件以换行结尾，join 后原样还原
  const lines = raw.length > 0 ? raw.split(/\r?\n/) : []
  // 原始内容为空（缺失/空文件）时按新建处理，统一补一个尾换行
  const isFreshFile = raw.trim().length === 0

  // 顶层 model_provider 只在首个表头之前找（表内同名键不是 provider 选择器）
  let providerId: string | null = null
  let firstSectionIdx = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (sectionKeyOf(lines[i]) !== null) {
      firstSectionIdx = i
      break
    }
    const m = /^\s*model_provider\s*=\s*(.+)$/.exec(lines[i])
    if (m && providerId === null) providerId = parseStringValue(m[1])
  }

  const targetId = providerId?.trim() || DEFAULT_PROVIDER_ID

  // 顶层没选 provider：在首个表头前补一行选择器（保持顶层键在表头之前的 TOML 结构）
  if (providerId === null) {
    lines.splice(Math.min(firstSectionIdx, lines.length), 0, `model_provider = ${tomlString(targetId)}`)
  }

  const baseUrlLine = `base_url = ${tomlString(baseUrl)}`
  const range = findSectionRange(lines, `model_providers.${targetId}`)
  if (range) {
    // 只替换表内第一处 base_url（TOML 禁止重复键，多处属手写异常，取首处即可）
    let replaced = false
    for (let i = range.start + 1; i < range.end; i++) {
      if (/^\s*base_url\s*=/.test(lines[i])) {
        lines[i] = baseUrlLine
        replaced = true
        break
      }
    }
    if (!replaced) lines.splice(range.start + 1, 0, baseUrlLine)
  } else {
    // 目标表不存在 → 文件末尾补建；wire_api 等键留给用户按上游自行补
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('')
    lines.push(`[model_providers.${targetId}]`)
    lines.push(`name = ${tomlString(targetId)}`)
    lines.push(baseUrlLine)
  }

  const content = lines.join('\n') + (isFreshFile ? '\n' : '')
  return writeConfig(filePath, content)
}
