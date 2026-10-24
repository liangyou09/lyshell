import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseProjectScene, type ProjectScene } from '@shared/project-scene'
import { atomicWriteFileSync, getConfigDir } from './repository'

/** 每个保存点独立保留；手动保存，最多 30 份，不因浏览/恢复自动覆盖。 */
export class ProjectSceneRepository {
  constructor(private readonly file = join(getConfigDir(), 'project-scenes.json')) {}
  list(): ProjectScene[] {
    if (!existsSync(this.file)) return []
    const data = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: unknown; scenes?: unknown }
    if (data.version !== 1 || !Array.isArray(data.scenes) || data.scenes.length > 30) throw new Error('Unsupported or damaged project scene archive; original file retained')
    // 不静默覆盖损坏/未来版本。
    return data.scenes.map(parseProjectScene)
  }
  save(input: Omit<ProjectScene, 'version' | 'id' | 'savedAt'>): ProjectScene {
    const scene = parseProjectScene({ ...input, version: 1, id: randomUUID(), savedAt: Date.now() })
    const scenes = [scene, ...this.list()].slice(0, 30)
    atomicWriteFileSync(this.file, JSON.stringify({ version: 1, scenes }, null, 2))
    return scene
  }
}
