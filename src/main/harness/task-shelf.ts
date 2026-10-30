import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { shelfWebUrl, type ShelfRecovery, type ShelfResource, type TaskShelfEntry, type TaskShelfRequest, type TaskShelfResult } from '@shared/task-shelf'
import type { HarnessWorkspace } from '@shared/harness'
import { ConnectionType, type SessionConfig } from '@shared/types/session'
import type { TuiActivitySnapshot } from '@shared/tui-activity'
import { expandTilde, resolveWorkspaceCwd } from './cwd'
import { listWorktreeKeys } from './worktree'
import type { ShelfCaptureInput, TaskShelfRepository } from '../storage/task-shelf-repository'
import { captureSshContext, normalizeSshDirectory } from '../terminal/shelf-ssh-context'
import { createTaskShelfCommandService, SHELF_INITIALIZATION_BLOCKED } from './task-shelf-command-service'

/** 能走 harness 续接链的三类启动器（与 @shared/harness 的 HarnessAgentKind 同集）。 */
export type ShelfAgentKind = 'codex' | 'claude' | 'dsh'

/** handlers 侧用连接器枚举算好 alive，避免两套 ConnectionStatus 枚举互不赋值。 */
export interface ShelfSessionView {
  alive: boolean
  config: SessionConfig
  cwd?: string
  tmuxSession?: string
  localHostId?: string
  output?: string
}

export type ShelfSpawnResult = { success: boolean; error?: string; id?: string }

export type ShelfSpawn = (
  name: string,
  command: string | undefined,
  tags: string[],
  opts: { cwd?: string; env?: Record<string, string>; awaitConnection?: boolean }
) => Promise<ShelfSpawnResult>

export interface ShelfHarnessRuntime {
  /** 当前真实 Agent 记录（已套用设置项目录绑定）；已删除返回 undefined。 */
  workspace: (kind: ShelfAgentKind, id: string) => HarnessWorkspace | undefined
  /** 复用现有启动链（变量组归一化 + 模型预设 + 命令构造）。 */
  launch: (
    kind: ShelfAgentKind,
    workspace: HarnessWorkspace
  ) => Promise<{ ok: true; command: string; env?: Record<string, string> } | { ok: false; error: string }>
}

export interface TaskShelfDeps {
  repository: TaskShelfRepository
  /** 旧调用方的启动归档别名；失败状态与重试统一由 commands 管理。 */
  archiveOnStart?: boolean
  session: (id: string) => ShelfSessionView | undefined
  createSession: (config: SessionConfig) => Promise<{ id: string }>
  connectSession: (id: string) => Promise<void>
  savedSession: (id: string) => SessionConfig | null
  tui: () => TuiActivitySnapshot
  spawn: ShelfSpawn
  harness: ShelfHarnessRuntime
  retainSession?: (id: string, retained: boolean, history?: string) => void | Promise<void>
  localHost?: {
    probe: (id: string) => Promise<{ running: boolean } | null>
    restore: (id: string, name: string, cwd?: string) => Promise<ShelfSpawnResult>
  }
  harnessView?: () => Promise<{ recovery: Extract<ShelfRecovery, { kind: 'harness' }>; workspace?: string } | undefined>
  /** 生产显式传环境开关；默认 false 保留既有 fixture 测试语义（不自动归档）。 */
  startupArchiveEnabled?: boolean
  now?: () => number
}

export interface TaskShelfService {
  request: (request: TaskShelfRequest) => Promise<TaskShelfResult>
  /** 仅应用退出调用：从主进程权威会话描述实际页签，批量写入有界回收站，不启动或保活资源。 */
  recycleUnsavedTerminals: (ids: readonly string[]) => TaskShelfEntry[]
}

export type TaskShelfRestored = NonNullable<Extract<TaskShelfResult, { success: true }>['restored']>

type TerminalRecovery = Extract<ShelfRecovery, { kind: 'terminal' }>

