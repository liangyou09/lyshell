import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'

/**
 * 配置存储路径 - 延迟获取
 */
let configDirCache: string | null = null
export const getConfigDir = (): string => {
  if (!configDirCache) {
    const userDataPath = app.getPath('userData')
    const configDir = join(userDataPath, 'config')

    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true })
    }

    configDirCache = configDir
  }
  return configDirCache
}

