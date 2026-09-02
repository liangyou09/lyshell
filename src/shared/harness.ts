/**
 * AI Harness 共享类型与渲染层视图配置 —— dsh / codex / claude 三份第一等终端 Agent 的参数化。
 *
 * 三类角色从「通用 Agent 列表」独立出来，各自拥有专属工作区管理、依赖检测与模型/环境变量。
 * 本文件只放纯数据与类型（可被 main 与 renderer 两侧 import，不得依赖 Node/Electron）：
 *   - HarnessWorkspace：与主进程仓库同构的工作区结构；
 *   - HARNESS_AGENT_VIEWS：渲染层面板需要的展示/检测配置（依赖、env 默认、模型建议、安装信息、是否 Web）。
 *
 * 主进程的运行期行为（启动命令、模型预设、env 归一化）见 src/main/harness/config.ts。
 */

export type HarnessAgentKind = 'dsh' | 'codex' | 'claude'

/** 面板渲染顺序 —— 即左轨页签顺序里的三个 harness 槽位（dsh 在前，codex/claude 随后） */
export const HARNESS_AGENT_KINDS: HarnessAgentKind[] = ['dsh', 'codex', 'claude']

export interface HarnessWorkspace {
  id: string
  name: string           // 显示名称，如 "lyshell"；留空由渲染层兜底为「工作区-<时间戳>」（主进程校验仍要求非空）
  cwd: string            // 工作目录（启动 cwd）
  order: number
  note?: string          // 可选备注，仅用于记录/说明
  /**
   * @deprecated 历史 inline 环境变量，已由「变量组」（HarnessEnvProfile）取代。
   * 保留仅为兜住手工编辑/历史 JSON：迁移读到它之前不能丢，故 normalizeWorkspace 仍解析。
   * add/update 不再写入；运行期解析只在迁移失败的记录上命中（见 resolveWorkspaceEnv）。
   */
  env?: Record<string, string>
  /** 显式绑定的变量组 id；缺省表示「跟随已启用的变量组」 */
  envProfileId?: string
  model?: string         // 可选启动模型（dsh 走 cordis 补丁，codex/claude 走 --model CLI）
  /**
   * 工作目录隔离模式：缺省/'shared' = 直接在 cwd 启动（现状，零变化）；
   * 'worktree' = 在 <仓库根>/.lyshell-worktrees/<key> 的专属 git worktree 中启动
   * （多 agent 指向同一仓库时互不踩踏）。worktree 持久化：首次启动建分支 lyshell/<key>，
   * 此后每次复用，未提交修改跨启动保留；删除工作区不动 worktree/分支（脏树强删会毁掉改动，
   * 需要清理时由用户手动 git worktree remove）。git 仓库校验在启动时做，保存时只校验枚举值。
   */
  isolation?: 'shared' | 'worktree'
  /**
   * worktree 共享名：isolation = 'worktree' 时生效。填了则 key 取该名字 —— 同名工作区
   * （跨 dsh/codex/claude 也行）共用同一个 .lyshell-worktrees/<共享名> 与同一分支
   * lyshell/<共享名>，在同一份检出上协作、互相看得见改动。同一分支同时只能检出在一处，
   * 共用恰恰依赖「同一目录」而非「各自检出」。
   * 缺省 = 私有 worktree：首次启动自动生成可读 key（<kind>-<工作区名>-<时间戳>，见
   * @shared/worktree 的 generateWorktreeKey）并回填持久化，此后固定复用 —— 旧回落形态
   * <kind>-<id> 的 worktree 会被原地改名迁移（目录 + 分支，未提交修改跟着走），已保存的
   * 工作区拿到的仍是上次那棵树；迁移被占用等失败则原样复用旧路径、下次再试，落盘失败
   * 才回落稳定私有 key <kind>-<id>（详见 resolveLaunchWorktree）。
   * 取值约束见 worktree.ts 的 validateWorktreeKey（保存即拒非法名，不做静默折叠）。
   */
  worktreeKey?: string
  /**
   * 跳过权限确认（仅 claude 有意义）：true 时启动命令追加
   * `--dangerously-skip-permissions`，Claude Code 不再逐个工具弹权限确认。
   * 缺省/false = 正常权限模式。渲染层开关与列表角标由 hasSkipPermissions 控制。
   */
  skipPermissions?: boolean
}