/** CLI 会话 ID 要拼进命令行，只接受不会破坏参数边界的字符集。 */
const CLI_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** 只记录目标指纹，配置被改到另一主机／设备时不把旧任务接过去。 */
export function shelfConnectionKey(config: SessionConfig): string {
  const target = config.type === ConnectionType.SSH ? [config.ssh?.host.toLowerCase(), config.ssh?.port, config.ssh?.username]
    : config.type === ConnectionType.TELNET ? [config.telnet?.host.toLowerCase(), config.telnet?.port]
      : config.type === ConnectionType.SERIAL ? [config.serial?.path, config.serial?.baudRate] : []
  return createHash('sha256').update(JSON.stringify([config.type, target])).digest('hex')
}

function samePath(left: string, right: string): boolean {
  // 与 codeWorkspaceTargetKey 同一口径：展开 ~ 后 resolve，Windows 上忽略大小写。
  const normalize = (value: string): string => {
    const resolved = resolve(expandTilde(value.trim()))
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function cleanTitle(value: string | undefined, fallback: string): string {
  const text = (value ?? '').trim()
  return text ? text.slice(0, 200) : fallback
}

function agentFromTags(tags: string[] | undefined): { kind: 'codex' | 'claude' | 'dsh' | 'agent'; id: string } | undefined {
  for (const tag of tags ?? []) {
    for (const kind of ['codex', 'claude', 'dsh', 'agent'] as const) {
      const prefix = `${kind}:`
      if (tag.startsWith(prefix) && tag.length > prefix.length) return { kind, id: tag.slice(prefix.length).trim() }
    }
  }
  return undefined
}

/**
 * 任务保存区服务：capture 只读运行态并落一份安全恢复记录，restore 才显式启动。
 * 全部环境相关能力靠依赖注入，单测里不需要 electron / 原生模块。
 */
export function createTaskShelfService(deps: TaskShelfDeps): TaskShelfService {
  const now = deps.now ?? Date.now
  /** 同一记录的恢复串行化：并发点击共享同一个在途结果，绝不重复启动。 */
  const inflight = new Map<string, Promise<TaskShelfResult>>()
  /** entryId → 上一次恢复成功创建的 terminal id，用于「恢复后再次点击」直接复用原实例。 */
  const reused = new Map<string, string>()
  /** 精确 resume 已明确指定的 ID：官方首个 hook 到达前保留，不因启动中的空观察抹掉。 */
  const resumedCliIds = new Map<string, string>()
  /** 启动归档/分类命令：构造即同步完成一次初始化，之后所有 IPC 写入都排在其后。 */
  const commands = createTaskShelfCommandService({
    repository: deps.repository,
    startupArchiveEnabled: deps.startupArchiveEnabled ?? deps.archiveOnStart ?? false,
    ...(deps.now ? { now: deps.now } : {})
  })
  commands.ensureStartup()

  const list = (): TaskShelfEntry[] => deps.repository.list()

  function describeCapture(resource: ShelfResource, entryId: string | undefined): ShelfCaptureInput {
    if (resource.kind === 'harness') {
      // 只存固定类型与标题：后台地址、临时 token 一律不落盘，恢复交给官方工作台。
      return {
        entryId,
        resourceKey: `harness:${resource.id}`,
        title: 'DeepSeek Harness',
        recovery: { kind: 'harness' },
        capability: 'harness-history'
      }
    }

    if (resource.kind === 'web') {
      // POST 结果与不可保存的地址只保留在当前实例：连原 URL 都不写盘。
      const safe = resource.post === true ? undefined : shelfWebUrl(resource.url)
      const previous = entryId ? deps.repository.get(entryId) : list().find(entry => entry.resourceKey === `web:${resource.id}`)
      const readonlyMode = resource.readonlyMode === true
      const reloadableMode = resource.reloadableMode === true && !readonlyMode
      const sleep = (readonlyMode || reloadableMode) && previous?.recovery.kind === 'web' && previous.recovery.sleep?.url === safe && !!previous.recovery.readonlyMode === readonlyMode && !!previous.recovery.reloadableMode === reloadableMode ? previous.recovery.sleep : undefined
      return {
        entryId,
        resourceKey: `web:${resource.id}`,
        title: cleanTitle(resource.title, '网页'),
        recovery: safe ? { kind: 'web', url: safe, ...(readonlyMode ? { readonlyMode: true as const } : {}), ...(reloadableMode ? { reloadableMode: true as const } : {}), ...(sleep ? { sleep } : {}) } : { kind: 'web' },
        capability: safe ? 'web' : 'live-only'
      }
    }

    const live = deps.session(resource.id)
    if (!live) throw new Error('该终端已不在运行；只能收纳当前仍打开的任务')
    const config = live.config
    if (config.ownerPluginId) throw new Error('插件管理的终端请从原插件恢复，不能纳入任务保存区')
    const localHostId = live.localHostId ?? config.local?.terminalHostId
    const previous = entryId ? deps.repository.get(entryId) : list().find(entry => entry.resourceKey === `terminal:${resource.id}`)
    const previousSsh = config.type === ConnectionType.SSH && previous?.recovery.kind === 'terminal' && previous.recovery.type === ConnectionType.SSH && previous.recovery.connectionKey === shelfConnectionKey(config) ? previous : undefined
    const previousRecovery = previous?.recovery.kind === 'terminal' && localHostId && previous.recovery.localHostId === localHostId ? previous.recovery : undefined
    const agent = agentFromTags(config.tags) ?? (previousRecovery?.agentKind && previousRecovery.agentId ? { kind: previousRecovery.agentKind, id: previousRecovery.agentId } : undefined)
    const row = deps.tui().sessions.find(item => item.terminalId === resource.id)
    const cwd = config.type === ConnectionType.LOCAL ? live.cwd ?? config.local?.cwd : config.type === ConnectionType.SSH ? normalizeSshDirectory(live.cwd) ?? (previousSsh?.recovery.kind === 'terminal' ? normalizeSshDirectory(previousSsh.recovery.cwd) : undefined) : undefined
    const workspace = row?.workspace ?? (previousRecovery?.cliObservationLost ? previous?.workspace : undefined) ?? cwd
    // 已保存连接的引用：前端打开保存会话时会换新 runtime id，靠 originSavedSessionId 关联。
    const savedId = config.originSavedSessionId ?? (deps.savedSession(config.id) ? config.id : undefined)
    let cliSessionId =
      agent &&
      (agent.kind === 'codex' || agent.kind === 'claude') &&
      row?.source === agent.kind &&
      typeof row.cliSessionId === 'string' &&
      CLI_SESSION_ID.test(row.cliSessionId)
        ? row.cliSessionId
        : undefined
    if (cliSessionId) resumedCliIds.delete(resource.id)
    else if (agent?.kind === 'codex' || agent?.kind === 'claude') cliSessionId = resumedCliIds.get(resource.id)

    const recovery: TerminalRecovery = { kind: 'terminal', sessionId: resource.id, type: config.type }
    if (savedId) recovery.sessionConfigId = savedId
    if (cwd) recovery.cwd = cwd
    if (agent) {
      recovery.agentKind = agent.kind
      recovery.agentId = agent.id
    }
    if (cliSessionId) recovery.cliSessionId = cliSessionId
    else if (previousRecovery?.cliObservationLost) {
      // 主进程换代后，原进程内的 hook 地址仍属于旧主进程；旧 ID 仅为最后已知信息。
      recovery.cliObservationLost = true
      if (previousRecovery.cliSessionId) recovery.cliSessionId = previousRecovery.cliSessionId
    }
    if (config.type !== ConnectionType.LOCAL) recovery.connectionKey = shelfConnectionKey(config)
    if (config.type === ConnectionType.LOCAL && localHostId) recovery.localHostId = localHostId

    let capability: TaskShelfEntry['capability']
    if (config.type === ConnectionType.SSH) {
      capability = savedId ? 'reconnect' : 'live-only'
    } else if (agent?.kind === 'codex' || agent?.kind === 'claude') {
      // 有可信 CLI 会话 ID 才能精确续接；没有就标记「需手动选择历史」。
      capability = recovery.cliObservationLost ? localHostId ? 'local-live' : 'cli-history' : cliSessionId ? 'cli-resume' : 'cli-history'
    } else if (agent) {
      // dsh / 自定义 Agent：不重放提示、无可靠续接协议，只保证当前实例可用。
      capability = 'live-only'
    } else if (config.type === ConnectionType.LOCAL) {
      // 带启动命令的本地终端无法安全重放（命令不入库），只保留当前实例。
      capability = localHostId ? 'local-live' : config.startupCommands?.length ? 'live-only' : 'directory'
    } else {
      // 普通远端没有 tmux，只能按已保存连接重连；凭空重连会假装进程还在。
      capability = savedId ? 'reconnect' : 'live-only'
    }

    const contextText = config.type === ConnectionType.SSH ? captureSshContext(live.output ?? '', previousSsh?.context?.text) : undefined
    const context = contextText ? { text: contextText, capturedAt: contextText === previousSsh?.context?.text ? previousSsh.context.capturedAt : now() } : undefined
    return {
      resourceKey: `terminal:${resource.id}`,
      title: cleanTitle(config.name, '终端'),
      ...(workspace ? { workspace } : {}),
      recovery,
      capability,
      ...(context ? { context } : {}),
      entryId
    }
  }

  async function agentCwd(workspace: HarnessWorkspace): Promise<string> {
    const base = resolveWorkspaceCwd(workspace.cwd ?? '')
    if (!base.ok) throw new Error(`Agent 的工作目录已不可用：${workspace.cwd ?? ''}`)
    if (workspace.isolation !== 'worktree') return base.path
    if (!workspace.worktreeKey) throw new Error('Agent 的 worktree 未登记；恢复不会重建它')
    const trees = await listWorktreeKeys(base.path)
    if (!trees.ok) throw new Error(`无法确认 Agent 的 worktree：${trees.error}`)
    // 只认已登记的 worktree：恢复不重建目录，缺了就拒绝。
    if (!trees.keys.includes(workspace.worktreeKey)) throw new Error('Agent 的 worktree 已删除；恢复不会重建它')
    return join(trees.worktreeRoot, workspace.worktreeKey)
  }

  async function restoreCli(entry: TaskShelfEntry, recovery: TerminalRecovery): Promise<TaskShelfRestored> {
    const kind = recovery.agentKind
    if (kind !== 'codex' && kind !== 'claude') {
      throw new Error('这条记录不是 Claude/Codex 会话，不能按 CLI 精确续接')
    }
    const cliSessionId = recovery.cliSessionId
    if (!cliSessionId || !CLI_SESSION_ID.test(cliSessionId)) {
      throw new Error('没有可信的 CLI 会话 ID，不能精确续接；请在该启动器里手动选择历史记录')
    }
    if (!recovery.agentId) throw new Error('缺少 Agent 配置引用；请重新打开保存的工作区')
    if (!entry.workspace) throw new Error('缺少捕获时的工作目录；不能在默认目录重建会话')

    const workspace = deps.harness.workspace(kind, recovery.agentId)
    if (!workspace) throw new Error('Agent 启动项已删除；请重新创建后再恢复')
    // 配置改绑/换目录后绝不落到默认目录：目录与捕获时必须逐字一致。
    const cwd = await agentCwd(workspace)
    if (!samePath(cwd, entry.workspace)) throw new Error('Agent 的目录/worktree 已变更；拒绝在另一个目录恢复会话')

    const launch = await deps.harness.launch(kind, workspace)
    if (!launch.ok) throw new Error(launch.error)
    // 只接受本机 --help 确认过的精确续接形态：绝不退化成 --last / --continue。
    const command =
      kind === 'codex'
        ? /^codex\b/.test(launch.command)
          ? `${launch.command.replace(/^codex\b/, 'codex resume')} ${cliSessionId}`
          : undefined
        : /^claude\b/.test(launch.command)
          ? `${launch.command} --resume ${cliSessionId}`
          : undefined
    if (!command) throw new Error('启动命令不是预期的 CLI 形态；拒绝拼接续接参数')

    const result = await deps.spawn(
      `${entry.title} · 续接`,
      command,
      [`${kind}:${recovery.agentId}`],
      launch.env ? { cwd, env: launch.env, awaitConnection: true } : { cwd, awaitConnection: true }
    )
    if (!result.success || !result.id) throw new Error(result.error || '启动续接会话失败')
    reused.set(entry.id, result.id)
    resumedCliIds.set(result.id, cliSessionId)
    await deps.retainSession?.(result.id, true)
    // 新宿主身份在返回前落盘；前端还没挂载也能在再次启动时找回它。
    if (deps.session(result.id)) deps.repository.capture(describeCapture({ kind: 'terminal', id: result.id }, entry.id), now())
    return { kind: 'terminal', sessionId: result.id }
  }

  async function restoreDirectory(entry: TaskShelfEntry, recovery: TerminalRecovery): Promise<TaskShelfRestored> {
    const rebound = reused.get(entry.id)
    const live = rebound ? deps.session(rebound) : undefined
    if (live && live.config.type === ConnectionType.LOCAL) {
      // 原 PTY 还在（只是断开/出错）：就地重连，沿用同一实例的目录与配置。
      await deps.connectSession(rebound!)
      return { kind: 'terminal', sessionId: rebound! }
    }
    const cwd = recovery.cwd
    if (cwd) {
      const resolved = resolveWorkspaceCwd(cwd)
      if (!resolved.ok) throw new Error(`保存的工作目录已不可用：${cwd}`)
    }
    const result = await deps.spawn(entry.title, undefined, [], { ...(cwd ? { cwd } : {}), awaitConnection: true })
    if (!result.success || !result.id) throw new Error(result.error || '无法在保存的目录打开终端')
    reused.set(entry.id, result.id)
    await deps.retainSession?.(result.id, true)
    if (deps.session(result.id)) deps.repository.capture(describeCapture({ kind: 'terminal', id: result.id }, entry.id), now())
    return { kind: 'terminal', sessionId: result.id }
  }

  async function restoreSaved(entry: TaskShelfEntry, recovery: TerminalRecovery): Promise<TaskShelfRestored> {
    const runtimeId = reused.get(entry.id) ?? recovery.sessionId
    const live = deps.session(runtimeId)
    if (live) {
      if (recovery.connectionKey && shelfConnectionKey(live.config) !== recovery.connectionKey) throw new Error('原连接目标已变更，拒绝连接到其他主机或设备')
      if (live.config.type === ConnectionType.SSH && live.config.ssh) {
        live.config.ssh = { ...live.config.ssh, keepSessionAlive: false, resumeSessionName: undefined, resumeDirectory: normalizeSshDirectory(recovery.cwd) }
        live.config.startupCommands = undefined
      }
      // 标签页还在（连接已断）：按原配置重连同一个运行实例。
      reused.set(entry.id, runtimeId)
      if (live.config.type === ConnectionType.SSH && entry.context) await deps.retainSession?.(runtimeId, true, entry.context.text)
      await deps.connectSession(runtimeId)
      await deps.retainSession?.(runtimeId, true)
      return { kind: 'terminal', sessionId: runtimeId }
    }
    const savedId = recovery.sessionConfigId
    if (!savedId) throw new Error('缺少已保存连接的引用；请从保存的会话中重新打开')
    const saved = deps.savedSession(savedId)
    if (!saved) throw new Error('原已保存连接已被删除；无法自动重连')
    if (saved.type !== recovery.type || recovery.connectionKey && shelfConnectionKey(saved) !== recovery.connectionKey) throw new Error('已保存连接的目标已变更，拒绝连接到其他主机或设备')
    // 关掉的应用重启后没有运行实例：按保存配置克隆一个新 runtime 会话（凭据不经过保存区）。
    const stamp = new Date(now())
    const config: SessionConfig = {
      ...saved,
      id: randomUUID(),
      originSavedSessionId: saved.id,
      createdAt: stamp,
      updatedAt: stamp
    }
    if (config.type === ConnectionType.SSH && config.ssh) {
      config.ssh = { ...config.ssh, keepSessionAlive: false, resumeSessionName: undefined, resumeDirectory: normalizeSshDirectory(recovery.cwd) }
      // 保存区普通重连只尝试回目录，不重放配置中的业务启动命令。
      config.startupCommands = undefined
    }
    const session = await deps.createSession(config)
    reused.set(entry.id, session.id)
    if (config.type === ConnectionType.SSH && entry.context) await deps.retainSession?.(session.id, true, entry.context.text)
    await deps.connectSession(session.id)
    await deps.retainSession?.(session.id, true)
    return { kind: 'terminal', sessionId: session.id }
  }

  async function restoreTerminal(entry: TaskShelfEntry, recovery: TerminalRecovery): Promise<TaskShelfRestored> {
    // 1) 原运行实例仍然活着（或上一次恢复创建的实例还在）→ 直接返回，绝不重复启动。
    for (const id of [recovery.sessionId, reused.get(entry.id)]) {
      if (!id) continue
      const live = deps.session(id)
      if (live?.alive) {
        if (recovery.connectionKey && shelfConnectionKey(live.config) !== recovery.connectionKey) throw new Error('原连接目标已变更')
        await deps.retainSession?.(id, true)
        return { kind: 'terminal', sessionId: id }
      }
    }

    if (recovery.localHostId && deps.localHost) {
      // 探测失败（鉴权／传输／未知结果）不退化为新建，避免重跑正在执行的任务。
      const host = await deps.localHost.probe(recovery.localHostId)
      if (host?.running) {
        if (recovery.agentKind === 'codex' || recovery.agentKind === 'claude') {
          deps.repository.capture({ ...entry, recovery: { ...recovery, cliObservationLost: true }, capability: 'local-live', entryId: entry.id }, now())
        }
        const restored = await deps.localHost.restore(recovery.localHostId, entry.title, recovery.cwd)
        if (!restored.success || !restored.id) throw new Error(restored.error || '无法附着原本地终端')
        reused.set(entry.id, restored.id)
        return { kind: 'terminal', sessionId: restored.id }
      }
      if (recovery.type === ConnectionType.LOCAL) {
        // 已确认旧宿主结束：新建普通 shell，只恢复目录，不重放历史或启动命令。
        reused.delete(entry.id)
        return restoreDirectory(entry, recovery)
      }
    }

    if (recovery.type === ConnectionType.SSH && deps.session(reused.get(entry.id) ?? recovery.sessionId)) return restoreSaved(entry, recovery)
    if (recovery.type === ConnectionType.LOCAL && entry.capability !== 'cli-resume') return restoreDirectory(entry, recovery)
    switch (entry.capability) {
      case 'cli-resume':
        return restoreCli(entry, recovery)
      case 'cli-history':
        throw new Error('没有可信的 CLI 会话 ID，不能精确续接；请在该启动器里手动选择历史记录')
      case 'directory':
        return restoreDirectory(entry, recovery)
      case 'reconnect':
      case 'ssh-resume':
        return restoreSaved(entry, recovery)
      default:
        throw new Error('这条任务来自已结束的实例，没有可重放的启动信息；请重新打开它')
    }
  }

  async function restoreEntry(entry: TaskShelfEntry): Promise<TaskShelfRestored> {
    const recovery = entry.recovery
    if (recovery.kind === 'web') {
      if (!recovery.url) throw new Error('这条网页只在当前实例有效（POST 结果或不可保存的地址）；请重新打开它')
      return { kind: 'web', url: recovery.url }
    }
    if (recovery.kind === 'harness') return { ...recovery }
    return restoreTerminal(entry, recovery)
  }

  function restoreLocked(id: string): Promise<TaskShelfResult> {
    const running = inflight.get(id)
    if (running) return running
    const task = Promise.resolve().then(async (): Promise<TaskShelfResult> => {
      try {
        const entry = deps.repository.get(id)
        if (!entry) throw new Error('保存记录不存在')
        if (entry.trashedAt) throw new Error('请先激活回收站任务，再打开终端')
        const restored = await restoreEntry(entry)
        return { success: true, entries: list(), entry: deps.repository.get(id) ?? entry, restored, startup: commands.startup() }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }).finally(() => inflight.delete(id))
    inflight.set(id, task)
    return task
  }

  return {
    recycleUnsavedTerminals: ids => {
      if (commands.ensureStartup().status !== 'ready') throw new Error(commands.blockedError() ?? '任务保存区初始化未完成，无法保存回收站')
      const saved = list()
      const manuallySaved = saved.filter(entry => !entry.trashedAt)
      const knownResources = new Set(manuallySaved.map(entry => entry.resourceKey))
      const knownHosts = new Set(manuallySaved.flatMap(entry => entry.recovery.kind === 'terminal' && entry.recovery.localHostId ? [entry.recovery.localHostId.toLowerCase()] : []))
      const inputs: ShelfCaptureInput[] = []
      for (const id of new Set(ids)) {
        if (knownResources.has(`terminal:${id}`)) continue
        const session = deps.session(id)
        if (!session || session.config.ownerPluginId) continue
        const hostId = session.localHostId ?? session.config.local?.terminalHostId
        if (hostId && knownHosts.has(hostId.toLowerCase())) continue
        inputs.push(describeCapture({ kind: 'terminal', id }, undefined))
      }
      // 页签顺序稳定地打破同一创建时间的平局；同次退出优先保留最近新建的终端。
      inputs.sort((left, right) => {
        const created = (input: ShelfCaptureInput) => {
          const id = input.recovery.kind === 'terminal' ? input.recovery.sessionId : ''
          const raw = deps.session(id)?.config.createdAt
          const time = raw instanceof Date ? raw.getTime() : new Date(raw ?? 0).getTime()
          return Number.isFinite(time) ? time : 0
        }
        return created(left) - created(right)
      })
      return deps.repository.recycle(inputs, now())
    },
    request: async request => {
      try {
        // 初始化（加载 + 归档）同步完成后才进入任何写入分支；异步 capture 也走这条串行入口。
        const startup = commands.ensureStartup()
        // 初始化未完成时只允许 list 与 retryInitialization：restore 不是只读操作
        // （恢复成功后会改绑 resourceKey／标记 cliObservationLost），同样必须拦住。
        const initializationAllowed = request.kind === 'list' || request.kind === 'retryInitialization'
        if (startup.status === 'blocked' && !initializationAllowed) {
          throw Object.assign(new Error(commands.blockedError() ?? '任务保存区初始化未完成'), { code: SHELF_INITIALIZATION_BLOCKED })
        }
        switch (request.kind) {
          case 'list': {
            try {
              return { success: true, entries: list(), preferences: deps.repository.getPreferences(), startup }
            } catch (error) {
              // 归档文件损坏时保留原文件：如实报告初始化未完成，而不是假装空保存区。
              return { success: false, error: (error as Error).message, code: SHELF_INITIALIZATION_BLOCKED, startup }
            }
          }
          case 'preferences':
            return { success: true, entries: list(), preferences: deps.repository.setPreferences(request.preferences), startup }
          case 'archive': {
            const entry = deps.repository.archive(request.id, request.archived, now())
            return { success: true, entries: list(), entry, startup }
          }
          case 'unarchiveAll':
            // 只改列表归属：整批移回归档记录，绝不调用 restore/spawn/connect/retain。
            return { success: true, entries: deps.repository.unarchiveAll(now()), startup }
          case 'capture': {
            const input = describeCapture(request.resource, request.entryId)
            if (request.resource.kind === 'harness') {
              const view = await deps.harnessView?.().catch(() => undefined)
              const previous = request.entryId ? deps.repository.get(request.entryId) : list().find(entry => entry.resourceKey === input.resourceKey)
              if (view) { input.recovery = view.recovery; input.workspace = view.workspace }
              else if (previous?.recovery.kind === 'harness') { input.recovery = previous.recovery; input.workspace = previous.workspace }
            }
            const alreadyHeld = list().some(entry => entry.resourceKey === input.resourceKey || entry.id === input.entryId && entry.recovery.kind === 'terminal' && input.recovery.kind === 'terminal' && !!entry.recovery.localHostId && entry.recovery.localHostId === input.recovery.localHostId)
            if (request.resource.kind === 'terminal') await deps.retainSession?.(request.resource.id, true)
            let result
            try { result = deps.repository.capture(input, now()) }
            catch (error) {
              if (request.resource.kind === 'terminal' && !alreadyHeld) await Promise.resolve(deps.retainSession?.(request.resource.id, false)).catch(() => {})
              throw error
            }
            return { success: true, entries: list(), entry: result.entry, startup }
          }
          case 'remove': {
            const removed = deps.repository.get(request.id)
            if (!removed) throw new Error('保存记录不存在')
            // 回收项从未取得资源保留权：移除只删恢复记录，不探测、附着或变更原终端。
            if (removed.trashedAt !== undefined) {
              deps.repository.remove(request.id)
              reused.delete(request.id)
              return { success: true, entries: list(), startup }
            }
            let runtimeId = removed.recovery.kind === 'terminal' ? reused.get(request.id) ?? removed.recovery.sessionId : undefined
            let restored: TaskShelfRestored | undefined
            if (removed.recovery.kind === 'terminal' && removed.recovery.localHostId && deps.localHost && (!runtimeId || !deps.session(runtimeId)?.alive)) {
              try {
                // 能到达的原宿主先接回主区；这里只附着，不走可能新建 shell 的恢复链。
                const host = await deps.localHost.probe(removed.recovery.localHostId)
                if (host?.running) {
                  const attached = await deps.localHost.restore(removed.recovery.localHostId, removed.title, removed.recovery.cwd)
                  if (attached.success && attached.id) {
                    runtimeId = attached.id
                    reused.set(request.id, runtimeId)
                    restored = { kind: 'terminal', sessionId: runtimeId }
                  }
                }
              } catch {
                // 取消保存只删除记录：宿主失联/附着失败不阻止移除，也不推断原进程已结束。
              }
            }
            let retentionReleased = false
            if (runtimeId) {
              try { await deps.retainSession?.(runtimeId, false); retentionReleased = true }
              catch {
                // 释放保留标记同样可能遇到失联，不能让不可用的宿主锁住保存记录。
              }
            }
            try { deps.repository.remove(request.id) }
            catch (error) { if (runtimeId && retentionReleased) await Promise.resolve(deps.retainSession?.(runtimeId, true)).catch(() => {}); throw error }
            reused.delete(request.id)
            return { success: true, entries: list(), ...(restored ? { restored } : {}), startup }
          }
          case 'rename': {
            const entry = deps.repository.rename(request.id, request.title, now())
            return { success: true, entries: list(), entry, startup }
          }
          case 'activate': {
            // 只改分类与必要排序：不调用 restore/create/connect/launch，也不执行任何命令。
            const outcome = commands.activate(request)
            if (!outcome.success) return { success: false, error: outcome.error, code: outcome.code }
            return { success: true, entries: list(), startup: commands.startup(), activation: outcome.activation }
          }
          case 'retryInitialization': {
            const outcome = commands.retryInitialization(request.bootId, request.scopeId)
            if (!outcome.success) return { success: false, error: outcome.error, code: outcome.code }
            return { success: true, entries: list(), startup: outcome.startup }
          }
          case 'restore':
            return await restoreLocked(request.id)
          default:
            throw new Error('Unknown task shelf request')
        }
      } catch (error) {
        const code = (error as { code?: string }).code
        return { success: false, error: (error as Error).message, ...(code ? { code } : {}), ...(code === SHELF_INITIALIZATION_BLOCKED ? { startup: commands.startup() } : {}) }
      }
    }
  }
}
