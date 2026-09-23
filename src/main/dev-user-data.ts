import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import log from 'electron-log'

// dev 实例（electron.exe，未打包）的 userData 分离到独立目录：
// 与正式版共用 %APPDATA%\lyshell 时，两拨进程会同时打开同一批 partition 的
// LevelDB（webbar 分区等），后到者打不开且重置失败（quota_database 报错、
// QuotaManager-journal 残留），存储后端 wedged 后页面的同步存储写入挂死主线程
// （实测症状：抖音「保存登录信息」弹窗取消/保存两个按钮全死、CSS 转圈动画照转、
// 心跳 iframe 停摆 —— CSS 动画走合成线程，主线程冻结它还在转）。分离后 dev 与
// 正式版互不抢存储、可并存（正式版自身的双开防护见 index.ts 单实例锁）。
// 代价：dev 首次启动是全新配置（会话/偏好/插件列表为空），属预期 —— dev 数据
// 从此与正式版彻底分仓，正式版目录不再被 dev 折腾。这份「空档案」的代价不能白付，
// 故配套播种（见下）：纯 JSON 配置镜像一份过来，隔离的只是 partition 存储。
// 时序硬约束分两段：
//   1. 路径切换必须是 index.ts 的首个本地 import（模块顶层按 import 顺序执行，先于
//      后续模块里任何 app.getPath('userData') / getConfigDir()）。挪到更晚的位置不会
//      报错，但 dev 分离静默失效。storage 仓储本身都延迟初始化（ensureInitialized
//      首次 get 才 load），但 getPath 的时机不受它们控制。
//   2. 播种不在 import 期跑：两个 dev 实例同时启动（清掉标记后的第一次）会并发执行
//      seedDevConfigFrom，共用同一份 .tmp 互相踩、甚至把对方的半截写入判成自己的失败。
//      单实例锁按 userData 隔离，dev 分离后 dev 自己也持锁 —— 故播种改由 index.ts 在
//      拿到锁之后调（seedDevConfigFromProd），只有持有方会播。仍须早于任何仓储的首次
//      读盘（最早是 whenReady 里的 downloadHistory.init()），否则那边先 load 到空档案。

// ── dev 档案播种(仅 dev,打包版不受影响)──
// 分离后 dev 读自己的 {userData}/config(repository.ts 的 getConfigDir),正式版的
// dsh/claude/codex 工作区、变量组、会话、Agent 全在另一边 —— 表现为「dev 里 dsh 选不了
// 工作区」(工作区列表空,且 HarnessWorkspaceRepository.load 在文件不存在时静默返回空
// 数组,连日志都不打,只能看到列表空着)。故首次启动把正式版 config 播种过来:
//   - 正式版没有的文件 → 拷过来(含 agents/quickCommands 等),混合内容文件先剥凭据
//     再装(见 sanitizeSeededConfig),不是盲拷;
//   - 两边都有、且是「条目数组」的 → 按 id 补缺(正式版有、dev 没有的追加在后),
//     补进来的条目同样已剥凭据;
//   - 数组形状含两种:顶层数组(*-workspaces.json / agents.json),以及数组包裹的
//     对象(quickCommands.json 是 commands + groups 两个数组 —— 各按键按 id 补缺,
//     漏一边就会出现「命令补过来了、它所属的分组没过来」);
//   - 两边都有、但不是条目数组的(preferences.json 这类无数组对象)→ 保持 dev 自己
//     的不动,否则 dev 的窗口尺寸/面板折叠态等会被正式版覆盖。
//   - 凭据不外带走两道闸:①整份含密钥的文件跳过(见 SKIP_FILES: sessions.json 的
//     明文密码、env-profiles.json 及旧 per-kind 的 apiKey/敏感环境变量);②混合内容
//     文件剥字段(agent/工作区的内联 env、preferences 的 ai.apiKey 与
//     security.masterPassword)。dev 档案常被分享排查,播过去等于把密码/模型凭据
//     外带,也与导出策略同一侧 —— handlers.ts 只导出 sessions+quickCommands,并注明
//     「AI Harness 的环境变量组装的就是 API key,默认不进导出文件是更稳妥的一侧」。
//     代价:dev 里 envProfileId 与内联 env 皆空(悬空=当作没绑,回落系统环境)、会话
//     密码也不带过来,均需自行填。凭据不外带优先于播种便利。
// 只播 config 目录的 JSON,不碰 Partitions/(cookie/登录态)—— 隔离的正是后者,
// 播它既无必要也会把 dev 的登录态搅乱。
// 一次性语义：播完落 .seeded-from-prod 标记，之后不再播。否则「在 dev 里删掉一个
// 工作区，下次启动又被正式版播回来」会变成持续的意外。想重播就删掉该标记文件。
// 「播完」不含半途而废:任一文件读盘/解析失败都算没播完,不落标记、下轮重试 ——
// 落了标记,装进去的半截文件或补不进来的缺口就永远修不回来。重试是幂等的(已播的
// 条目按 id 无新增即不回写)。代价是「有文件坏着就一直在重播」,这期间 dev 里删掉的
// 条目会被补回来;config/*.json 都是应用自己写的 JSON,坏文件本就该被看见。
// 任何失败都只告警、不抛 —— 本模块在启动路径最前端，抛出去等于启动失败。

