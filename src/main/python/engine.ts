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
  /** 取消信号:abort 时主动 SIGTERM 子进程(供 plugin host 在 stop() 时 kill python oneshot,见 host-mgr)。 */
  signal?: AbortSignal
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
 * LyShell Python API
 *
 * 经本地 HTTP API 回连主进程（127.0.0.1:{LYSHELL_MCP_PORT}），用 plugin token 鉴权。
 * token/port 由 plugin host 经 env 注入（LYSHELL_MCP_PORT / LYSHELL_PLUGIN_TOKEN）。
 *
 * 仅用标准库（urllib/json/os/sys），避免插件运行时对第三方包的依赖。
 * 缺 token/port 时方法抛 LyShellError -- 非插件上下文（裸脚本引擎未注入 token）不可用。
 *
 * 注意：此处是注入到插件 main.py 之前的「前置 API」。插件代码可直接用全局 `lyshell` 对象。
 */
const LYSHELL_API = `
import os
import sys
import json
import urllib.request
import urllib.error


class LyShellError(Exception):
    """LyShell API 调用异常（HTTP 失败 / success:false / 配置缺失）。"""
    pass


class LyShell:
    """LyShell Python API（经本地 HTTP 回连主进程）。

    session 解析顺序：显式 session_id 参数 > set_session 设置 > env LYSHELL_SESSION_ID。
    三者皆空则抛错 -- 插件不绑定会话，须显式指定目标 session。
    """

    def __init__(self):
        self._port = os.environ.get('LYSHELL_MCP_PORT', '')
        self._token = os.environ.get('LYSHELL_PLUGIN_TOKEN', '')
        self._session = os.environ.get('LYSHELL_SESSION_ID', '') or None
        # 让插件能 import 同目录模块 / 按相对路径开文件
        plugin_dir = os.environ.get('LYSHELL_PLUGIN_DIR', '')
        if plugin_dir and plugin_dir not in sys.path:
            sys.path.insert(0, plugin_dir)

    def get_current_session(self):
        """获取当前活动会话 ID（env 注入或 set_session 设置）。"""
        return self._session

    def set_session(self, session_id):
        """设置默认目标会话 ID。"""
        self._session = session_id

    def _resolve_session(self, session_id):
        sid = session_id or self._session
        if not sid:
            raise LyShellError(
                'no session_id given and no current session; pass session_id or call set_session()'
            )
        return sid

    def _call(self, path, body=None, timeout=310):
        if not self._port or not self._token:
            raise LyShellError(
                'LyShell API not configured: LYSHELL_MCP_PORT / LYSHELL_PLUGIN_TOKEN env missing'
            )
        url = 'http://127.0.0.1:{}{}'.format(self._port, path)
        data = json.dumps(body or {}).encode('utf-8')
        req = urllib.request.Request(
            url, data=data, method='POST',
            headers={'Content-Type': 'application/json', 'X-LyShell-Token': self._token},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            raw = ''
            try:
                raw = e.read().decode('utf-8')
                payload = json.loads(raw)
            except Exception:
                raise LyShellError('HTTP {}: {}'.format(e.code, raw or e.reason))
        if not isinstance(payload, dict) or not payload.get('success'):
            err = payload.get('error', 'unknown error') if isinstance(payload, dict) else 'invalid response'
            raise LyShellError(err)
        return payload.get('data')

    def execute(self, command, session_id=None, timeout=30000):
        """在会话上执行命令（独立 exec 通道，SSH/LOCAL），返回 {output, exitCode}。"""
        sid = self._resolve_session(session_id)
        return self._call('/api/execute', {'sessionId': sid, 'command': command, 'timeout': timeout})

    def send(self, text, session_id=None):
        """向交互式终端发送原始输入（支持换行/Ctrl+C 等转义序列），返回 {sent, bytes}。"""
        sid = self._resolve_session(session_id)
        return self._call('/api/send-input', {'sessionId': sid, 'text': text})

    def send_and_wait(self, text, session_id=None, wait_ms=2000, idle_ms=300,
                      max_wait_ms=10000, wait_for_pattern=None, auto_newline=True):
        """发送输入并等待输出稳定或命中模式，返回 {output, cleanOutput, settled, ...}。"""
        sid = self._resolve_session(session_id)
        body = {
            'sessionId': sid, 'text': text, 'waitMs': wait_ms,
            'idleMs': idle_ms, 'maxWaitMs': max_wait_ms, 'autoNewline': auto_newline,
        }
        if wait_for_pattern is not None:
            body['waitForPattern'] = wait_for_pattern
        return self._call('/api/send-and-wait', body)

    def wait_for(self, pattern=None, session_id=None, timeout_ms=30000):
        """等待终端出现 pattern（默认 shell 提示符），返回 {output, patternMatched, ...}。"""
        sid = self._resolve_session(session_id)
        body = {'sessionId': sid, 'timeoutMs': timeout_ms}
        if pattern is not None:
            body['pattern'] = pattern
        return self._call('/api/wait-for-prompt', body)

    def read_output(self, session_id=None, lines=100, raw=False):
        """读取终端最近输出，返回 {output, lines, totalBufferSize}。"""
        sid = self._resolve_session(session_id)
        return self._call('/api/read-output', {'sessionId': sid, 'lines': lines, 'raw': raw})

    def list_sessions(self, **filters):
        """列出会话（默认仅 connected/pinned）。支持 includeAll/type/tag/search 等过滤。"""
        return self._call('/api/sessions', filters)


lyshell = LyShell()
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
      LYSHELL_SESSION_ID: context?.session?.id || '',
      LYSHELL_SESSION_TYPE: context?.session?.type || '',
      LYSHELL_HOST: context?.session?.host || '',
      LYSHELL_PORT: String(context?.session?.port || ''),
    }

    // 添加 LyShell API
    const fullCode = LYSHELL_API + '\n' + code

    log.info(`Executing Python code (${executionId})`)

    return new Promise((resolve, reject) => {
      const proc = spawn(this.pythonPath!, ['-c', fullCode], {
        cwd,
        env,
        timeout
      })

      this.executions.set(executionId, proc)

      // 外部取消信号(plugin host stop()):abort 时主动 SIGTERM,免 python oneshot 滞留至 timeout。
      const signal = context?.signal
      const onAbort = (): void => {
        try { proc.kill('SIGTERM') } catch { /* 进程可能已退出 */ }
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

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
        if (signal) signal.removeEventListener('abort', onAbort)
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
        if (signal) signal.removeEventListener('abort', onAbort)
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