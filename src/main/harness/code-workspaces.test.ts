import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

const state = vi.hoisted(() => ({ profile: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.profile } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
let repo: string
beforeEach(() => {
  vi.resetModules()
  state.profile = mkdtempSync(join(tmpdir(), 'lyshell-code-presets-'))
  repo = join(state.profile, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'initial'], { cwd: repo, stdio: 'pipe' })
})
afterEach(() => {
  vi.restoreAllMocks()
  const target = resolve(state.profile)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('lyshell-code-presets-')) throw new Error('Unexpected fixture cleanup path')
  rmSync(target, { recursive: true, force: true })
})

describe('共享工作区预设', () => {
  it('未绑定启动器保存前完成迁移，重载仍未绑定；同步保存目标拒绝已删除的 ID', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const { preparedManagedTarget, ensureManagedWorkspaces } = await import('./workspace-governance')
    await ensureManagedWorkspaces()
    const target = preparedManagedTarget()
    expect(target).toEqual({ workspacePresetId: undefined, cwd: '', isolation: 'shared', worktreeKey: undefined })
    const { agentRepository } = await import('../storage/agent-repository')
    const item = agentRepository.add({ name: 'Unbound', command: 'tool', order: 0, ...target })!
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'App', cwd: repo } })
    if (!saved.success) throw new Error(saved.error)
    const id = saved.presets[0].id
    expect(preparedManagedTarget(id).cwd).toBe(repo)
    await requestCodeWorkspaces({ kind: 'delete', id })
    expect(() => preparedManagedTarget(id)).toThrow('Workspace preset not found')
    vi.resetModules()
    const reloaded = await import('./code-workspaces')
    expect(await reloaded.requestCodeWorkspaces({ kind: 'list' })).toEqual({ success: true, presets: [] })
    const { agentRepository: reopened } = await import('../storage/agent-repository')
    expect(reopened.get(item.id)?.cwd).toBe('')
    expect(reopened.get(item.id)?.workspacePresetId).toBeUndefined()
  })
  it('无目录的旧命令保留主目录，不被绑定到列表首个 worktree', async () => {
    const { codeWorkspacePresetRepository: presets } = await import('../storage/harness-workspace-repository')
    const first = presets.add({ name: 'Other project', cwd: repo, isolation: 'worktree', worktreeKey: 'other' })!
    const { agentRepository } = await import('../storage/agent-repository')
    const old = agentRepository.add({ name: 'Legacy command', command: 'tool', order: 0 })!
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const result = await requestCodeWorkspaces({ kind: 'list' })
    if (!result.success) throw new Error(result.error)
    const migrated = agentRepository.get(old.id)!
    expect(migrated.workspacePresetId).not.toBe(first.id)
    expect(migrated.cwd).toBe(resolve(process.env.USERPROFILE || process.env.HOME || homedir()))
    expect(migrated.isolation).toBe('shared')
    expect(migrated.worktreeKey).toBeUndefined()
    expect(result.presets).toHaveLength(2)
  })

  it('没有预设时也保留旧命令的主目录，迁移后可从设置管辖的列表访问', async () => {
    const { agentRepository } = await import('../storage/agent-repository')
    const old = agentRepository.add({ name: 'Legacy command', command: 'tool', order: 0 })!
    const { listManagedLaunchers } = await import('./workspace-governance')
    expect(await listManagedLaunchers(() => agentRepository.getAll())).toEqual([
      expect.objectContaining({ id: old.id, cwd: resolve(process.env.USERPROFILE || process.env.HOME || homedir()), isolation: 'shared' })
    ])
  })

  it('旧预设中的主目录缩写和点路径归一化，目录树不包含伪目录段', async () => {
    const { codeWorkspacePresetRepository: presets } = await import('../storage/harness-workspace-repository')
    presets.add({ name: 'Home', cwd: '~' })
    presets.add({ name: 'Project', cwd: `${repo}${sep}..${sep}repo${sep}.` })
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const result = await requestCodeWorkspaces({ kind: 'list' })
    if (!result.success) throw new Error(result.error)
    expect(result.presets.map(item => item.cwd)).toEqual([homedir(), repo])
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { id: result.presets[1].id, name: 'Project', cwd: `${repo}${sep}.` } })
    expect(saved.success && saved.presets[1].cwd).toBe(repo)
  })

  it('通用命令迁移进设置，保留命令和环境绑定，重新进入不会重复导入', async () => {
    const { agentRepository } = await import('../storage/agent-repository')
    for (const item of agentRepository.getAll()) agentRepository.delete(item.id)
    const old = agentRepository.add({ name: 'Custom tool', command: 'tool --resume', cwd: repo, env: { TEST_KEY: 'fixture' }, envProfileId: 'profile', envKeyMap: { apiKey: 'TOOL_KEY' }, order: 0 })!
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const result = await requestCodeWorkspaces({ kind: 'list' })
    if (!result.success) throw new Error(result.error)
    expect(result.presets).toHaveLength(1)
    expect(agentRepository.get(old.id)).toEqual(expect.objectContaining({ ...old, isolation: 'shared', workspacePresetId: result.presets[0].id }))
    const { listManagedLaunchers } = await import('./workspace-governance')
    expect(await listManagedLaunchers(() => agentRepository.getAll())).toHaveLength(1)
    vi.resetModules()
    const reloaded = await import('./code-workspaces')
    expect(await reloaded.requestCodeWorkspaces({ kind: 'list' })).toEqual(result)
  })

  it('设置改目录后启动项按 ID 跟随；悬空引用按未引用工作目录列出，不借用旧快照目录', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'App', cwd: repo } })
    if (!saved.success) throw new Error(saved.error)
    const id = saved.presets[0].id
    const { agentRepository } = await import('../storage/agent-repository')
    const item = agentRepository.add({ name: 'Tool', command: 'tool', workspacePresetId: id, cwd: 'stale-invalid-path', order: 0 })!
    const next = join(state.profile, 'next')
    mkdirSync(next)
    await requestCodeWorkspaces({ kind: 'save', preset: { id, name: 'Moved', cwd: next } })
    const { requireManagedTarget, listManagedLaunchers } = await import('./workspace-governance')
    expect(await requireManagedTarget(id)).toEqual(expect.objectContaining({ cwd: next, workspacePresetId: id }))
    expect((await listManagedLaunchers(() => agentRepository.getAll()))[0]).toEqual(expect.objectContaining({ id: item.id, command: 'tool', cwd: next }))
    agentRepository.update({ ...item, workspacePresetId: 'deleted' })
    await expect(requireManagedTarget('deleted')).rejects.toThrow('Workspace preset not found')
    // 悬空引用不再被过滤：照常列出为「未引用工作目录」，cwd 投影为空串，
    // 启动时走用户主目录，绝不借用预设删除前的旧快照目录。
    const unbound = await listManagedLaunchers(() => agentRepository.getAll())
    expect(unbound).toHaveLength(1)
    expect(unbound[0]).toEqual(expect.objectContaining({
      id: item.id,
      command: 'tool',
      cwd: '',
      isolation: 'shared',
      worktreeKey: undefined,
      workspacePresetId: undefined
    }))
    // 投影只影响返回值，不改写存储
    expect(agentRepository.get(item.id)?.cwd).toBe('stale-invalid-path')
  })

  it('关联落盘失败不写完成标记，重试复用已导入的设置项', async () => {
    const { agentRepository } = await import('../storage/agent-repository')
    for (const item of agentRepository.getAll()) agentRepository.delete(item.id)
    agentRepository.add({ name: 'Tool', command: 'tool', cwd: repo, order: 0 })
    const update = vi.spyOn(agentRepository, 'update').mockReturnValueOnce(false)
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    expect((await requestCodeWorkspaces({ kind: 'list' })).success).toBe(false)
    expect(existsSync(join(state.profile, 'config', 'workspace-governance-v2.json'))).toBe(false)
    update.mockRestore()
    const result = await requestCodeWorkspaces({ kind: 'list' })
    expect(result.success && result.presets).toHaveLength(1)
    expect(existsSync(join(state.profile, 'config', 'workspace-governance-v2.json'))).toBe(true)
  })

  it('没有设置目标的启动项照常列出为未引用工作目录，且不会重建独立目录', async () => {
    const { listManagedLaunchers, ensureManagedWorkspaces } = await import('./workspace-governance')
    const { agentRepository } = await import('../storage/agent-repository')
    await ensureManagedWorkspaces()
    expect(await listManagedLaunchers(() => agentRepository.getAll())).toHaveLength(0)
    const unmanaged = agentRepository.add({ name: 'Unmanaged', command: 'tool', cwd: repo, order: 3 })!
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    expect(await requestCodeWorkspaces({ kind: 'list' })).toEqual({ success: true, presets: [] })
    // 迁移已完成，不再把无预设的启动项导入成新目录；启动项以「未引用工作目录」形态列出
    const listed = await listManagedLaunchers(() => agentRepository.getAll())
    expect(listed).toEqual([expect.objectContaining({
      id: unmanaged.id,
      name: 'Unmanaged',
      command: 'tool',
      cwd: '',
      isolation: 'shared',
      workspacePresetId: undefined
    })])
    expect(agentRepository.get(unmanaged.id)?.cwd).toBe(repo)
  })
  it('保存时实际创建 worktree，重读复用，删除配置保留未提交文件', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const result = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Feature', cwd: repo, isolation: 'worktree', worktreeKey: 'feature' } })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)
    const tree = join(repo, '.lyshell-worktrees', 'feature')
    expect(existsSync(tree)).toBe(true)
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: tree, encoding: 'utf8' }).trim()).toBe('lyshell/feature')
    writeFileSync(join(tree, 'keep.txt'), 'uncommitted')
    vi.resetModules()
    const reloaded = await import('./code-workspaces')
    expect((await reloaded.requestCodeWorkspaces({ kind: 'list' }))).toEqual(result)
    const preset = result.presets[0]
    const updated = await reloaded.requestCodeWorkspaces({ kind: 'save', preset: { ...preset, name: 'Feature renamed' } })
    expect(updated.success).toBe(true)
    const removed = await reloaded.requestCodeWorkspaces({ kind: 'delete', id: preset.id })
    expect(removed).toEqual({ success: true, presets: [] })
    expect(readFileSync(join(tree, 'keep.txt'), 'utf8')).toBe('uncommitted')
  }, 15000)

  it('非 Git 目录不能建 worktree，失败不保存预设；普通目录可保存', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const cwd = join(state.profile, 'plain')
    mkdirSync(cwd)
    const failed = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Invalid tree', cwd, isolation: 'worktree', worktreeKey: 'feature' } })
    expect(failed.success).toBe(false)
    expect(await requestCodeWorkspaces({ kind: 'list' })).toEqual({ success: true, presets: [] })
    expect((await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Plain', cwd, isolation: 'shared' } })).success).toBe(true)
    const duplicate = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Another name', cwd, isolation: 'shared' } })
    expect(duplicate.success && duplicate.presets).toHaveLength(1)
  }, 15000)

  it('全部导入两边目录预设，精确重复合并，重名区分，旧模型/环境/权限原样保留', async () => {
    const { codexWorkspaceRepository: codex, claudeWorkspaceRepository: claude } = await import('../storage/harness-workspace-repository')
    const other = join(state.profile, 'missing-directory')
    codex.add({ name: 'Project', cwd: repo, model: 'codex-model', envProfileId: 'codex-profile', codexPermissions: ':read-only' })
    codex.add({ name: 'Same directory different name', cwd: repo })
    claude.add({ name: 'Project', cwd: repo + sep, model: 'claude-model', claudePermissions: 'plan' })
    claude.add({ name: 'Project', cwd: other })
    const config = join(state.profile, 'config')
    const sourceFiles = ['codex-workspaces.json', 'claude-workspaces.json'].map(name => join(config, name))
    const before = sourceFiles.map(file => readFileSync(file, 'utf8'))
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const result = await requestCodeWorkspaces({ kind: 'list' })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)
    expect(result.presets.map(item => item.name)).toEqual(['Project', 'Project (2)'])
    expect(result.presets[1].cwd).toBe(other)
    // 引用数：同一目录的 codex/claude 记录都归到其预设 ID 上
    expect(result.usage).toEqual({ [result.presets[0].id]: 3, [result.presets[1].id]: 1 })
    expect(result.presets.every(item => !('model' in item) && !('envProfileId' in item) && !('claudePermissions' in item) && !('codexPermissions' in item))).toBe(true)
    const parameters = (text: string) => (JSON.parse(text) as Array<Record<string, unknown>>).map(({ cwd: _cwd, isolation: _isolation, worktreeKey: _key, workspacePresetId: _preset, ...item }) => item)
    expect(sourceFiles.map(file => parameters(readFileSync(file, 'utf8')))).toEqual(before.map(parameters))
    expect(codex.getAll().every(item => result.presets.some(preset => preset.id === item.workspacePresetId))).toBe(true)

    // 删除被引用的预设不再拒绝：先跨库清空引用再删预设，启动项全部保留（explicit clear），
    // 磁盘目录/分支从不删除，重载后也不会重新导入成新预设。
    const removed = await requestCodeWorkspaces({ kind: 'delete', id: result.presets[0].id })
    expect(removed.success).toBe(true)
    if (!removed.success) throw new Error(removed.error)
    expect(removed.presets.map(item => item.name)).toEqual(['Project (2)'])
    // 引用数按剩余预设统计（alias 折叠后），删除后立即返回最新值
    expect(removed.usage).toEqual({ [result.presets[1].id]: 1 })
    // 启动项不丢失，只清 workspacePresetId / cwd / 隔离参数，其它属性原样保留
    expect(codex.getAll()).toHaveLength(2)
    expect(claude.getAll()).toHaveLength(2)
    expect(codex.getAll().every(item => item.workspacePresetId === undefined)).toBe(true)
    expect(codex.getAll().every(item => item.cwd === '' && item.isolation === 'shared' && item.worktreeKey === undefined)).toBe(true)
    expect(codex.getAll().map(item => item.model)).toEqual(['codex-model', undefined])
    expect(codex.getAll()[0].envProfileId).toBe('codex-profile')
    expect(codex.getAll()[0].codexPermissions).toBe(':read-only')
    // 不误伤无关项：指向另一个目录的 claude 记录原样跟随剩余预设
    const untouched = claude.getAll().find(item => item.cwd === other)
    expect(untouched?.workspacePresetId).toBe(result.presets[1].id)
    expect(untouched?.claudePermissions).toBeUndefined()
    expect(claude.getAll().find(item => item.model === 'claude-model')?.claudePermissions).toBe('plan')
    // 磁盘目录仍在
    expect(existsSync(repo)).toBe(true)
    vi.resetModules()
    const reloaded = await import('./code-workspaces')
    const next = await reloaded.requestCodeWorkspaces({ kind: 'list' })
    expect(next.success && next.presets).toHaveLength(1)
    // 重载后启动项仍是 2 条（cwd='' 可正常加载），没有被重新导入成预设
    const { codexWorkspaceRepository: codex2, claudeWorkspaceRepository: claude2 } = await import('../storage/harness-workspace-repository')
    expect(codex2.getAll()).toHaveLength(2)
    expect(claude2.getAll()).toHaveLength(2)
    expect(codex2.getAll().every(item => item.workspacePresetId === undefined)).toBe(true)
  })

  it('无显式 key 的旧 worktree 保持原目录、分支与未提交文件', async () => {
    const { codexWorkspaceRepository: codex } = await import('../storage/harness-workspace-repository')
    const old = codex.add({ name: 'Legacy tree', cwd: repo, isolation: 'worktree', model: 'keep-model' })!
    const key = `codex-${old.id}`
    const { ensureWorktree } = await import('./worktree')
    const tree = await ensureWorktree(repo, key)
    if (!tree.ok) throw new Error(tree.error)
    writeFileSync(join(tree.path, 'keep.txt'), 'uncommitted')
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const result = await requestCodeWorkspaces({ kind: 'list' })
    expect(result.success && result.presets[0]).toEqual(expect.objectContaining({ name: 'Legacy tree', cwd: repo, isolation: 'worktree', worktreeKey: key }))
    expect(codex.get(old.id)).toEqual(expect.objectContaining({ ...old, worktreeKey: key, workspacePresetId: result.success && result.presets[0].id }))
    expect(readFileSync(join(tree.path, 'keep.txt'), 'utf8')).toBe('uncommitted')
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: tree.path, encoding: 'utf8' }).trim()).toBe(`lyshell/${key}`)
  }, 15000)

  it('部分保存失败可重试，已导入的重名项不重复，全部成功后才标记完成', async () => {
    const { HarnessWorkspaceRepository, codexWorkspaceRepository: codex, claudeWorkspaceRepository: claude } = await import('../storage/harness-workspace-repository')
    codex.add({ name: 'Project', cwd: repo })
    claude.add({ name: 'Project', cwd: join(state.profile, 'other') })
    const original = HarnessWorkspaceRepository.prototype.add
    const add = vi.spyOn(HarnessWorkspaceRepository.prototype, 'add')
      .mockImplementationOnce(original)
      .mockReturnValueOnce(null)
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    expect((await requestCodeWorkspaces({ kind: 'list' })).success).toBe(false)
    const marker = join(state.profile, 'config', 'code-workspace-presets-migration.json')
    expect(existsSync(marker)).toBe(false)
    add.mockRestore()
    const result = await requestCodeWorkspaces({ kind: 'list' })
    expect(result.success && result.presets.map(item => item.name)).toEqual(['Project', 'Project (2)'])
    expect(existsSync(marker)).toBe(true)
  })

  it('已经迁移的品牌后缀会清理，同目标异名自动合并；不同树可以共用基础名', async () => {
    const { HarnessWorkspaceRepository } = await import('../storage/harness-workspace-repository')
    const destination = new HarnessWorkspaceRepository('code-workspace-presets.json')
    const kept = destination.add({ name: 'Project', cwd: repo, isolation: 'shared' })!
    const duplicate = destination.add({ name: 'Project model variant (claude)', cwd: repo + sep, isolation: 'shared' })!
    destination.add({ name: 'Project (codex)', cwd: repo, isolation: 'worktree', worktreeKey: 'feature' })
    destination.add({ name: 'Project (claude)', cwd: repo, isolation: 'worktree', worktreeKey: 'other-feature' })
    writeFileSync(join(state.profile, 'config', 'code-workspace-presets-migration.json'), JSON.stringify({ version: 1 }))
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const result = await requestCodeWorkspaces({ kind: 'list' })
    expect(result.success && result.presets.map(item => item.name)).toEqual(['Project', 'Project', 'Project'])
    expect(result.success && result.aliases?.[duplicate.id]).toBe(kept.id)
    vi.resetModules()
    const reloaded = await import('./code-workspaces')
    expect(await reloaded.requestCodeWorkspaces({ kind: 'list' })).toEqual(result)
  })

  it('合并落盘失败不删除内存或磁盘原记录，重试保留同一工作区身份', async () => {
    const { HarnessWorkspaceRepository } = await import('../storage/harness-workspace-repository')
    const destination = new HarnessWorkspaceRepository('code-workspace-presets.json')
    destination.add({ name: 'Project', cwd: repo })
    destination.add({ name: 'Alias', cwd: repo })
    const path = join(state.profile, 'config', 'code-workspace-presets.json')
    const before = readFileSync(path, 'utf8')
    const { normalizeCodeWorkspaces } = await import('./normalize-code-workspaces')
    const replace = vi.spyOn(HarnessWorkspaceRepository.prototype, 'replaceAll').mockReturnValueOnce(false)
    const marker = join(state.profile, 'config', 'code-workspace-presets-merge.json')
    expect(() => normalizeCodeWorkspaces(destination, marker)).toThrow('Could not merge')
    expect(destination.getAll()).toHaveLength(2)
    expect(readFileSync(path, 'utf8')).toBe(before)
    replace.mockRestore()
    normalizeCodeWorkspaces(destination, marker)
    expect(destination.getAll()).toHaveLength(1)
  })

  it('保存时允许同名不同树，重复目标合并，编辑到相同目标后旧选择仍可定位', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const plain = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Project', cwd: repo, isolation: 'shared' } })
    if (!plain.success) throw new Error(plain.error)
    await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Project', cwd: repo, isolation: 'worktree', worktreeKey: 'one' } })
    const trees = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Project', cwd: repo, isolation: 'worktree', worktreeKey: 'two' } })
    expect(trees.success && trees.presets).toHaveLength(3)
    if (!trees.success) throw new Error(trees.error)
    const one = trees.presets.find(item => item.worktreeKey === 'one')!
    const duplicate = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Alias', cwd: repo, isolation: 'worktree', worktreeKey: 'one' } })
    expect(duplicate.success && duplicate.presets).toHaveLength(3)
    const merged = await requestCodeWorkspaces({ kind: 'save', preset: { id: plain.presets[0].id, name: 'Project', cwd: repo, isolation: 'worktree', worktreeKey: 'one' } })
    expect(merged.success && merged.presets).toHaveLength(2)
    expect(merged.success && merged.aliases?.[one.id]).toBe(plain.presets[0].id)
  }, 15000)

  it('合并别名上的引用计入保留项，按别名 ID 删除同样清空跨库引用', async () => {
    const { codeWorkspacePresetRepository: presets, codexWorkspaceRepository: codex } = await import('../storage/harness-workspace-repository')
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Project', cwd: repo, isolation: 'shared' } })
    if (!saved.success) throw new Error(saved.error)
    // 手工写入重复目标的第二条预设（模拟旧版本遗留），走合并后成为别名
    const duplicate = presets.add({ name: 'Legacy duplicate', cwd: repo, isolation: 'shared' })!
    const bound = codex.add({ name: 'Bound to duplicate', cwd: repo, workspacePresetId: duplicate.id, model: 'keep-model' })!
    const listed = await requestCodeWorkspaces({ kind: 'list' })
    if (!listed.success) throw new Error(listed.error)
    expect(listed.aliases?.[duplicate.id]).toBe(saved.presets[0].id)
    // 别名引用折算到仍存在的预设 ID 上
    expect(listed.usage).toEqual({ [saved.presets[0].id]: 1 })
    const removed = await requestCodeWorkspaces({ kind: 'delete', id: duplicate.id })
    expect(removed).toEqual({ success: true, presets: [] })
    // 启动项保留且引用已清空，其它属性不变
    expect(codex.get(bound.id)).toEqual(expect.objectContaining({
      id: bound.id,
      name: 'Bound to duplicate',
      cwd: '',
      model: 'keep-model',
      isolation: 'shared',
      workspacePresetId: undefined
    }))
  })

  it('删除预设落盘失败时回滚引用并明确报错，不留悬空绑定', async () => {
    const { codeWorkspacePresetRepository: presets, codexWorkspaceRepository: codex, dshWorkspaceRepository: dsh, claudeWorkspaceRepository: claude } = await import('../storage/harness-workspace-repository')
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Project', cwd: repo, isolation: 'shared' } })
    if (!saved.success) throw new Error(saved.error)
    const bound = codex.add({ name: 'Project', cwd: repo, workspacePresetId: saved.presets[0].id, model: 'keep-model' })!
    const remove = vi.spyOn(presets, 'delete').mockReturnValueOnce(false)
    const writeDsh = vi.spyOn(dsh, 'replaceAll')
    const writeClaude = vi.spyOn(claude, 'replaceAll')
    const failed = await requestCodeWorkspaces({ kind: 'delete', id: saved.presets[0].id })
    expect(failed.success).toBe(false)
    if (failed.success) throw new Error('unreachable')
    expect(failed.error).toContain('could not be deleted')
    remove.mockRestore()
    // 引用回滚到删除前：预设仍在，启动器仍指向它且 cwd 未被清空
    expect(presets.get(saved.presets[0].id)).toBeTruthy()
    expect(codex.get(bound.id)?.workspacePresetId).toBe(saved.presets[0].id)
    expect(codex.get(bound.id)?.cwd).toBe(repo)
    expect(codex.get(bound.id)?.model).toBe('keep-model')
    expect(writeDsh).not.toHaveBeenCalled()
    expect(writeClaude).not.toHaveBeenCalled()
    // 重试即可成功删除
    expect((await requestCodeWorkspaces({ kind: 'delete', id: saved.presets[0].id })).success).toBe(true)
  })

  it('清除引用落盘失败时中止删除并回滚，设置项与绑定都在', async () => {
    const { codeWorkspacePresetRepository: presets, codexWorkspaceRepository: codex } = await import('../storage/harness-workspace-repository')
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Project', cwd: repo, isolation: 'shared' } })
    if (!saved.success) throw new Error(saved.error)
    const id = saved.presets[0].id
    const bound = codex.add({ name: 'Project', cwd: repo, workspacePresetId: id })!
    const fail = vi.spyOn(codex, 'replaceAll').mockReturnValueOnce(false)
    const failed = await requestCodeWorkspaces({ kind: 'delete', id })
    expect(failed.success).toBe(false)
    if (failed.success) throw new Error('unreachable')
    expect(failed.error).toContain('Could not clear launcher references')
    fail.mockRestore()
    // 设置项没有被删，引用已回滚
    expect(presets.get(id)).toBeTruthy()
    expect(codex.get(bound.id)?.workspacePresetId).toBe(id)
    expect(codex.get(bound.id)?.cwd).toBe(repo)
    expect((await requestCodeWorkspaces({ kind: 'list' })).success).toBe(true)
  })
})

