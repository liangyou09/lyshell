import { describe, expect, it, vi } from 'vitest'
import { delimiter } from 'path'
vi.mock('electron', () => ({ app: { getPath: () => 'test-data' } }))
vi.mock('../env/refresh', () => ({ readSystemPath: () => 'system-bin' }))
import { withMarketToolPath } from './market-tools'

describe('市场工具 PATH', () => {
  it('只修改子进程环境，保留已有工具及其他变量', () => {
    const env = { PATH: 'existing-bin', DSH_HOME: 'profile-home' }
    expect(withMarketToolPath(env, 'managed tools')).toEqual({ PATH: `managed tools${delimiter}existing-bin`, DSH_HOME: 'profile-home' })
    expect(env.PATH).toBe('existing-bin')
  })
  it('Windows 合并 Path/PATH，避免大写 PATH 把工具目录盖掉', () => {
    if (process.platform !== 'win32') return
    expect(withMarketToolPath({ Path: 'user-bin' }, 'managed-bin')).toEqual({ PATH: `managed-bin${delimiter}user-bin` })
    expect(withMarketToolPath({ PATH: 'system-bin', Path: 'override-bin' }, 'managed-bin')).toEqual({ PATH: `managed-bin${delimiter}override-bin` })
  })
})
