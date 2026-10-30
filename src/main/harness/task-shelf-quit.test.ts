import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recycleTaskShelfTerminalsForQuit, setTaskShelfQuitCollector, setTaskShelfTerminalTabs } from './task-shelf-quit'

beforeEach(() => { setTaskShelfTerminalTabs([]); setTaskShelfQuitCollector(() => {}) })

describe('退出前终端页签快照', () => {
  it('保留最后登记的页签 ID，来源数组后续变化不会污染退出快照', () => {
    const ids = ['first', 'second']
    const collect = vi.fn()
    setTaskShelfQuitCollector(collect)
    setTaskShelfTerminalTabs(ids)
    ids.pop()
    recycleTaskShelfTerminalsForQuit()
    expect(collect).toHaveBeenCalledWith(['first', 'second'])
    recycleTaskShelfTerminalsForQuit()
    expect(collect).toHaveBeenCalledTimes(1)
    setTaskShelfTerminalTabs(['second'])
    recycleTaskShelfTerminalsForQuit()
    expect(collect).toHaveBeenLastCalledWith(['second'])
  })
  it('空页签集合会覆盖旧快照，错误交由退出流程处理而不伪装成功', () => {
    const collect = vi.fn().mockImplementation(() => { throw new Error('disk unavailable') })
    setTaskShelfQuitCollector(collect)
    setTaskShelfTerminalTabs(['old'])
    setTaskShelfTerminalTabs([])
    expect(() => recycleTaskShelfTerminalsForQuit()).toThrow('disk unavailable')
    expect(() => recycleTaskShelfTerminalsForQuit()).toThrow('disk unavailable')
    expect(collect).toHaveBeenCalledTimes(2)
    expect(collect).toHaveBeenCalledWith([])
  })
})
