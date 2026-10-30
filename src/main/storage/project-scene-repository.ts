import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import log from 'electron-log'
import { parseProjectScene, type ProjectScene } from '@shared/project-scene'
import { atomicWriteFileSync, getConfigDir } from './repository'
import { JsonStoreLoadError, loadJsonFileSync, RevisionConflictError, writeBackupSync } from './atomic-json'

interface ProjectSceneArchive {
  scenes: ProjectScene[]
}

/**
 * 校验整份项目场景归档；未知版本/超限/损坏一律保留原件并显式报错，
 * 不自动回退旧备份、也不用空列表覆盖（避免丢掉用户手动保存的现场）。
 */
function parseArchive(raw: unknown): ProjectSceneArchive {
  const data = raw as { version?: unknown; scenes?: unknown }
  if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.scenes) || data.scenes.length > 30) {
    throw new Error('Unsupported or damaged project scene archive; original file retained')
  }
  return { scenes: data.scenes.map(parseProjectScene) }
}

/** 每个保存点独立保留；手动保存，最多 30 份，不因浏览/恢复自动覆盖。 */
export class ProjectSceneRepository {
  private scenes: ProjectScene[] | null = null
  private revision = 0
  private loadError: JsonStoreLoadError | null = null

  constructor(private readonly file = join(getConfigDir(), 'project-scenes.json')) {}

  getRevision(): number {
    this.ensureLoaded()
    return this.revision
  }

  getLoadError(): JsonStoreLoadError | null {
    this.ensureLoaded()
    return this.loadError
  }

  list(): ProjectScene[] {
    this.ensureLoaded()
    return this.scenes!.map(scene => structuredClone(scene))
  }

  save(input: Omit<ProjectScene, 'version' | 'id' | 'savedAt'>, options: { expectedRevision?: number } = {}): ProjectScene {
    this.ensureLoaded()
    if (options.expectedRevision !== undefined && options.expectedRevision !== this.revision) {
      throw new RevisionConflictError(this.file, options.expectedRevision, this.revision)
    }
    const scene = parseProjectScene({ ...input, version: 1, id: randomUUID(), savedAt: Date.now() })
    const next = [scene, ...this.scenes!].slice(0, 30)
    const json = JSON.stringify({ version: 1, scenes: next }, null, 2)
    // 先写盘成功再换内存；写失败由 helper 保留上一份有效文件并抛出。
    atomicWriteFileSync(this.file, json)
    if (!writeBackupSync(this.file, json)) {
      log.warn('Failed to refresh project scene backup; primary commit succeeded')
    }
    this.scenes = next
    this.revision += 1
    return structuredClone(scene)
  }

  private ensureLoaded(): void {
    if (this.scenes) return
    const result = loadJsonFileSync<ProjectSceneArchive>(this.file, {
      validate: parseArchive,
      backup: false
    })
    if (result.status === 'missing') {
      this.scenes = []
      return
    }
    if (result.status === 'failed') {
      this.loadError = result.error
      throw result.error
    }
    this.scenes = result.value.scenes
  }
}