const SEED_MARKER = '.seeded-from-prod'

type JsonRecord = { [key: string]: unknown }

/** 一个条目数组及其回写位置：顶层数组（key = null），或对象里的一个数组属性 */
interface EntryList {
  key: string | null
  list: unknown[]
}

/**
 * 取出「条目数组 + 回写位置」：顶层数组（单列表），或对象里的每个数组属性
 * （多数组包裹形状 —— quickCommands.json 就是 commands + groups 两个数组）。
 * 返回 null 表示这份 JSON 不是可合并的条目容器（preferences.json 这类无数组对象等）。
 */
function locateEntryLists(parsed: unknown): { holder: JsonRecord | null; entries: EntryList[] } | null {
  if (Array.isArray(parsed)) return { holder: null, entries: [{ key: null, list: parsed }] }
  if (typeof parsed !== 'object' || parsed === null) return null
  const holder = parsed as JsonRecord
  const entries: EntryList[] = []
  for (const key of Object.keys(holder)) {
    if (Array.isArray(holder[key])) entries.push({ key, list: holder[key] as unknown[] })
  }
  if (entries.length === 0) return null
  return { holder, entries }
}

/** 条目是否都带字符串 id（合并键）。空数组视为通过 —— 空档案正是待播种的目标。 */
function allEntriesHaveId(list: unknown[]): boolean {
  return list.every((e) => typeof e === 'object' && e !== null && typeof (e as JsonRecord).id === 'string')
}

/**
 * 按 id 把 src 的缺项补进 dst：null = 该列表不值得回写（畸形条目 / 无新增）。
 * 逐列表独立判定 —— commands 畸形不该连坐 groups，反之亦然。
 */
function mergeListsById(srcList: unknown[], dstList: unknown[]): unknown[] | null {
  if (!allEntriesHaveId(srcList) || !allEntriesHaveId(dstList)) return null
  const known = new Set(dstList.map((e) => (e as JsonRecord).id as string))
  const additions = srcList.filter((e) => !known.has((e as JsonRecord).id as string))
  if (additions.length === 0) return null
  return [...dstList, ...additions]
}

/** 合并结果：unusable ≠ unchanged —— 前者让本次播种不落一次性标记（见 mergeJsonById） */
type MergeOutcome =
  | { kind: 'merged'; text: string }
  | { kind: 'unchanged' }
  | { kind: 'unusable' }

/**
 * 按 id 把正式版条目补进 dev。
 *  - merged：有缺项，text 待原子回写；
 *  - unchanged：无需回写（无新增 / 形状不符 / 非条目容器），播种仍算完成；
 *  - unusable：目标文件解析失败 —— 这不算「播完了」。开发侧文件损坏时若照旧落一次性
 *    标记，正式版数据永远补不进来，用户修好文件后也不会再试；与读盘异常同待遇
 *    （不落标记，下轮启动重试）。
 * 顶层数组 vs 包裹对象不硬凑；包裹对象之间只合并同名数组键，dev 没有的键不发明；
 * 非数组键（env-profiles 的 activeProfileId 之类指针/标量）一律保持 dev 原样。
 * src 侧由调用方保证已解析并脱敏（见 sanitizeSeededConfig），这里只解析 dst。
 */