describe('启动工作区预设', () => {
  it('共享目录启动回调收到预设与解析后的 cwd', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Shared', cwd: repo, isolation: 'shared' } })
    if (!saved.success) throw new Error(saved.error)
    const preset = saved.presets[0]
    const launch = vi.fn(async () => {})
    expect(await requestCodeWorkspaces({ kind: 'launch', id: preset.id }, launch)).toEqual(saved)
    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledWith(preset, repo)
  })

  it('worktree 启动回调收到实际 worktree 路径，保留未提交文件与分支', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Feature', cwd: repo, isolation: 'worktree', worktreeKey: 'feature' } })
    if (!saved.success) throw new Error(saved.error)
    const preset = saved.presets[0]
    const tree = join(repo, '.lyshell-worktrees', 'feature')
    writeFileSync(join(tree, 'keep.txt'), 'uncommitted')
    const launch = vi.fn(async () => {})
    expect(await requestCodeWorkspaces({ kind: 'launch', id: preset.id }, launch)).toEqual(saved)
    expect(launch).toHaveBeenCalledWith(preset, tree)
    expect(readFileSync(join(tree, 'keep.txt'), 'utf8')).toBe('uncommitted')
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: tree, encoding: 'utf8' }).trim()).toBe('lyshell/feature')
  }, 15000)

  it('别名 id 启动解析到保留预设与其 worktree 路径', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const plain = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Project', cwd: repo, isolation: 'shared' } })
    if (!plain.success) throw new Error(plain.error)
    const one = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Project', cwd: repo, isolation: 'worktree', worktreeKey: 'one' } })
    if (!one.success) throw new Error(one.error)
    const oneId = one.presets.find(item => item.worktreeKey === 'one')!.id
    const merged = await requestCodeWorkspaces({ kind: 'save', preset: { id: plain.presets[0].id, name: 'Project', cwd: repo, isolation: 'worktree', worktreeKey: 'one' } })
    if (!merged.success) throw new Error(merged.error)
    expect(merged.aliases?.[oneId]).toBe(plain.presets[0].id)
    const launch = vi.fn(async () => {})
    expect(await requestCodeWorkspaces({ kind: 'launch', id: oneId }, launch)).toEqual(merged)
    expect(launch).toHaveBeenCalledWith(merged.presets[0], join(repo, '.lyshell-worktrees', 'one'))
  }, 15000)

  it('未知 id 启动失败且不调用回调', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const launch = vi.fn(async () => {})
    expect((await requestCodeWorkspaces({ kind: 'launch', id: 'missing' }, launch)).success).toBe(false)
    expect(launch).not.toHaveBeenCalled()
  })

  it('已删除 id 启动失败且不调用回调', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Shared', cwd: repo, isolation: 'shared' } })
    if (!saved.success) throw new Error(saved.error)
    const preset = saved.presets[0]
    await requestCodeWorkspaces({ kind: 'delete', id: preset.id })
    const launch = vi.fn(async () => {})
    expect((await requestCodeWorkspaces({ kind: 'launch', id: preset.id }, launch)).success).toBe(false)
    expect(launch).not.toHaveBeenCalled()
  })

  it('预设目录已被移除时启动失败且不调用回调', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const removed = join(state.profile, 'removed')
    mkdirSync(removed)
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Gone', cwd: removed, isolation: 'shared' } })
    if (!saved.success) throw new Error(saved.error)
    const preset = saved.presets.find(item => item.cwd === removed)!
    rmSync(removed, { recursive: true, force: true })
    const launch = vi.fn(async () => {})
    expect((await requestCodeWorkspaces({ kind: 'launch', id: preset.id }, launch)).success).toBe(false)
    expect(launch).not.toHaveBeenCalled()
  })

  it('缺少启动回调时启动失败', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Shared', cwd: repo, isolation: 'shared' } })
    if (!saved.success) throw new Error(saved.error)
    expect((await requestCodeWorkspaces({ kind: 'launch', id: saved.presets[0].id })).success).toBe(false)
  })

  it('父目录启动使用父路径，不新增或修改预设；盘符/文件系统根也能启动', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Shared', cwd: repo, isolation: 'shared' } })
    if (!saved.success) throw new Error(saved.error)
    const id = saved.presets[0].id
    const launch = vi.fn(async () => {})
    expect(await requestCodeWorkspaces({ kind: 'launchDirectory', id, cwd: state.profile }, launch)).toEqual(saved)
    expect(launch).toHaveBeenLastCalledWith(expect.objectContaining({ name: basename(state.profile), isolation: 'shared' }), state.profile)
    const { parse } = await import('node:path')
    const root = parse(repo).root
    expect((await requestCodeWorkspaces({ kind: 'launchDirectory', id, cwd: root }, launch)).success).toBe(true)
    expect(launch).toHaveBeenLastCalledWith(expect.objectContaining({ name: root }), root)
    expect(await requestCodeWorkspaces({ kind: 'list' })).toEqual(saved)
  })

  it('只有 worktree 的项目也能启动原仓库目录，无需创建另一个 worktree', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Feature', cwd: repo, isolation: 'worktree', worktreeKey: 'feature' } })
    if (!saved.success) throw new Error(saved.error)
    const launch = vi.fn(async () => {})
    expect(await requestCodeWorkspaces({ kind: 'launchDirectory', id: saved.presets[0].id, cwd: repo }, launch)).toEqual(saved)
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ name: 'repo', isolation: 'shared', worktreeKey: undefined }), repo)
  }, 15000)

  it('拒绝非祖先、同前缀兄弟目录、子目录、相对路径、文件和不存在的路径', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Shared', cwd: repo, isolation: 'shared' } })
    if (!saved.success) throw new Error(saved.error)
    const sibling = repo + '-sibling'
    const child = join(repo, 'child')
    const file = join(state.profile, 'file.txt')
    mkdirSync(sibling)
    mkdirSync(child)
    writeFileSync(file, 'fixture')
    const launch = vi.fn(async () => {})
    for (const cwd of [sibling, child, '.', file, join(state.profile, 'missing')]) {
      expect((await requestCodeWorkspaces({ kind: 'launchDirectory', id: saved.presets[0].id, cwd }, launch)).success).toBe(false)
    }
    expect((await requestCodeWorkspaces({ kind: 'launchDirectory', id: 'missing', cwd: state.profile }, launch)).success).toBe(false)
    expect(launch).not.toHaveBeenCalled()
  })

  it('回调抛错必须传播为拒绝，不报告成功', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Shared', cwd: repo, isolation: 'shared' } })
    if (!saved.success) throw new Error(saved.error)
    const preset = saved.presets[0]
    await expect(requestCodeWorkspaces({ kind: 'launch', id: preset.id }, async () => { throw new Error('launcher exploded') })).rejects.toThrow('launcher exploded')
  })
})