/**
 * 具名环境变量组 —— 全局一份库（env-profiles.json），dsh / codex / claude 与通用 Agent 共用。
 * 组本身不携带启用态：harness kind 经 activeByKind 指针启用（每 kind 至多一根，
 * 同组可被多个 kind 同时启用）；通用 Agent 只有显式绑定（AgentConfig.envProfileId）。
 * 全部未启用/未绑定时启动即用系统环境变量。
 */
export interface HarnessEnvProfile {
  id: string
  name: string           // 显示名称，如 "生产密钥"
  order: number
  env: Record<string, string>   // 至少一个变量（空组无意义，仓库层过滤）
  /** 可选模型选项列表 —— 供工作区模型输入框的建议（如中转变量组的 GLM-5.2），空则不写 */
  models?: string[]
  note?: string          // 可选备注
}

/** <kind>:env:list 的返回形状 —— 全局变量组列表 + 该 kind 的启用指针（per-kind 视角） */
export interface HarnessEnvListResult {
  profiles: HarnessEnvProfile[]
  activeProfileId: string | null
}

/** 单个变量组的引用方（按名字列出，供全局面板的引用计数与删除警示） */
export interface EnvProfileUsage {
  /** 绑定该组的通用 Agent 名（AgentConfig.envProfileId） */
  agents: string[]
  /** 显式绑定该组的 harness 工作区（按 kind 分列） */
  workspaces: Array<{ kind: HarnessAgentKind; name: string }>
}

/** env-profile:list 的返回形状 —— 全局库面板视角：组 + 每 kind 启用指针 + 引用方 */
export interface EnvProfileLibraryResult {
  profiles: HarnessEnvProfile[]
  activeByKind: Partial<Record<HarnessAgentKind, string>>
  usage: Record<string, EnvProfileUsage>
}

export interface HarnessEnvDefault {
  key: string
  value: string
}

export interface HarnessRepo {
  dep: string
  url: string
}

/**
 * 判定 env key 是否携带敏感值(API key / token 类)—— 命中的行在变量组编辑器里
 * 值默认打码(· 点阵),点眼睛按钮才明文展示。按 key 名后缀判定:
 * OPENAI_API_KEY / ANTHROPIC_AUTH_TOKEN / DEEPSEEK_API_KEY 命中,
 * OPENAI_BASE_URL / CLAUDE_CONFIG_DIR 这类非敏感配置不命中。
 */
export const isSecretEnvKey = (key: string): boolean => {
  const k = key.trim().toUpperCase()
  if (!k) return false
  return (
    k === 'KEY' || k === 'TOKEN' || k === 'SECRET' ||
    k.endsWith('_KEY') || k.endsWith('_TOKEN') || k.endsWith('_SECRET') ||
    k.endsWith('_PASSWD') || k.endsWith('_PASSWORD') || k.endsWith('_CREDENTIAL') ||
    k.includes('API_KEY')
  )
}

/**
 * 渲染层面板配置 —— 每个 kind 一份。i18nPrefix 对应 locales 里的顶层 key（`dsh`/`codex`/`claude`），
 * 面板统一用 `t(`${prefix}.xxx`)` 取文案。dependencies 是检测并展示的二进制名（PATH 扫描）。
 */