function mergeJsonById(src: unknown, dstText: string): MergeOutcome {
  let dst: unknown
  try {
    dst = JSON.parse(dstText)
  } catch {
    return { kind: 'unusable' }
  }
  const s = locateEntryLists(src)
  const d = locateEntryLists(dst)
  if (!s || !d) return { kind: 'unchanged' }
  if ((s.holder === null) !== (d.holder === null)) return { kind: 'unchanged' } // 形状不同（数组 vs 包裹对象）不硬凑

  if (d.holder === null) {
    // 两边都是顶层数组
    const merged = mergeListsById(s.entries[0].list, d.entries[0].list)
    return merged === null ? { kind: 'unchanged' } : { kind: 'merged', text: JSON.stringify(merged, null, 2) }
  }

  const dstByKey = new Map(d.entries.map((e) => [e.key, e.list]))
  let changed = false
  for (const se of s.entries) {
    const key = se.key
    if (key === null) continue // 顶层数组已在上面分支返回，这里仅为类型收窄
    const dstList = dstByKey.get(key)
    if (dstList === undefined) continue // dev 没有的键不发明
    const merged = mergeListsById(se.list, dstList)
    if (merged === null) continue
    d.holder[key] = merged
    changed = true
  }
  return changed ? { kind: 'merged', text: JSON.stringify(d.holder, null, 2) } : { kind: 'unchanged' }
}

/** 剥掉对象上的一个字段：非对象原样返回（脏数据不在这级纠正） */
function omitField(record: unknown, field: string): unknown {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return record
  const out = { ...(record as JsonRecord) }
  delete out[field]
  return out
}

/**
 * 装进 dev 之前剥掉凭据字段。混合内容文件不能整份跳过（播种的意义就是把这些配置
 * 搬过来），也不能整份拷（密钥会跟着走），逐字段剥：
 *   - agents.json / *-workspaces.json：条目上的内联 env —— 变量组绑定悬空时就靠它
 *     注入 API key（见 resolveAgentLaunchEnv / resolveWorkspaceEnv 的 legacy 分支），
 *     值就是凭据；envProfileId 只是 id，保留；
 *   - preferences.json：ai.apiKey 与 security.masterPassword（其余偏好照播）。
 * 只处理要播进去的正式版内容；dev 自己已有的凭据不碰 —— 那是本机数据，不是外带面。
 * 新增凭据字段时同步补这里：与 SKIP_FILES 一起是「凭据不外带」的两道闸。
 */
function sanitizeSeededConfig(name: string, parsed: unknown): unknown {
  if (name === 'agents.json' || name.endsWith('-workspaces.json')) {
    return Array.isArray(parsed) ? parsed.map((e) => omitField(e, 'env')) : parsed
  }
  if (name === 'preferences.json') {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed
    const out = { ...(parsed as JsonRecord) }
    if ('ai' in out) out.ai = omitField(out.ai, 'apiKey')
    if ('security' in out) out.security = omitField(out.security, 'masterPassword')
    return out
  }
  return parsed
}

/**
 * 原子写文本：先写同目录 .tmp 再 rename，避免崩溃时留下截断的 JSON。
 * 这里手写而不调 repository.ts 的 atomicWriteFileSync —— 本模块必须先于那些单例
 * 构造执行，引它等于把 storage 系单例提前到播种之前构造。
 */
function atomicWriteText(filePath: string, text: string): void {
  const tmpPath = `${filePath}.tmp`
  try {
    writeFileSync(tmpPath, text, 'utf-8')
    renameSync(tmpPath, filePath)
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }
}

/**
 * 首次启动把正式版档案的纯 JSON 配置播种进 dev 档案。
 * 返回 'no-source' 时不落标记（正式版档案尚未建立，等它出现再播）；'failed' 时也不落
 * 标记（下次启动重试）—— 只有 'seeded' 才宣告一次性语义生效。
 */
