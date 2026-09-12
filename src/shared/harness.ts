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

/**
 * Codex 权限档位 —— 与 Codex 内置 default_permissions 档位同名（含 `:` 前缀）。
 * 三档语义：:read-only 只读（改动/联网都要批）；:workspace 工作区读写 + 可跑命令
 * （联网/外部文件要批）；:danger-full-access 完全绕过沙箱与审批。
 * 启动时拼 `-c default_permissions=<档位>`（Codex 的 -c value 解析规则是「先试 TOML，
 * 失败按字面字符串」，故不加引号直接可用）；danger 档另拼 `-c approval_policy=never`
 * —— 只关沙箱不关审批时 codex /status 显示「No Sandbox (Ask for approval)」，
 * 补上这条才是 /permissions 菜单 Full Access 预设的完整语义。
 */
export type CodexPermissionProfile = ':read-only' | ':workspace' | ':danger-full-access'

/** 档位全集 —— IPC 枚举校验 / 表单选项 / 仓库归一化共用 */
export const CODEX_PERMISSION_PROFILES = [':read-only', ':workspace', ':danger-full-access'] as const

/** 表单默认选中档位（保存即显式落盘；缺省不追加参数，跟随 Codex 自身默认链） */
export const DEFAULT_CODEX_PERMISSION_PROFILE: CodexPermissionProfile = ':workspace'

/** unknown → 档位类型守卫（仓库归一化/命令构造兜底共用） */
export function isCodexPermissionProfile(v: unknown): v is CodexPermissionProfile {
  return v === ':read-only' || v === ':workspace' || v === ':danger-full-access'
}

/**
 * Claude 权限档位 —— 与 claude CLI `--permission-mode` 的内置模式同名。
 * 四档语义（claude 2.1.268 --help 与 bundle 内描述）：default 标准（危险操作逐项确认）；
 * acceptEdits 自动接受文件编辑；plan 计划模式只读（不实际执行工具）；
 * bypassPermissions 完全放开。CLI 另有 auto（模型分类器代批）/ dontAsk（未预批直接拒）
 * 两档 —— 语义分别依赖黑盒分类器与静默拒绝，不进面板；manual 是 default 的兼容别名
 * （CLI 内部直接映射，不单列）。启动拼参：bypassPermissions 档拼
 * `--dangerously-skip-permissions` 直连 flag（`--permission-mode bypassPermissions`
 * 形态需 allowDangerouslySkipPermissions 设置才生效，直连 flag 是既有已测链路）；
 * 其余档拼 `--permission-mode <mode>`；default/缺省不追加。
 */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

/** 档位全集 —— IPC 枚举校验 / 表单选项 / 仓库归一化共用 */
export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const

/** 表单默认选中档位（= 不追加参数，claude CLI 自身的默认形态） */
export const DEFAULT_CLAUDE_PERMISSION_MODE: ClaudePermissionMode = 'default'

/** unknown → 档位类型守卫（仓库归一化/命令构造兜底共用） */
export function isClaudePermissionMode(v: unknown): v is ClaudePermissionMode {
  return v === 'default' || v === 'acceptEdits' || v === 'plan' || v === 'bypassPermissions'
}

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
   * @deprecated 历史布尔开关，已由 claudePermissions 档位取代（bypassPermissions 档 =
   * 原 skipPermissions=true）。保留仅为兜住历史 JSON：normalizeWorkspace 读到
   * skipPermissions===true 时折叠成 claudePermissions:'bypassPermissions'（读取即迁移，
   * 下次落盘旧键自然消失）；add/update 不再写入，运行期各消费方一律读 claudePermissions。
   */
  skipPermissions?: boolean
  /**
   * 权限档位（仅 claude 有意义）：bypassPermissions 档启动追加
   * `--dangerously-skip-permissions`（直连 flag，等价 --permission-mode bypassPermissions
   * 但后者需 allowDangerouslySkipPermissions 设置）；acceptEdits/plan 档追加
   * `--permission-mode <mode>`。default/缺省 = 不追加参数（claude CLI 默认形态，
   * 危险操作逐项确认）。渲染层下拉与列表角标由 hasClaudePermissions 控制。
   */
  claudePermissions?: ClaudePermissionMode
  /**
   * 权限档位（仅 codex 有意义）：启动命令追加 `-c default_permissions=<档位>`，
   * danger 档再追加 `-c approval_policy=never`（沙箱与审批一并关掉）。
   * 缺省 = 不追加参数，跟随 Codex 自身默认链（trusted + 沙箱可用 → :workspace，
   * 否则 :read-only）。渲染层下拉与列表角标由 hasCodexPermissions 控制。
   */
  codexPermissions?: CodexPermissionProfile
}

/**
 * 具名环境变量组 —— 全局一份库（env-profiles.json），dsh / codex / claude 与通用 Agent 共用。
 * 组本身不携带启用态：启用是全应用单选一根指针（activeProfileId），三个 harness kind
 * 与 dsh Web 共用同一根 —— 同一时刻至多一组通电，结构化核心按消费方映射物化；
 * 通用 Agent 只有显式绑定（AgentConfig.envProfileId）。
 * 未启用/未绑定时启动即用系统环境变量。
 *
 * 核心是结构化的「端点凭据」：baseUrl + apiKey 两字段存储协议无关的凭据，注入时按
 * 消费方的映射（HARNESS_ENV_KEY_MAP / AgentConfig.envKeyMap）物化成具体变量名 ——
 * 同一组切换喂给不同协议的 agent 不必重抄变量名。核心放不下的其余配置
 * （CODEX_HOME / CLAUDE_CONFIG_DIR / NO_PROXY）留在附加变量 env 里原样注入。
 */
