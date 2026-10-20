import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
    expect(result.presets.every(item => !('model' in item) && !('envProfileId' in item) && !('claudePermissions' in item) && !('codexPermissions' in item))).toBe(true)
    expect(sourceFiles.map(file => readFileSync(file, 'utf8'))).toEqual(before)

    // 删除预设后重启不复活旧条目；原启动记录仍在。
    await requestCodeWorkspaces({ kind: 'delete', id: result.presets[0].id })
    vi.resetModules()
    const reloaded = await import('./code-workspaces')
    const next = await reloaded.requestCodeWorkspaces({ kind: 'list' })
    expect(next.success && next.presets).toHaveLength(1)
    expect(codex.getAll()).toHaveLength(2)
    expect(claude.getAll()).toHaveLength(2)
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
    expect(codex.get(old.id)).toEqual({ ...old, worktreeKey: key })
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

  it('回调抛错必须传播为拒绝，不报告成功', async () => {
    const { requestCodeWorkspaces } = await import('./code-workspaces')
    const saved = await requestCodeWorkspaces({ kind: 'save', preset: { name: 'Shared', cwd: repo, isolation: 'shared' } })
    if (!saved.success) throw new Error(saved.error)
    const preset = saved.presets[0]
    await expect(requestCodeWorkspaces({ kind: 'launch', id: preset.id }, async () => { throw new Error('launcher exploded') })).rejects.toThrow('launcher exploded')
  })
})