function seedDevConfigFrom(prodUserDataDir: string, devUserDataDir: string): 'seeded' | 'no-source' | 'failed' {
  const srcDir = join(prodUserDataDir, 'config')
  // 正式版档案还没建（全新机器）：不播也不落标记，等它出现再播
  if (!existsSync(srcDir)) return 'no-source'

  const dstDir = join(devUserDataDir, 'config')
  mkdirSync(dstDir, { recursive: true })

  let failed = false
  // 含凭据的文件不播:sessions.json 是明文密码/私钥;env-profiles.json(含旧 per-kind
  // dsh/codex/claude-env-profiles.json)是 apiKey 与敏感环境变量 —— dev 档案常被分享
  // 排查,播过去等于外带模型凭据。宁可让 envProfileId 悬空(=当作没绑,回落系统环境)
  // 也不把凭据写进可分享档案;旧 per-kind 文件同样带 apiKey,不能只挡全局库那一份。
  const SKIP_FILES = new Set([
    'sessions.json',
    'env-profiles.json',
    'dsh-env-profiles.json',
    'codex-env-profiles.json',
    'claude-env-profiles.json'
  ])
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    // 只认 .json：.tmp（原子写残留）与 .bak / .bak.<ts>（历史备份）一概不播
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    if (SKIP_FILES.has(entry.name)) {
      log.info(`[dev-user-data] skipped sensitive file: ${entry.name}`)
      continue
    }
    const src = join(srcDir, entry.name)
    const dst = join(dstDir, entry.name)
    try {
      const srcText = readFileSync(src, 'utf-8')
      // 先验后装：正式版与 dev 可并发运行，而 preferences / quickCommands / sessions
      // 的 save 都是直接 writeFileSync（非原子），此刻 src 可能是写了一半的 JSON。
      // 解析不过按「本轮播不完」处理：不装、不落标记，下轮再试 —— 落了标记，装进去的
      // 半截文件就再也修不回来。src 侧统一在这里解析，后面不再二次 parse。
      let srcJson: unknown
      try {
        srcJson = JSON.parse(srcText)
      } catch {
        failed = true
        log.warn(`[dev-user-data] source is not valid JSON (mid-write?), will retry: ${entry.name}`)
        continue
      }
      // 装进 dev 前先剥凭据（见 sanitizeSeededConfig）—— 整份拷贝与按 id 补缺两条路径共用
      const safeSrc = sanitizeSeededConfig(entry.name, srcJson)

      if (!existsSync(dst)) {
        atomicWriteText(dst, JSON.stringify(safeSrc, null, 2))
        log.info(`[dev-user-data] seeded config: ${entry.name}`)
        continue
      }

      const outcome = mergeJsonById(safeSrc, readFileSync(dst, 'utf-8'))
      if (outcome.kind === 'unusable') {
        failed = true
        log.warn(`[dev-user-data] target is not valid JSON, will retry: ${entry.name}`)
        continue
      }
      if (outcome.kind === 'merged') {
        atomicWriteText(dst, outcome.text)
        log.info(`[dev-user-data] merged missing entries into: ${entry.name}`)
      }
    } catch (err) {
      failed = true
      log.warn(`[dev-user-data] seed failed for ${entry.name}:`, err)
    }
  }
  return failed ? 'failed' : 'seeded'
}

// 模块顶层只做 dev 路径切换（时序硬约束第 1 段），播种见 seedDevConfigFromProd
const prodUserDataDir = app.isPackaged ? null : app.getPath('userData')
const devUserDataDir = app.isPackaged ? null : join(app.getPath('appData'), 'lyshell-dev')
if (devUserDataDir !== null) {
  // 分离前的原始 userData 就是正式版档案（Electron 默认按 app name 解析，与打包版同目录）
  app.setPath('userData', devUserDataDir)
}

/**
 * 把正式版档案播种进 dev 档案（仅 dev，打包版是 no-op）。
 * 调用方（index.ts）必须已拿到本 userData 的单实例锁 —— 两个 dev 实例并发播会共用
 * 固定 .tmp 路径互相踩；且要早于任何仓储的首次读盘（时序硬约束第 2 段）。
 * 标记只记结果与时间：标记本身在可分享的 dev 档案里，别把本机绝对路径（含用户名）
 * 也写进去。
 */
export function seedDevConfigFromProd(): void {
  if (prodUserDataDir === null || devUserDataDir === null) return
  try {
    const markerPath = join(devUserDataDir, 'config', SEED_MARKER)
    if (!existsSync(markerPath) && seedDevConfigFrom(prodUserDataDir, devUserDataDir) === 'seeded') {
      writeFileSync(markerPath, `seeded at ${new Date().toISOString()}\n`, 'utf-8')
    }
  } catch (err) {
    // 播种属便利性增强,失败不该拦住启动
    log.warn('[dev-user-data] config seeding skipped:', err)
  }
}
