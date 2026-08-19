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
  name: string           // 显示名称，如 "lyshell"
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
}

/**
 * 具名环境变量组 —— 与工作区平级的一等配置，每个 kind 一份列表。
 * 同一时刻至多一条 active（单选，可全关）；全关时启动即用系统环境变量。
 */
export interface HarnessEnvProfile {
  id: string
  name: string           // 显示名称，如 "生产密钥"
  order: number
  env: Record<string, string>   // 至少一个变量（空组无意义，仓库层过滤）
  active?: boolean       // 至多一条为 true —— 由仓库层在 load/setActive 两侧保证
  note?: string          // 可选备注
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
    hasWeb: true
  },
  codex: {
    kind: 'codex',
    i18nPrefix: 'codex',
    dependencies: ['codex'],
    envDefaults: [
      { key: 'OPENAI_API_KEY', value: '' }
    ],
    modelSuggestions: ['gpt-5-codex', 'gpt-5', 'o3'],
    installCommand: 'npm install -g @openai/codex',
    repos: [
      { dep: 'codex', url: 'https://github.com/openai/codex' }
    ],
    hasWeb: false
  },
  claude: {
    kind: 'claude',
    i18nPrefix: 'claude',
    dependencies: ['claude'],
    envDefaults: [
      { key: 'ANTHROPIC_API_KEY', value: '' }
    ],
    modelSuggestions: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'],
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    repos: [
      { dep: 'claude', url: 'https://github.com/anthropics/claude-code' }
    ],
    hasWeb: false
  }
}
