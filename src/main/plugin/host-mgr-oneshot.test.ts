import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const HOST = fs.readFileSync(path.join(process.cwd(), 'src/main/plugin/host-mgr.ts'), 'utf-8')
const RUNNER = fs.readFileSync(path.join(process.cwd(), 'src/main/plugin-host/oneshot.ts'), 'utf-8')

describe('PluginHostManager Python oneshot 配线', () => {
  const runOneshotBody = HOST.slice(
    HOST.indexOf('runOneshot(pluginId:'),
    HOST.indexOf('/**\n   * 停止 plugin host')
  )

  it('绑定 capability token 前拒绝禁用插件', () => {
    const enabledCheckAt = runOneshotBody.indexOf('if (!entry.enabled)')
    const bindTokenAt = runOneshotBody.indexOf('bindPluginToken(')
    expect(enabledCheckAt).toBeGreaterThan(-1)
    expect(bindTokenAt).toBeGreaterThan(enabledCheckAt)
    expect(runOneshotBody).toContain("error: 'Plugin is disabled'")
  })

  it('通过 runScript 执行真实脚本路径，不读取源码后 execute', () => {
    expect(runOneshotBody).toContain('.runScript(mainPath, undefined, {')
    expect(runOneshotBody).not.toContain("readFileSync(mainPath, 'utf-8')")
  })

  it('同步启动异常会清理 controller、运行标记和 capability token', () => {
    const catchBody = runOneshotBody.slice(runOneshotBody.lastIndexOf('} catch (error) {'))
    expect(catchBody).toContain('this.pythonControllers.delete(pluginId)')
    expect(catchBody).toContain('finishRun()')
    expect(catchBody).toContain('return { success: false')
  })
})

describe('Node oneshot runner 信号清理', () => {
  it('SIGTERM/SIGINT 与正常 finally 共用幂等 cleanup', () => {
    expect(RUNNER).toContain("process.on('SIGTERM', () => shutdown('SIGTERM'))")
    expect(RUNNER).toContain("process.on('SIGINT', () => shutdown('SIGINT'))")
    expect(RUNNER).toContain('if (cleanupPromise) return cleanupPromise')
    expect(RUNNER).toContain('await cleanup()')
    expect(RUNNER).toContain('if (shuttingDown) {')
    expect(RUNNER).toContain("child.kill('SIGTERM')")
  })
})
