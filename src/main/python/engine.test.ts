import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { PythonEngine } from './engine'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileSync, mkdirSync, rmSync } from 'fs'

// electron-log 在测试环境不存在，mock 掉避免初始化失败
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))

// electron app.getPath 在 Node 测试环境不可用
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() }
}))

describe('PythonEngine.spawnScript', () => {
  const engine = new PythonEngine()
  const testDir = join(tmpdir(), `lyshell-python-engine-test-${Date.now()}`)

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  it('找不到 Python 时抛出错误', () => {
    const noPython = new PythonEngine()
    noPython.setPythonPath('')
    const script = join(testDir, 'noop.py')
    writeFileSync(script, 'pass')
    expect(() => noPython.spawnScript(script)).toThrow('Python not available')
  })

  it('找不到脚本时抛出错误', () => {
    expect(() => engine.spawnScript(join(testDir, 'not-exist.py'))).toThrow('Script not found')
  })

  it('spawn 后返回子进程句柄与 executionId，进程退出后回调触发', async () => {
    const script = join(testDir, 'short-lived.py')
    writeFileSync(script, 'print("hello")')

    const { proc, executionId } = engine.spawnScript(script, { cwd: testDir })
    expect(proc).toBeDefined()
    expect(proc.pid).toBeGreaterThan(0)
    expect(executionId).toBeTypeOf('string')

    // 等待进程自然退出
    await new Promise<void>((resolve) => {
      proc.on('close', () => resolve())
    })
  })

  it('并发启动返回互不碰撞的 executionId', async () => {
    const script = join(testDir, 'concurrent.py')
    writeFileSync(script, 'import time\ntime.sleep(0.1)\n')

    const first = engine.spawnScript(script, { cwd: testDir })
    const second = engine.spawnScript(script, { cwd: testDir })
    expect(first.executionId).not.toBe(second.executionId)

    await Promise.all([first.proc, second.proc].map(proc => new Promise<void>((resolve) => {
      proc.on('close', () => resolve())
    })))
  })

  it('通过 AbortSignal 可终止 persistent 进程', async () => {
    const script = join(testDir, 'sleep.py')
    writeFileSync(script, 'import time\ntime.sleep(60)\n')

    const controller = new AbortController()
    const { proc } = engine.spawnScript(script, { cwd: testDir, signal: controller.signal })

    // 确认进程已启动
    await new Promise<void>((resolve) => {
      if (proc.pid) resolve()
      else proc.on('spawn', () => resolve())
    })

    controller.abort()

    await new Promise<void>((resolve) => {
      proc.on('close', () => resolve())
    })
  })

  it('env 注入到脚本环境', async () => {
    const script = join(testDir, 'env.py')
    writeFileSync(script, 'import os\nprint(os.environ.get("LYSHELL_TEST_KEY", ""))\n')

    const { proc } = engine.spawnScript(script, {
      cwd: testDir,
      env: { LYSHELL_TEST_KEY: 'persistent-value' }
    })

    let stdout = ''
    proc.stdout?.on('data', (d) => {
      stdout += d.toString()
    })

    await new Promise<void>((resolve) => {
      proc.on('close', () => resolve())
    })

    expect(stdout).toContain('persistent-value')
  })

  it('按真实脚本语义设置 __file__、sys.argv[0] 并注入 lyshell', async () => {
    const script = join(testDir, 'script-semantics.py')
    writeFileSync(script, [
      'import json',
      'import sys',
      'print(json.dumps({',
      '    "file": __file__,',
      '    "argv0": sys.argv[0],',
      '    "api": type(lyshell).__name__,',
      '}))'
    ].join('\n'))

    const { proc } = engine.spawnScript(script, { cwd: testDir })
    let stdout = ''
    proc.stdout?.on('data', (data) => {
      stdout += data.toString()
    })

    await new Promise<void>((resolve) => {
      proc.on('close', () => resolve())
    })

    const result = JSON.parse(stdout.trim())
    expect(result.file).toBe(script)
    expect(result.argv0).toBe(script)
    expect(result.api).toBe('LyShell')
  })

  it('大脚本源码不进入 Python 命令行参数', async () => {
    const script = join(testDir, 'large.py')
    writeFileSync(script, `payload = ${JSON.stringify('x'.repeat(40000))}\nprint(len(payload))\n`)

    const { proc } = engine.spawnScript(script, { cwd: testDir })
    let stdout = ''
    proc.stdout?.on('data', (data) => {
      stdout += data.toString()
    })

    await new Promise<void>((resolve) => {
      proc.on('close', () => resolve())
    })

    expect(stdout.trim()).toBe('40000')
  })

  it('runScript 被 AbortSignal 终止时返回非零退出码和 signal', async () => {
    const script = join(testDir, 'oneshot-abort.py')
    writeFileSync(script, 'import time\ntime.sleep(60)\n')
    const controller = new AbortController()
    const resultPromise = engine.runScript(script, undefined, { cwd: testDir, signal: controller.signal })

    setTimeout(() => controller.abort(), 50)
    const result = await resultPromise
    expect(result.exitCode).not.toBe(0)
    expect(result.signal).toBeTruthy()
  })

  it('runScript oneshot 保留 __file__、argv[0]、参数与 lyshell 注入', async () => {
    const script = join(testDir, 'oneshot-semantics.py')
    writeFileSync(script, [
      'import json',
      'import sys',
      'print(json.dumps({',
      '    "file": __file__,',
      '    "argv": sys.argv,',
      '    "api": type(lyshell).__name__,',
      '}))'
    ].join('\n'))

    const result = await engine.runScript(script, ['first'], { cwd: testDir })
    const output = JSON.parse(result.stdout.trim())
    expect(result.exitCode).toBe(0)
    expect(output.file).toBe(script)
    expect(output.argv).toEqual([script, 'first'])
    expect(output.api).toBe('LyShell')
  })

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      /* ignore cleanup errors */
    }
  })
})
