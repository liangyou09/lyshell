import { spawn, ChildProcess } from 'child_process'
import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import log from 'electron-log'
import { EventEmitter } from 'events'

/**
 * 执行上下文
 */
export interface ExecutionContext {
  session?: {
    id: string
    type: string
    host?: string
    port?: number
  }
  env?: Record<string, string>
  cwd?: string
  timeout?: number
}

/**
 * 执行结果
 */
export interface ExecutionResult {
  stdout: string
  stderr: string
  exitCode: number
  duration: number
  outputs?: any[]
}

/**
 * Python 环境
 */
export interface PythonEnvironment {
  path: string
  version: string
  available: boolean
}

/**
 * NovaShell Python API
 */
const NOVASHELL_API = `
class NovaShell:
    """NovaShell Python API"""

    def __init__(self):
        self._session = None

    def get_current_session(self):
        """获取当前活动会话"""
        return self._session

    def set_session(self, session_info):
        """设置会话信息"""
        self._session = session_info

    def execute(self, command):
        """在会话中执行命令（需要主进程支持）"""
        print(f"[NovaShell] Execute: {command}")
        return {"command": command, "status": "pending"}

    def send(self, data):
        """发送数据到会话"""
        print(f"[NovaShell] Send: {data}")

    def wait_for(self, pattern, timeout=30):
        """等待特定输出"""
        print(f"[NovaShell] Wait for: {pattern}")
        return None

novashell = NovaShell()
`

/**
 * Python 执行引擎
 */
export class PythonEngine extends EventEmitter {
  private pythonPath: string | null = null
  private executions: Map<string, ChildProcess> = new Map()

  constructor() {
    super()
    this.detectPython()
  }

  /**
   * 检测 Python 环境
   */
  private detectPython(): void {
    // 优先使用便携版 Python
    const portablePython = join(process.resourcesPath, 'python', 'python.exe')
    if (existsSync(portablePython)) {
      this.pythonPath = portablePython
      log.info(`Using portable Python: ${portablePython}`)
      return
    }

    // 检测系统 Python
    const systemPaths = process.env.PATH?.split(';') || []
    for (const p of systemPaths) {
      const pythonPath = join(p, 'python.exe')
      if (existsSync(pythonPath)) {
        this.pythonPath = pythonPath
        log.info(`Using system Python: ${pythonPath}`)
        return
      }
    }

    log.warn('Python not found')
  }

  /**
   * 设置 Python 路径
   */
  setPythonPath(path: string): void {
    this.pythonPath = path
    log.info(`Python path set: ${path}`)
  }

  /**
   * 获取 Python 环境
   */
  async getEnvironment(): Promise<PythonEnvironment> {
    if (!this.pythonPath) {
      return { path: '', version: '', available: false }
    }

    try {
      const result = await this.runCommand('--version')
      return {
        path: this.pythonPath,
        version: result.stdout.trim(),
        available: true
      }
    } catch {
      return { path: this.pythonPath, version: '', available: false }
    }
  }

  /**
   * 执行 Python 代码
   */
  async execute(code: string, context?: ExecutionContext): Promise<ExecutionResult> {
    if (!this.pythonPath) {
      throw new Error('Python not available. Please install Python or configure path.')
    }

    const executionId = Date.now().toString()
    const timeout = context?.timeout || 60000
    const cwd = context?.cwd || app.getPath('temp')
    const startTime = Date.now()

    // 准备执行环境
    const env = {
      ...process.env,
      ...context?.env,
      NOVASHELL_SESSION_ID: context?.session?.id || '',
      NOVASHELL_SESSION_TYPE: context?.session?.type || '',
      NOVASHELL_HOST: context?.session?.host || '',
      NOVASHELL_PORT: String(context?.session?.port || ''),
    }

    // 添加 NovaShell API
    const fullCode = NOVASHELL_API + '\n' + code

    log.info(`Executing Python code (${executionId})`)

    return new Promise((resolve, reject) => {
      const proc = spawn(this.pythonPath!, ['-c', fullCode], {
        cwd,
        env,
        timeout
      })

      this.executions.set(executionId, proc)

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data) => {
        stdout += data.toString()
        this.emit('output', { executionId, type: 'stdout', data: data.toString() })
      })

      proc.stderr?.on('data', (data) => {
        stderr += data.toString()
        this.emit('output', { executionId, type: 'stderr', data: data.toString() })
      })

      proc.on('close', (code) => {
        this.executions.delete(executionId)
        const duration = Date.now() - startTime

        log.info(`Python execution completed (${executionId}): exit=${code}, duration=${duration}ms`)

        resolve({
          stdout,
          stderr,
          exitCode: code || 0,
          duration
        })
      })

      proc.on('error', (error) => {
        this.executions.delete(executionId)
        log.error(`Python execution error (${executionId}):`, error)
        reject(error)
      })
    })
  }

  /**
   * 执行 Python 脚本文件
   */
  async runScript(path: string, args?: string[], context?: ExecutionContext): Promise<ExecutionResult> {
    if (!this.pythonPath) {
      throw new Error('Python not available')
    }

    const executionId = Date.now().toString()
    const timeout = context?.timeout || 60000
    const cwd = context?.cwd || app.getPath('temp')
    const startTime = Date.now()

    log.info(`Running Python script: ${path}`)

    return new Promise((resolve, reject) => {
      const proc = spawn(this.pythonPath!, [path, ...(args || [])], {
        cwd,
        timeout
      })

      this.executions.set(executionId, proc)

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data) => {
        stdout += data.toString()
      })

      proc.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        this.executions.delete(executionId)
        resolve({
          stdout,
          stderr,
          exitCode: code || 0,
          duration: Date.now() - startTime
        })
      })

      proc.on('error', reject)
    })
  }

  /**
   * 终止执行
   */
  terminate(executionId: string): void {
    const proc = this.executions.get(executionId)
    if (proc) {
      proc.kill()
      this.executions.delete(executionId)
      log.info(`Python execution terminated: ${executionId}`)
    }
  }

  /**
   * 运行简单命令
   */
  private async runCommand(args: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.pythonPath!, [args])
      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data) => stdout += data.toString())
      proc.stderr?.on('data', (data) => stderr += data.toString())
      proc.on('close', () => resolve({ stdout, stderr }))
      proc.on('error', reject)
    })
  }
}

// 单例
export const pythonEngine = new PythonEngine()