export interface HarnessEnvProfile {
  id: string
  name: string           // 显示名称，如 "生产密钥"
  order: number
  /** 结构化核心：上游地址。启动时按消费方映射注入（codex → OPENAI_BASE_URL 等），缺省不注入 */
  baseUrl?: string
  /** 结构化核心：API key / token。与 isSecretEnvKey 命中值同级敏感，UI 默认打码展示 */
  apiKey?: string
  /** 附加变量：核心两字段放不下的其余配置，原样注入；可为空（核心存在即合法） */
  env: Record<string, string>
  /** 可选模型选项列表 —— 供工作区模型输入框的建议（如中转变量组的 GLM-5.2），空则不写 */
  models?: string[]
  note?: string          // 可选备注
}

/**
 * 每 kind 的凭据映射 —— 结构化核心（baseUrl/apiKey）物化成哪些环境变量名。
 * 变量名由各家 CLI 自己定义，故映射跟着 kind 走；通用 Agent 的映射由 AgentConfig.envKeyMap
 * 自带（命令是任意的，只有 agent 作者知道读哪些变量名）。
 */
export interface EnvCredentialMapping {
  baseUrlKey: string
  apiKeyKey: string
}

/** 三个 harness kind 的固定映射（与各 CLI 实际读取的环境变量一致） */
export const HARNESS_ENV_KEY_MAP: Record<HarnessAgentKind, EnvCredentialMapping> = {
  dsh: { baseUrlKey: 'DEEPSEEK_BASE_URL', apiKeyKey: 'DEEPSEEK_API_KEY' },
  codex: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY' },
  claude: { baseUrlKey: 'ANTHROPIC_BASE_URL', apiKeyKey: 'ANTHROPIC_AUTH_TOKEN' }
}

/**
 * 物化变量组：结构化核心 + 附加变量 → 实际注入的环境变量记录。
 * 附加变量在前、核心在后（同名键核心覆盖 —— 核心是权威来源）；baseUrl/apiKey 缺省、
 * 或调用方映射名传 null（通用 Agent 未声明该维度）时该维度不注入。
 * 纯函数，主进程唯一注入点（resolveWorkspaceEnv / resolveAgentLaunchEnv）都过这里。
 */
export function materializeProfileEnv(
  profile: Pick<HarnessEnvProfile, 'baseUrl' | 'apiKey' | 'env'>,
  baseUrlKey: string | null,
  apiKeyKey: string | null
): Record<string, string> {
  const env: Record<string, string> = { ...profile.env }
  if (profile.baseUrl && baseUrlKey) env[baseUrlKey] = profile.baseUrl
  if (profile.apiKey && apiKeyKey) env[apiKeyKey] = profile.apiKey
  return env
}

/**
 * 防御性提升：从扁平 env 记录里把已知协议的凭据对提回结构化核心。
 * 按 HARNESS_AGENT_KINDS 顺序找首个命中（dsh → codex → claude）的协议 —— 实际数据
 * 一组一协议，多协议并存的组里首个之后的协议键原样留在附加变量里，由用户手动分拆。
 * 提升后原键从返回的 env 里移除；无任何命中则原样返回（env 逐键拷贝，不共享引用）。
 * 一次性迁移与 normalizeProfile 的加载防御共用这一份判定。
 */
export function liftStructuredFields(
  env: Record<string, string>
): Pick<HarnessEnvProfile, 'baseUrl' | 'apiKey' | 'env'> {
  let baseUrl: string | undefined
  let apiKey: string | undefined
  const rest = { ...env }
  for (const kind of HARNESS_AGENT_KINDS) {
    const { baseUrlKey, apiKeyKey } = HARNESS_ENV_KEY_MAP[kind]
    const url = rest[baseUrlKey]
    const key = rest[apiKeyKey]
    if (!url && !key) continue
    if (url) {
      baseUrl = url
      delete rest[baseUrlKey]
    }
    if (key) {
      apiKey = key
      delete rest[apiKeyKey]
    }
    break
  }
  return {
    baseUrl,
    apiKey,
    env: rest
  }
}

/**
 * baseUrl 格式校验：非空值必须是可解析的 http(s) URL —— 产品语义是上游 API 地址，
 * 存进来的值最终要喂给 DEEPSEEK_BASE_URL / OPENAI_BASE_URL 等变量，坏格式注入了也连不上。
 * 只在写入路径（IPC 校验 + 表单预检）使用；读取/迁移路径不校验 —— 防御性解析不丢数据。
 */
export function isValidHttpBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 单个变量组的引用方（按名字列出，供全局面板的引用计数与删除警示） */
export interface EnvProfileUsage {
  /** 绑定该组的通用 Agent 名（AgentConfig.envProfileId） */
  agents: string[]
  /** 显式绑定该组的 harness 工作区（按 kind 分列） */
  workspaces: Array<{ kind: HarnessAgentKind; name: string }>
}

/** env-profile:list 的返回形状 —— 全局库面板视角：组 + 全局启用指针 + 引用方 */
export interface EnvProfileLibraryResult {
  profiles: HarnessEnvProfile[]
  activeProfileId: string | null
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
  /** 是否提供「权限模式」下拉（仅 claude，对应 --permission-mode / --dangerously-skip-permissions） */
  hasClaudePermissions: boolean
  /** 是否提供「权限档位」下拉（仅 codex，对应 -c default_permissions=<档位>） */
  hasCodexPermissions: boolean
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
    hasClaudePermissions: false,
    hasCodexPermissions: false
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
    hasClaudePermissions: false,
    hasCodexPermissions: true
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
    hasClaudePermissions: true,
    hasCodexPermissions: false
  }
}