export interface HarnessAgentView {
  kind: HarnessAgentKind
  i18nPrefix: string
  dependencies: string[]          // 检测的二进制名；首个即「就绪」判据（dsh 只装 dsh 也能开 Web/列表）
  envDefaults: HarnessEnvDefault[] // 一键补全的环境变量（API key 等，value 留空待填）
  modelSuggestions: string[]       // 模型 datalist 建议
  installCommand: string           // 缺失依赖时展示的安装命令
  repos: HarnessRepo[]             // 各依赖的源码仓库（提示卡每行一条）
  hasWeb: boolean                  // 是否有 Web UI 入口（仅 dsh）
  /** 工作区表单是否保留「备注」字段（仅 dsh；codex/claude 表单更紧凑，备注退场） */
  hasWorkspaceNote: boolean
  /** 是否提供「跳过权限确认」开关（仅 claude，对应 --dangerously-skip-permissions） */
  hasSkipPermissions: boolean
}

/**
 * 从会话 tags 解析 harness 启动来源 —— 主进程 spawnLocalCommandSession 给三类工作区的
 * 瞬态会话打 `<kind>:<workspaceId>` 标签（通用 Agent 走 `agent:<id>`），渲染层据此在
 * 终端页签名左侧标识 dsh / codex / claude 品牌。只认 `<kind>:` 前缀，与主进程的打标
 * 约定严格一致 —— 用户自建的裸 `codex` / `claude` 等纯标签不命中。非 harness 会话返回 null。
 */
export function harnessKindFromTags(tags: string[] | undefined | null): HarnessAgentKind | null {
  if (!tags) return null
  for (const tag of tags) {
    for (const kind of HARNESS_AGENT_KINDS) {
      if (tag.startsWith(`${kind}:`)) return kind
    }
  }
  return null
}

export const HARNESS_AGENT_VIEWS: Record<HarnessAgentKind, HarnessAgentView> = {
  dsh: {
    kind: 'dsh',
    i18nPrefix: 'dsh',
    dependencies: ['dsh', 'dsh-tui'],
    envDefaults: [
      { key: 'DEEPSEEK_API_KEY', value: '' },
      { key: 'DEEPSEEK_BASE_URL', value: 'https://api.deepseek.com' }
    ],
    modelSuggestions: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    installCommand: 'npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui',
    repos: [
      { dep: 'dsh', url: 'https://github.com/deepseek-ai/deepseek-harness' },
      { dep: 'dsh-tui', url: 'https://github.com/ccch1mneyyy/dsh-TUI' }
    ],
    hasWeb: true,
    hasWorkspaceNote: true,
    hasSkipPermissions: false
  },
  codex: {
    kind: 'codex',
    i18nPrefix: 'codex',
    dependencies: ['codex'],
    // CODEX_HOME 的 value: '' 只是渲染层初始化/IPC 失败时的降级兜底（HarnessPanel 以此为初始 state）；
    // 主进程 runtime.envDefaults()（harness/config.ts）会用「系统环境变量，否则 ~/.codex」解析出的
    // 真实路径覆盖下发给 <kind>:env:defaults，请勿据此推断显示值
    envDefaults: [
      { key: 'OPENAI_API_KEY', value: '' },
      { key: 'OPENAI_BASE_URL', value: '' },
      { key: 'CODEX_HOME', value: '' }
    ],
    modelSuggestions: ['gpt-5-codex', 'gpt-5', 'o3'],
    installCommand: 'npm install -g @openai/codex',
    repos: [
      { dep: 'codex', url: 'https://github.com/openai/codex' }
    ],
    hasWeb: false,
    hasWorkspaceNote: false,
    hasSkipPermissions: false
  },
  claude: {
    kind: 'claude',
    i18nPrefix: 'claude',
    dependencies: ['claude'],
    // 同 codex：CLAUDE_CONFIG_DIR 的空 value 是渲染层降级兜底，主进程会覆盖为解析后的真实路径
    envDefaults: [
      { key: 'ANTHROPIC_AUTH_TOKEN', value: '' },
      { key: 'ANTHROPIC_BASE_URL', value: '' },
      { key: 'CLAUDE_CONFIG_DIR', value: '' }
    ],
    modelSuggestions: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'],
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    repos: [
      { dep: 'claude', url: 'https://github.com/anthropics/claude-code' }
    ],
    hasWeb: false,
    hasWorkspaceNote: false,
    hasSkipPermissions: true
  }
}
