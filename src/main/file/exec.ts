import type { Client, ClientChannel } from 'ssh2'
import log from 'electron-log'
import { BaseFileConnector } from './base'
import { SSHFileClient } from './ssh-file-client'
import type { FileInfo, TransferProgress } from '@shared/types'
import { FileConnectorType } from '@shared/types'
import * as fs from 'fs'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'

/**
 * Python Agent 脚本（内嵌）
 * 使用 JSON 行文本协议，避免 shell 对二进制数据的干扰
 */
const PYTHON_AGENT_SCRIPT = `
import sys
import os
import json
import base64
import time

IDLE_TIMEOUT = 300
READ_TIMEOUT = 30

def recv_line(timeout=READ_TIMEOUT):
    """接收一行数据"""
    line = ''
    start = time.time()
    while time.time() - start < timeout:
        ch = sys.stdin.read(1)
        if not ch: return None
        if ch == '\\n': return line
        line += ch
    return None

def send_response(resp):
    """发送 JSON 行响应"""
    print(json.dumps(resp), flush=True)

def recv_command(timeout=READ_TIMEOUT):
    """接收 JSON 行命令"""
    line = recv_line(timeout)
    if not line: return None
    line = line.strip()
    if not line: return None
    try: return json.loads(line)
    except: return None

def recv_binary(timeout=READ_TIMEOUT):
    """接收 base64 编码的二进制数据"""
    line = recv_line(timeout)
    if not line: return None
    try: return base64.b64decode(line.strip())
    except: return None

def send_binary(data):
    """发送 base64 编码的二进制数据"""
    print(base64.b64encode(data).decode(), flush=True)

def handle_upload(cmd):
    path = cmd['path']
    size = cmd['size']
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    transferred = 0
    with open(path, 'wb') as f:
        while transferred < size:
            chunk = recv_binary()
            if not chunk: break
            f.write(chunk)
            transferred += len(chunk)
            send_response({'progress': round(transferred/size*100, 1)})
    send_response({'status': 'ok', 'transferred': transferred})

def handle_download(cmd):
    path = cmd['path']
    try:
        size = os.path.getsize(path)
        send_response({'status': 'ready', 'size': size})
        with open(path, 'rb') as f:
            while True:
                chunk = f.read(1048576)  # 1MB chunks for faster transfer
                if not chunk: break
                send_binary(chunk)
        send_response({'status': 'ok', 'transferred': size})
    except Exception as e:
        send_response({'status': 'error', 'message': str(e)})

def handle_list(cmd):
    path = cmd['path']
    try:
        entries = []
        for name in os.listdir(path):
            fp = os.path.join(path, name)
            st = os.stat(fp)
            entries.append({'name':name,'path':fp,'isDir':os.path.isdir(fp),'size':st.st_size,'mtime':st.st_mtime,'perms':oct(st.st_mode)[-3:]})
        send_response({'status': 'ok', 'entries': entries})
    except Exception as e:
        send_response({'status': 'error', 'message': str(e)})

def handle_stat(cmd):
    path = cmd['path']
    try:
        st = os.stat(path)
        send_response({'status':'ok','name':os.path.basename(path),'path':path,'isDir':os.path.isdir(path),'size':st.st_size,'mtime':st.st_mtime,'perms':oct(st.st_mode)[-3:]})
    except Exception as e:
        send_response({'status': 'error', 'message': str(e)})

def handle_delete(cmd):
    path = cmd['path']
    try:
        if os.path.isdir(path):
            import shutil
            shutil.rmtree(path)
        else:
            os.remove(path)
        send_response({'status': 'ok'})
    except Exception as e:
        send_response({'status': 'error', 'message': str(e)})

def handle_mkdir(cmd):
    path = cmd['path']
    try:
        os.makedirs(path, exist_ok=True)
        send_response({'status': 'ok'})
    except Exception as e:
        send_response({'status': 'error', 'message': str(e)})

def handle_rename(cmd):
    try:
        os.rename(cmd['oldPath'], cmd['newPath'])
        send_response({'status': 'ok'})
    except Exception as e:
        send_response({'status': 'error', 'message': str(e)})

def main():
    last = time.time()
    while True:
        try:
            if time.time() - last > IDLE_TIMEOUT:
                send_response({'status': 'timeout'})
                break
            cmd = recv_command(min(READ_TIMEOUT, IDLE_TIMEOUT - (time.time() - last)))
            if not cmd: break
            last = time.time()
            action = cmd.get('action')
            if action == 'upload': handle_upload(cmd)
            elif action == 'download': handle_download(cmd)
            elif action == 'list': handle_list(cmd)
            elif action == 'stat': handle_stat(cmd)
            elif action == 'delete': handle_delete(cmd)
            elif action == 'mkdir': handle_mkdir(cmd)
            elif action == 'rename': handle_rename(cmd)
            elif action == 'ping': send_response({'status': 'ok', 'pong': True})
            elif action == 'exit': send_response({'status': 'ok'}); break
            else: send_response({'status': 'error', 'message': 'Unknown'})
        except Exception as e:
            send_response({'status': 'error', 'message': str(e)})
            break

if __name__ == '__main__':
    main()
`


/**
 * Exec 文件连接器
 * 使用持久化的 SSH shell channel 执行命令
 * 支持 Python Agent 模式进行高效文件传输
 * 接收 SSHFileClient，使用独立的 SSH 连接
 */
export class ExecFileConnector extends BaseFileConnector {
  private sshFileClient: SSHFileClient
  private shellEnterCommands?: string[]
  private shellEnterWait: number
  private shellChannel: ClientChannel | null = null
  private shellReady: boolean = false  // shell 是否已准备好（执行了 enter commands）
  private outputBuffer: string = ''
  private pendingResolve: ((output: string) => void) | null = null
  private pendingReject: ((error: Error) => void) | null = null
  private currentMarker: string | null = null  // 当前命令的 marker
  private commandQueue: { command: string; resolve: (output: string) => void; reject: (error: Error) => void; rawMode?: boolean }[] = []
  private isProcessing: boolean = false
  // 使用 UUID 格式的 marker，更独特不易混淆
  private markerPrefix = '___END_MARKER_UUID_'
  // 原始模式标志（用于 MD5 计算）
  private rawMode: boolean = false

  // Python Agent 相关
  private agentChannel: ClientChannel | null = null
  private agentReady: boolean = false
  private agentPath: string = '/tmp/lyshell_agent.py'
  private agentBuffer: Buffer = Buffer.alloc(0)

  constructor(sessionId: string, sshFileClient: SSHFileClient, shellEnterCommands?: string, shellEnterWait?: number) {
    super(sessionId, FileConnectorType.EXEC)
    this.sshFileClient = sshFileClient
    this.shellEnterCommands = shellEnterCommands?.split('\n').filter(c => c.trim())
    this.shellEnterWait = shellEnterWait || 1000
    log.debug(`ExecFileConnector created for session ${sessionId}`)
  }

  /**
   * 获取 SSH Client（通过 SSHFileClient）
   */
  private async getClient(): Promise<Client> {
    return this.sshFileClient.getClient()
  }

  /**
   * 初始化持久化 shell channel
   * 改进版本：添加就绪检测机制，确保 shell 真正可用
   */
  private async initShellChannel(): Promise<void> {
    // 如果 shell channel 存在且已准备好，直接返回
    if (this.shellChannel && this.shellReady) {
      log.debug('[FileManager] shell channel already exists and ready')
      return
    }

    // 如果 shell channel 存在但未准备好，需要关闭并重新创建
    if (this.shellChannel && !this.shellReady) {
      log.debug('[FileManager] shell channel exists but not ready, re-initializing...')
      this.shellChannel.close()
      this.shellChannel = null
    }

    const client = await this.getClient()

    log.debug('[FileManager] creating new shell channel...')
    return new Promise((resolve, reject) => {
      log.debug('[FileManager] Initializing shell channel')

      client.shell((err, stream) => {
        if (err) {
          log.error(`[FileManager] Shell channel error: ${err.message}`)
          reject(err)
          return
        }

        this.shellChannel = stream
        this.shellReady = false  // 初始化为未准备好
        log.debug('[FileManager] Shell channel created')

        // 收集输出
        stream.on('data', (data: Buffer) => {
          const chunk = data.toString()
          this.outputBuffer += chunk
          log.debug(`[FileManager] Shell data received: ${chunk.length} bytes`)
          // 只打印前 100 字符，避免太多日志
          if (chunk.length < 100) {
            log.debug(`[FileManager] Shell data content: "${chunk.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`)
          }

          // 检查是否有 marker（表示命令完成）
          this.checkForMarker()
        })

        stream.on('close', () => {
          log.debug('[FileManager] Shell channel closed')
          this.shellChannel = null
          this.shellReady = false
          this.currentMarker = null
          // 拒绝所有等待中的命令
          if (this.pendingReject) {
            this.pendingReject(new Error('Shell channel closed'))
            this.pendingResolve = null
            this.pendingReject = null
          }
        })

        // 初始化流程
        log.debug('[FileManager] Starting shell initialization...')
        this.initializeShell(stream, resolve, reject)
      })
    })
  }

  /**
   * 初始化 shell（和终端一样，不等待）
   */
  private async initializeShell(
    stream: ClientChannel,
    resolve: () => void,
    reject: (error: Error) => void
  ): Promise<void> {
    // 一次性发送所有进入命令
    if (this.shellEnterCommands && this.shellEnterCommands.length > 0) {
      log.debug(`[FileManager] Entering shell with commands: ${this.shellEnterCommands.join(', ')}`)
      for (const cmd of this.shellEnterCommands) {
        log.debug(`[FileManager] Sending shell enter command: "${cmd}"`)
        stream.write(`${cmd}\n`)
      }
    }

    // 发送回车触发提示符
    stream.write('\n')

    // 直接标记为已准备好（和终端一样，不等待）
    log.debug('[FileManager] Shell initialized')
    this.shellReady = true
    this.outputBuffer = ''
    resolve()
  }

  /**
   * 检查输出中是否有当前命令的 marker
   * 改进版本：确保匹配的是真正的输出 marker，而不是命令回显中的文本
   */
  private checkForMarker(): void {
    // 只检查当前命令的 marker
    if (!this.currentMarker) {
      return
    }

    // 查找当前 marker - 需要确保是独立的 marker 行（前面有换行符）
    // 真正的 marker 输出格式: "\n__MARKER_xxx__\n" 或在行首
    // 命令回显中的 marker 是: "echo "__MARKER_xxx__"" 不应该匹配

    // 先检查是否有完整的 marker 行（以换行符开头，或 buffer 开头）
    const markerPattern = new RegExp(`\\n${this.currentMarker}\\s*\\n|^${this.currentMarker}\\s*\\n`)
    const match = this.outputBuffer.match(markerPattern)

    if (!match) {
      // 也检查 marker 后面有提示符（某些设备 marker 后直接是提示符）
      const markerWithPrompt = this.outputBuffer.indexOf(`\n${this.currentMarker}`)
      if (markerWithPrompt === -1) {
        return
      }
      // 检查 marker 后是否足够内容（至少有换行或提示符）
      const afterMarker = this.outputBuffer.substring(markerWithPrompt + this.currentMarker.length + 1)
      if (afterMarker.length < 2) {
        return
      }
      // 使用这个位置
      this.processMarkerOutput(markerWithPrompt + 1)
      return
    }

    // 找到完整的 marker 行
    const markerIndex = match.index! + (match[0].startsWith('\n') ? 1 : 0)
    this.processMarkerOutput(markerIndex)
  }

  /**
   * 处理 marker 输出
   * 改进版本：更彻底地清理 buffer，避免残留影响后续命令
   */
  private processMarkerOutput(markerIndex: number): void {
    if (!this.pendingResolve) {
      // 完全清空 buffer
      this.outputBuffer = ''
      this.currentMarker = null
      return
    }

    // 提取从 buffer 开始到 marker 的内容
    const output = this.outputBuffer.substring(0, markerIndex)

    // 彻底清空 buffer - 找到 marker 后的所有内容并清理
    const afterMarker = this.outputBuffer.substring(markerIndex + this.currentMarker!.length)

    // 找到提示符位置（通常是 ]# 或 # 后的换行）
    // 清理掉 marker 后的提示符和换行
    let cleanupIndex = 0
    for (let i = 0; i < afterMarker.length; i++) {
      // 找到提示符后的换行符
      if (afterMarker[i] === '\n') {
        cleanupIndex = i + 1
        // 继续查找，可能有多行提示符
        const remaining = afterMarker.substring(cleanupIndex)
        if (remaining.trim() && !remaining.startsWith('\n')) {
          // 有实质内容，停止清理
          break
        }
      }
    }

    // 如果找到清理边界，保留之后的内容；否则完全清空
    if (cleanupIndex > 0 && cleanupIndex < afterMarker.length) {
      this.outputBuffer = afterMarker.substring(cleanupIndex)
    } else {
      this.outputBuffer = ''
    }

    // 清理输出（根据 rawMode 决定是否过滤）
    let cleanOutput: string
    if (this.rawMode) {
      // 原始模式：只去掉控制字符和 marker，不做行过滤
      cleanOutput = output
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
        .trim()
      this.rawMode = false  // 重置标志
    } else {
      cleanOutput = this.cleanShellOutput(output)
    }

    // resolve 等待中的 promise
    const resolve = this.pendingResolve
    this.pendingResolve = null
    this.pendingReject = null
    this.currentMarker = null

    if (resolve) {
      resolve(cleanOutput)
    }

    // 处理下一个命令
    this.processNextCommand()
  }

  /**
   * 处理下一个命令
   */
  private processNextCommand(): void {
    if (this.commandQueue.length === 0) {
      this.isProcessing = false
      return
    }

    this.isProcessing = true
    const item = this.commandQueue.shift()!
    const { command, resolve, reject, rawMode } = item

    if (!this.shellChannel) {
      reject(new Error('Shell channel not available'))
      this.processNextCommand()
      return
    }

    // 设置 rawMode 标志
    this.rawMode = rawMode || false

    // 使用 UUID 生成独特的 marker，避免与命令回显混淆
    const marker = `${this.markerPrefix}${uuidv4()}___`

    // 重要：先清空 buffer，再设置 marker 和 pendingResolve
    // 防止旧数据触发 checkForMarker 时误判
    this.outputBuffer = ''
    this.currentMarker = marker
    this.pendingResolve = resolve
    this.pendingReject = reject

    this.shellChannel.write(`${command}; echo '${marker}'\n`)
  }

  /**
   * 执行命令（使用持久化 channel）
   * 改进版本：添加超时恢复机制，避免队列阻塞
   */
  private async execShellCommand(command: string, timeout = 30000): Promise<string> {
    // 确保 shell channel 已初始化
    await this.initShellChannel()

    return new Promise((resolve, reject) => {
      // 设置超时
      const timer = setTimeout(() => {
        log.warn(`Command timeout: "${command}" after ${timeout}ms`)

        // 超时恢复：重置状态
        this.currentMarker = null
        this.pendingResolve = null
        this.pendingReject = null
        this.outputBuffer = ''
        this.isProcessing = false

        // 尝试重新初始化 shell channel
        if (this.shellChannel) {
          this.shellChannel.write('\x03')  // Ctrl+C
          this.shellChannel.write('\n')    // 回车
        }

        // 清空队列中所有等待的命令，全部 reject
        while (this.commandQueue.length > 0) {
          const item = this.commandQueue.shift()!
          item.reject(new Error(`Command timeout (queue cleared)`))
        }

        reject(new Error(`Command timeout after ${timeout}ms`))
      }, timeout)

      // 添加到队列
      this.commandQueue.push({
        command,
        resolve: (output) => {
          clearTimeout(timer)
          resolve(output)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })

      // 如果没有正在处理的命令，开始处理
      if (!this.isProcessing) {
        this.processNextCommand()
      }
    })
  }

  /**
   * 重置 shell 状态（用于错误恢复）
   */
  private resetShellState(): void {
    this.currentMarker = null
    this.pendingResolve = null
    this.pendingReject = null
    this.outputBuffer = ''
    this.isProcessing = false
    this.commandQueue = []
  }

  /**
   * 安全引用路径（处理特殊字符）
   */
  private quotePath(filePath: string): string {
    // 使用单引号包裹，内部单引号用 '"'"' 转义
    if (filePath.includes("'")) {
      return `'${filePath.replace(/'/g, "'\"'\"'")}'`
    }
    return `'${filePath}'`
  }

  /**
   * 测试连接是否可用
   */
  async testConnection(): Promise<boolean> {
    try {
      // 执行一个简单的命令测试连接
      const result = await this.execShellCommand('echo CONNECTION_TEST_OK')
      log.info(`Exec test passed for session: ${this.sessionId}, result: ${result.trim()}`)
      return result.includes('CONNECTION_TEST_OK')
    } catch (error) {
      log.error(`Exec test error: ${error}`)
      return false
    }
  }

  /**
   * 预启动 Python Agent（在连接建立后立即启动，不阻塞）
   */
  async preStartAgent(): Promise<void> {
    log.info(`Pre-starting Python agent for session: ${this.sessionId}`)

    // 等待 shell 稳定后再上传（延迟 1 秒，减少等待时间）
    await new Promise(resolve => setTimeout(resolve, 1000))

    try {
      // 只上传脚本，不启动 agent 进程
      await this.uploadAgentScript()
      log.info(`Agent script uploaded (pre-start)`)
    } catch (error) {
      log.warn(`Pre-start agent failed: ${error}`)
      throw error
    }
  }

  /**
   * 仅上传 agent 脚本（不启动）
   */
  private async uploadAgentScript(): Promise<void> {
    // 确保 shell channel 已初始化
    await this.initShellChannel()

    // 分块上传脚本
    const scriptContent = Buffer.from(PYTHON_AGENT_SCRIPT)
    const scriptBase64 = scriptContent.toString('base64')
    const chunkSize = 800

    log.info(`Uploading agent script (${scriptBase64.length} bytes base64)`)

    // 清空临时文件
    await this.execShellCommand(`rm -f ${this.agentPath}.b64 ${this.agentPath}`)

    // 分块上传
    for (let i = 0; i < scriptBase64.length; i += chunkSize) {
      const chunk = scriptBase64.substring(i, Math.min(i + chunkSize, scriptBase64.length))
      await this.execShellCommand(`printf '%s' '${chunk}' >> ${this.agentPath}.b64`)
    }

    // 解码
    await this.execShellCommand(`base64 -d ${this.agentPath}.b64 > ${this.agentPath} && rm -f ${this.agentPath}.b64`)

    // 验证
    const verify = await this.execShellCommand(`ls ${this.agentPath} 2>/dev/null || echo NOT_FOUND`)
    if (verify.includes('NOT_FOUND')) {
      throw new Error('Script upload failed')
    }

    log.info(`Agent script uploaded to ${this.agentPath}`)
  }

  /**
   * 清理 shell 输出（去掉命令回显、控制字符等）
   * 改进版本：保留更多有效格式，减少误删
   */
  private cleanShellOutput(output: string): string {
    // 去掉 ANSI 控制字符
    let cleaned = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // 去掉其他控制字符（保留换行）
    cleaned = cleaned.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    // 去掉 [DATA] 这样的日志前缀（如果有）
    cleaned = cleaned.replace(/\[DATA\]/g, '')

    // 分行处理
    const lines = cleaned.split('\n')
    const resultLines: string[] = []

    for (const line of lines) {
      const trimmed = line.trim()

      // 跳过空行
      if (!trimmed) continue

      // 跳过 marker 行（使用新的 UUID 格式）
      if (trimmed.includes('END_MARKER_UUID')) continue

      // 跳过 marker 残留（部分 marker 文本，可能格式不完整）
      // marker 格式: ___END_MARKER_UUID_xxxxx-xxxx-xxxx___ 或 _END_MARKER_UUID_xxxxx
      if (trimmed.match(/[a-f0-9]{8}[-_][a-f0-9]{4}[-_][a-f0-9]{4}/) ||
          trimmed.match(/END_MARKER_UUID/i) ||
          trimmed.endsWith("___'") ||
          trimmed.match(/_[a-f0-9]{8}/)) continue

      // 跳过提示符行（包含 ]# 或 # 或 $）
      if (trimmed.match(/\[.*\]#/) || trimmed.match(/^#\s*$/) || trimmed.match(/^\$\s*$/)) continue

      // 跳过命令回显（包含 ls -la 或 echo 或 pwd）
      if (trimmed.includes('ls -la') || trimmed.includes('echo') || trimmed.includes('pwd')) continue

      // 跳过 Password: 等交互提示
      if (trimmed.includes('Password:') || trimmed.includes('password:')) continue

      // 跳过 exit 相关
      if (trimmed.toLowerCase().includes('exit')) continue

      // 跳过错误提示（如 "No such file or directory"）但不跳过文件列表
      if (trimmed.includes('No such file') || trimmed.includes('cannot access')) {
        continue
      }

      // 保留 Python 测试标记
      if (trimmed.includes('___PYTHON_TEST_OK___')) {
        resultLines.push(trimmed)
        continue
      }

      // 保留路径行（以 / 开头，用于 pwd 命令）
      if (trimmed.startsWith('/')) {
        resultLines.push(trimmed)
        continue
      }

      // 保留可能的文件列表行
      // 必须以权限字符开头：d, -, l（文件/目录/链接）
      // 或者 total 行（ls 输出的汇总行）
      if (trimmed.match(/^[d\-l][rwx\-stST]{9}/) || trimmed.startsWith('total ')) {
        resultLines.push(trimmed)
      }
    }

    return resultLines.join('\n')
  }

  /**
   * 列出目录内容
   * 使用 ls -la 命令
   */
  async listDir(dirPath: string): Promise<FileInfo[]> {
    // 如果是相对路径，先获取绝对路径
    let absolutePath = dirPath
    if (dirPath === '.' || dirPath.startsWith('./') || !dirPath.startsWith('/')) {
      try {
        const pwdOutput = await this.execShellCommand('pwd')
        absolutePath = pwdOutput.trim()
        log.debug(`Resolved relative path '${dirPath}' to '${absolutePath}'`)
      } catch (e) {
        log.warn(`Failed to get pwd, using '${dirPath}' as is`)
      }
    }

    const command = `ls -la ${this.quotePath(absolutePath)}`
    log.debug(`Exec listDir command: ${command}`)

    const output = await this.execShellCommand(command)

    const lines = output.split('\n').filter(line => line.trim())
    const files: FileInfo[] = []

    // 跳过第一行（total xxx）
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      const parsed = this.parseLsLine(line, absolutePath)
      if (parsed) {
        files.push(parsed)
      }
    }

    log.info(`Exec listed ${files.length} items in ${absolutePath}`)
    return files
  }

  /**
   * 解析 ls -la 输出的每一行
   * 支持多种格式：标准 Linux、嵌入式简化格式、ACL 扩展权限
   */
  private parseLsLine(line: string, dirPath: string): FileInfo | null {
    // ls -la 输出格式示例:
    // 标准格式: drwxr-xr-x  2 user group 4096 Jan  1 12:00 dirname
    // 简化格式: drwxr-xr-x  2 user group  4096 Jan  1 12:00 dirname
    // 嵌入式:   drwxr-xr-x   1      4096 Jan  1 12:00 dirname
    // ACL:      drwxr-xr-x+  2 user group 4096 Jan  1 12:00 dirname

    const trimmed = line.trim()
    if (!trimmed) return null

    // 使用正则表达式匹配，更灵活
    // 格式: 权限 链接数 [用户] [组] 大小 日期 时间/年份 文件名
    const regex = /^([d\-l][rwx\-stST]{9}[+\.]?)\s+(\d+)\s+(\S+)?\s+(\S+)?\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.+)$/
    const match = trimmed.match(regex)

    if (match) {
      const permissions = match[1]
      const isDir = permissions.startsWith('d')
      const size = parseInt(match[5], 10) || 0
      const name = match[9].trim()

      // 跳过 . 和 ..
      if (name === '.' || name === '..') return null

      // 解析日期
      const month = match[6]
      const day = match[7]
      const timeOrYear = match[8]

      let dateStr = `${month} ${day}`
      if (timeOrYear.includes(':')) {
        const currentYear = new Date().getFullYear()
        dateStr += ` ${currentYear} ${timeOrYear}`
      } else {
        dateStr += ` ${timeOrYear}`
      }

      const modifyTime = new Date(dateStr)

      return {
        name,
        path: path.posix.join(dirPath, name),
        isDir,
        size,
        modifyTime,
        permissions,
        owner: match[3] || '',
        group: match[4] || ''
      }
    }

    // 备用解析：处理更简化的格式（某些嵌入式设备）
    // 格式: 权限 [链接数] [大小] 日期 文件名
    const simpleRegex = /^([d\-l][rwx\-]{9})\s+(\d+)?\s*(\d+)?\s+(\S+)\s+(\d+)\s+(\S+)\s+(.+)$/
    const simpleMatch = trimmed.match(simpleRegex)

    if (simpleMatch) {
      const permissions = simpleMatch[1]
      const isDir = permissions.startsWith('d')
      const size = parseInt(simpleMatch[3] || simpleMatch[2] || '0', 10)
      const name = simpleMatch[7].trim()

      if (name === '.' || name === '..') return null

      return {
        name,
        path: path.posix.join(dirPath, name),
        isDir,
        size,
        modifyTime: new Date(),
        permissions,
        owner: '',
        group: ''
      }
    }

    // 无法解析，记录日志
    log.warn(`Failed to parse ls line: "${trimmed}"`)
    return null
  }

  /**
   * 获取文件信息
   */
  async stat(filePath: string): Promise<FileInfo> {
    // 使用 ls -ld 获取文件信息
    const lsOutput = await this.execShellCommand(`ls -ld ${this.quotePath(filePath)}`)
    const parsed = this.parseLsLine(lsOutput, path.posix.dirname(filePath))

    if (!parsed) {
      throw new Error(`Failed to stat: ${filePath}`)
    }

    // 更新路径
    parsed.path = filePath
    return parsed
  }

  /**
   * 删除文件或目录
   */
  async delete(targetPath: string): Promise<void> {
    await this.execShellCommand(`rm -rf ${this.quotePath(targetPath)}`)
    log.info(`Exec deleted: ${targetPath}`)
  }

  /**
   * 重命名文件或目录
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.execShellCommand(`mv ${this.quotePath(oldPath)} ${this.quotePath(newPath)}`)
    log.info(`Exec renamed: ${oldPath} -> ${newPath}`)
  }

  /**
   * 创建目录
   */
  async mkdir(dirPath: string): Promise<void> {
    await this.execShellCommand(`mkdir -p ${this.quotePath(dirPath)}`)
    log.info(`Exec created directory: ${dirPath}`)
  }

  /**
   * 执行 shell 命令（公开方法，用于 MD5 计算等）
   */
  async exec(command: string): Promise<string> {
    return this.execShellCommand(command)
  }

  /**
   * 执行命令并返回原始输出（用于 MD5 计算，不做行过滤）
   */
  async execRaw(command: string, timeout = 30000): Promise<string> {
    log.debug(`[FileManager] execRaw called: "${command}", timeout: ${timeout}ms`)
    await this.initShellChannel()
    log.debug(`[FileManager] shell channel ready, executing command`)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        log.error(`[FileManager] execRaw timeout after ${timeout}ms for command: "${command}"`)
        this.currentMarker = null
        this.pendingResolve = null
        this.pendingReject = null
        this.outputBuffer = ''
        this.isProcessing = false
        this.rawMode = false
        if (this.shellChannel) {
          this.shellChannel.write('\x03')
          this.shellChannel.write('\n')
        }
        while (this.commandQueue.length > 0) {
          const item = this.commandQueue.shift()!
          item.reject(new Error(`Command timeout`))
        }
        reject(new Error(`Command timeout after ${timeout}ms`))
      }, timeout)

      // 添加到队列，设置 rawMode: true
      log.debug(`[FileManager] adding command to queue, rawMode: true`)
      this.commandQueue.push({
        command,
        rawMode: true,
        resolve: (output) => {
          clearTimeout(timer)
          log.debug(`[FileManager] execRaw success, output length: ${output.length}`)
          // 打印输出的前 200 字符
          if (output.length < 200) {
            log.debug(`[FileManager] execRaw output: "${output.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`)
          } else {
            log.debug(`[FileManager] execRaw output (first 200): "${output.substring(0, 200).replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`)
          }
          resolve(output)
        },
        reject: (error) => {
          clearTimeout(timer)
          log.error(`[FileManager] execRaw error: ${error.message}`)
          reject(error)
        }
      })

      if (!this.isProcessing) {
        log.debug(`[FileManager] starting to process command queue`)
        this.processNextCommand()
      } else {
        log.debug(`[FileManager] already processing, command queued`)
      }
    })
  }

  /**
   * 检测远程是否有 base64 命令
   */
  private async checkBase64Available(): Promise<boolean> {
    try {
      const result = await this.execShellCommand('which base64 || echo NOT_FOUND')
      return !result.includes('NOT_FOUND')
    } catch {
      return false
    }
  }

  // ========== Python Agent 方法 ==========

  /**
   * 检测远程是否有 Python
   */
  private async checkPythonAvailable(): Promise<boolean> {
    try {
      const result = await this.execShellCommand('python3 -c "print(1)" || python -c "print(1)"')
      return result.includes('1')
    } catch {
      return false
    }
  }

  /**
   * 启动 Python Agent
   */
  private async startPythonAgent(): Promise<void> {
    if (this.agentReady) {
      log.debug('Python agent already running')
      return
    }

    log.info('Starting Python agent...')

    // 检测 Python 是否可用
    const hasPython = await this.checkPythonAvailable()
    if (!hasPython) {
      log.warn('Python not available on remote system')
      throw new Error('Python not available')
    }

    // 检查脚本是否已存在
    const scriptCheck = await this.execShellCommand(`ls ${this.agentPath} 2>/dev/null || echo NOT_FOUND`)
    if (scriptCheck.includes('NOT_FOUND')) {
      // 脚本不存在，上传
      log.info('Agent script not found, uploading...')
      await this.uploadAgentScript()
    } else {
      log.info('Agent script already exists')
    }

    // 检测 Python 命令 - 使用特殊标记避免被过滤
    let pythonCmd: string | null = null

    // 直接测试 python3 是否能运行
    try {
      const test3 = await this.execShellCommand('python3 -c "print(\'___PYTHON_TEST_OK___\')" 2>/dev/null; echo ___PYTHON_TEST_OK___')
      if (test3.includes('___PYTHON_TEST_OK___')) {
        pythonCmd = 'python3'
      }
    } catch {}

    // 直接测试 python 是否能运行
    if (!pythonCmd) {
      try {
        const testPy = await this.execShellCommand('python -c "print(\'___PYTHON_TEST_OK___\')" 2>/dev/null; echo ___PYTHON_TEST_OK___')
        if (testPy.includes('___PYTHON_TEST_OK___')) {
          pythonCmd = 'python'
        }
      } catch {}
    }

    if (!pythonCmd) {
      throw new Error('Python not found on remote system')
    }

    log.info(`Using Python command: ${pythonCmd}`)

    // 获取 client
    const client = await this.getClient()

    // 启动 agent 进程（使用 shell 方式，保持持久化）
    return new Promise((resolve, reject) => {
      // 使用 shell 创建专用通道，增大窗口大小以提高吞吐量
      // windowSize: 接收窗口大小（默认 2MB，增大到 4MB）
      // packetSize: 单个数据包大小（默认 32KB，增大到 64KB）
      client.shell({
        window: { rows: 24, cols: 80, term: 'xterm' },
        // 不指定 windowSize/packetSize 会使用默认值，SSH2 默认值已经是比较优化的
      }, (err, stream) => {
        if (err) {
          log.error('Failed to create shell for Python agent:', err)
          reject(err)
          return
        }

        this.agentChannel = stream
        log.info('Dedicated shell channel created for Python agent')

        // 收集输出（包括 stderr）
        stream.on('data', (data: Buffer) => {
          this.agentBuffer = Buffer.concat([this.agentBuffer, data])
          // 仅在有有意义的内容时记录（跳过大块二进制数据）
          if (data.length < 200) {
            log.debug(`Agent data: ${data.length} bytes`)
          }
        })

        stream.stderr?.on('data', (data: Buffer) => {
          log.warn(`Agent stderr: ${data.toString()}`)
        })

        stream.on('close', () => {
          log.info('Python agent shell closed')
          this.agentChannel = null
          this.agentReady = false
          this.agentBuffer = Buffer.alloc(0)
        })

        // 先发送进入 shell 的命令（如果配置了）
        if (this.shellEnterCommands && this.shellEnterCommands.length > 0) {
          log.info('Entering shell for agent...')
          for (const cmd of this.shellEnterCommands) {
            stream.write(`${cmd}\n`)
          }
          stream.write('\n')
        }

        // 发送启动命令
        stream.write(`${pythonCmd} ${this.agentPath}\n`)
        log.info(`Sent agent start command: ${pythonCmd} ${this.agentPath}`)

        // 等待 agent 初始化并发送 ping 验证
        // IPS 设备需要更长时间，增加等待时间到 3 秒
        const waitTime = this.shellEnterCommands?.length ? this.shellEnterWait + 2000 : 2000
        setTimeout(async () => {
          try {
            // 检查 buffer 中是否有错误输出
            if (this.agentBuffer.length > 0) {
              log.debug(`Agent buffer before ping: ${this.agentBuffer.length} bytes`)
            }

            // 发送 ping 命令验证 agent 是否就绪（增加超时到 15 秒）
            log.debug('Sending ping to verify agent...')
            const pingResp = await this.pingAgentInternal(15000)

            if (pingResp && pingResp['status'] === 'ok') {
              this.agentReady = true
              log.info('Python agent ready (ping verified)')
              resolve()
            } else {
              log.error('Python agent ping failed, response:', pingResp)
              this.agentChannel = null
              this.agentReady = false
              reject(new Error('Agent ping failed'))
            }
          } catch (error) {
            log.error('Python agent startup verification failed:', error)
            this.agentChannel = null
            this.agentReady = false
            reject(error)
          }
        }, 1000)  // 增加等待时间到 1 秒
      })
    })
  }

  /**
   * 内部 ping 方法（启动验证用）- 使用文本协议
   */
  private async pingAgentInternal(timeout = 15000): Promise<object | null> {
    if (!this.agentChannel) return null

    // 使用 JSON 行文本协议（每行一个 JSON）
    const cmd = JSON.stringify({action: 'ping'}) + '\n'

    // 清空 buffer
    this.agentBuffer = Buffer.alloc(0)

    // 发送 ping
    this.agentChannel.write(cmd)

    // 等待响应
    try {
      return await this.recvAgentResponseText(timeout)
    } catch {
      return null
    }
  }

  /**
   * 接收 Agent 响应（文本协议 - JSON行）
   */
  private async recvAgentResponseText(timeout = 15000): Promise<object> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      // 查找换行符分隔的 JSON 行
      const bufferStr = this.agentBuffer.toString()
      const newlineIndex = bufferStr.indexOf('\n')

      if (newlineIndex !== -1) {
        const line = bufferStr.substring(0, newlineIndex).trim()
        this.agentBuffer = Buffer.from(bufferStr.substring(newlineIndex + 1))

        // 跳过空行和提示符
        if (!line || line.includes('>') || line.includes('#')) continue

        // 尝试解析 JSON
        try {
          const parsed = JSON.parse(line)

          // 跳过命令回显（包含 action 字段的请求）
          // 真正的响应应该包含 status 字段
          if (parsed['action'] && !parsed['status']) {
            continue
          }

          return parsed
        } catch {
          // 不是 JSON，继续查找下一行
          continue
        }
      }

      // 等待数据
      await new Promise(resolve => setImmediate(resolve))
    }

    throw new Error('Agent response timeout')
  }

  /**
   * 获取 Agent 状态
   * 可用于外部检查 agent 是否运行
   */
  getAgentStatus(): { ready: boolean; hasChannel: boolean } {
    return {
      ready: this.agentReady,
      hasChannel: this.agentChannel !== null
    }
  }

  /**
   * 检查远程 agent 进程是否存在（通过 shell 命令）
   */
  async checkRemoteAgentProcess(): Promise<boolean> {
    try {
      const result = await this.execShellCommand(`ps aux | grep -v grep | grep lyshell_agent || echo NOT_FOUND`)
      return !result.includes('NOT_FOUND')
    } catch {
      return false
    }
  }

  /**
   * 发送命令到 Agent（文本协议）
   */
  private async sendAgentCommand(cmd: object): Promise<object> {
    if (!this.agentChannel || !this.agentReady) {
      await this.startPythonAgent()
    }

    // 使用 JSON 行文本协议
    const cmdStr = JSON.stringify(cmd) + '\n'

    // 清空 buffer
    this.agentBuffer = Buffer.alloc(0)

    // 发送命令
    this.agentChannel.write(cmdStr)

    // 等待响应
    return this.recvAgentResponseText()
  }

  /**
   * 接收 Agent 响应（二进制协议 - 旧方法）
   */
  private async recvAgentResponse(timeout = 30000): Promise<object> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      // 检查是否有完整的响应（至少 4 字节长度 + 数据）
      if (this.agentBuffer.length >= 4) {
        const length = this.agentBuffer.readUInt32BE(0)
        if (this.agentBuffer.length >= 4 + length) {
          const data = this.agentBuffer.subarray(4, 4 + length)
          // 移除已处理的数据
          this.agentBuffer = this.agentBuffer.subarray(4 + length)
          return JSON.parse(data.toString('utf-8'))
        }
      }

      // 等待数据
      await new Promise(resolve => setImmediate(resolve))
    }

    throw new Error('Agent response timeout')
  }

  /**
   * 接收 Agent 二进制数据
   */
  private async recvAgentBinary(timeout = 60000): Promise<Buffer> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      if (this.agentBuffer.length >= 4) {
        const length = this.agentBuffer.readUInt32BE(0)
        if (this.agentBuffer.length >= 4 + length) {
          const data = this.agentBuffer.subarray(4, 4 + length)
          this.agentBuffer = this.agentBuffer.subarray(4 + length)
          return data
        }
      }

      await new Promise(resolve => setTimeout(resolve, 10))  // 10ms polling for faster response
    }

    throw new Error('Agent binary data timeout')
  }

  /**
   * 使用 Agent 上传文件（高效二进制传输）
   */
  async uploadWithAgent(
    localPath: string,
    remotePath: string,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<void> {
    const taskId = uuidv4()

    // 读取本地文件
    const content = await fs.promises.readFile(localPath)
    const fileSize = content.length

    log.info(`Agent upload: ${localPath} -> ${remotePath} (${fileSize} bytes)`)

    // 发送上传命令
    const cmdResp = await this.sendAgentCommand({
      action: 'upload',
      path: remotePath,
      size: fileSize
    })

    if (cmdResp['status'] === 'error') {
      throw new Error(cmdResp['message'] || 'Upload command failed')
    }

    // 分块发送二进制数据（base64 编码）
    const chunkSize = 262144  // 256KB (base64后约350KB)
    let transferred = 0

    // 速度计算：使用滑动窗口（最近3次采样）
    const speedSamples: { bytes: number; time: number }[] = []
    const SAMPLE_INTERVAL = 500  // 500ms 采样间隔（降低更新频率）
    let lastSampleTime = Date.now()
    let lastSampleBytes = 0

    while (transferred < fileSize) {
      const chunk = content.subarray(transferred, Math.min(transferred + chunkSize, fileSize))
      // base64 编码后发送
      const base64Chunk = chunk.toString('base64') + '\n'

      this.agentBuffer = Buffer.alloc(0)
      this.agentChannel.write(base64Chunk)

      // 等待进度响应
      const progressResp = await this.recvAgentResponseText()
      transferred += chunk.length

      // 定期采样计算速度
      const now = Date.now()
      const elapsed = now - lastSampleTime
      if (elapsed >= SAMPLE_INTERVAL || transferred === fileSize) {
        const bytesDiff = transferred - lastSampleBytes

        speedSamples.push({ bytes: bytesDiff, time: elapsed })
        if (speedSamples.length > 3) {
          speedSamples.shift()
        }

        const totalBytes = speedSamples.reduce((sum, s) => sum + s.bytes, 0)
        const totalTime = speedSamples.reduce((sum, s) => sum + s.time, 0)
        const speed = Math.round(totalBytes / (totalTime / 1000))

        const progress: TransferProgress = {
          taskId,
          sessionId: this.sessionId,
          transferredSize: transferred,
          fileSize,
          progress: Math.round((transferred / fileSize) * 100),
          speed
        }

        if (onProgress) {
          onProgress(progress)
        }
        this.emitProgress(progress)

        lastSampleTime = now
        lastSampleBytes = transferred
      }
    }

    // 等待完成响应
    const finalResp = await this.recvAgentResponseText()
    if (finalResp['status'] !== 'ok') {
      throw new Error(finalResp['message'] || 'Upload failed')
    }

    // 发送完成进度 (100%)
    const completedProgress: TransferProgress = {
      taskId,
      sessionId: this.sessionId,
      transferredSize: fileSize,
      fileSize,
      progress: 100,
      speed: 0
    }
    if (onProgress) {
      onProgress(completedProgress)
    }
    this.emitProgress(completedProgress)

    log.info(`Agent upload completed: ${remotePath}`)
  }

  /**
   * 使用 Agent 下载文件（高效二进制传输）
   */
  async downloadWithAgent(
    remotePath: string,
    localPath: string,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<void> {
    const taskId = uuidv4()

    // 发送下载命令
    const cmdResp = await this.sendAgentCommand({
      action: 'download',
      path: remotePath
    })

    if (cmdResp['status'] === 'error') {
      throw new Error(cmdResp['message'] || 'Download command failed')
    }

    const fileSize = cmdResp['size'] as number
    log.info(`Agent download: ${remotePath} -> ${localPath} (${fileSize} bytes)`)

    // 确保本地目录存在
    const localDir = path.dirname(localPath)
    await fs.promises.mkdir(localDir, { recursive: true })

    // 流式写入文件，避免内存堆积
    const writeStream = fs.createWriteStream(localPath)
    let transferred = 0

    // 速度计算：使用滑动窗口（最近3次采样）
    const speedSamples: { bytes: number; time: number }[] = []
    const SAMPLE_INTERVAL = 500  // 500ms 采样间隔
    let lastSampleTime = Date.now()
    let lastSampleBytes = 0

    try {
      while (transferred < fileSize) {
        const chunk = await this.recvAgentBinaryText(60000)
        writeStream.write(chunk)
        transferred += chunk.length

        // 定期采样计算速度
        const now = Date.now()
        const elapsed = now - lastSampleTime
        if (elapsed >= SAMPLE_INTERVAL || transferred === fileSize) {
          const bytesDiff = transferred - lastSampleBytes

          // 添加采样
          speedSamples.push({ bytes: bytesDiff, time: elapsed })
          // 只保留最近3次采样
          if (speedSamples.length > 3) {
            speedSamples.shift()
          }

          // 计算平均速度（滑动窗口）
          const totalBytes = speedSamples.reduce((sum, s) => sum + s.bytes, 0)
          const totalTime = speedSamples.reduce((sum, s) => sum + s.time, 0)
          const speed = Math.round(totalBytes / (totalTime / 1000))

          const progress: TransferProgress = {
            taskId,
            sessionId: this.sessionId,
            transferredSize: transferred,
            fileSize,
            progress: Math.round((transferred / fileSize) * 100),
            speed
          }

          if (onProgress) {
            onProgress(progress)
          }
          this.emitProgress(progress)

          lastSampleTime = now
          lastSampleBytes = transferred
        }
      }

      // 等待完成响应
      const finalResp = await this.recvAgentResponseText()
      if (finalResp['status'] !== 'ok') {
        throw new Error(finalResp['message'] || 'Download failed')
      }

    } finally {
      writeStream.end()
    }

    // 发送完成进度 (100%)
    const completedProgress: TransferProgress = {
      taskId,
      sessionId: this.sessionId,
      transferredSize: fileSize,
      fileSize,
      progress: 100,
      speed: 0
    }
    if (onProgress) {
      onProgress(completedProgress)
    }
    this.emitProgress(completedProgress)

    log.info(`Agent download completed: ${localPath}`)
  }

  /**
   * 接收 Agent base64 编码的二进制数据（文本协议）
   */
  private async recvAgentBinaryText(timeout = 60000): Promise<Buffer> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      const bufferStr = this.agentBuffer.toString()
      const newlineIndex = bufferStr.indexOf('\n')

      if (newlineIndex !== -1) {
        const line = bufferStr.substring(0, newlineIndex).trim()
        this.agentBuffer = Buffer.from(bufferStr.substring(newlineIndex + 1))

        // 跳过空行和提示符
        if (!line || line.includes('>') || line.includes('#')) continue

        // 尝试 base64 解码
        try {
          return Buffer.from(line, 'base64')
        } catch {
          // 可能是 JSON 响应，不是数据
          continue
        }
      }

      // 使用 setImmediate 让出控制权，避免阻塞事件循环
      await new Promise(resolve => setImmediate(resolve))
    }

    throw new Error('Agent binary data timeout')
  }

  /**
   * 智能 upload：优先使用 Agent，失败回退到 base64
   */
  async upload(
    localPath: string,
    remotePath: string,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<void> {
    // 尝试使用 Agent
    try {
      if (!this.agentReady) {
        await this.startPythonAgent()
      }
      await this.uploadWithAgent(localPath, remotePath, onProgress)
      return
    } catch (error) {
      log.warn('Agent upload failed, falling back to base64:', error)
      this.agentReady = false
    }

    // 回退到 base64 方式
    await this.uploadWithBase64(localPath, remotePath, onProgress)
  }

  /**
   * 智能 download：优先使用 Agent，大文件失败回退到 base64
   */
  async download(
    remotePath: string,
    localPath: string,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<void> {
    // 先获取文件大小
    const fileInfo = await this.stat(remotePath)
    const fileSize = fileInfo.size
    const MAX_BASE64_SIZE = 5 * 1024 * 1024  // 5MB

    // 尝试使用 Agent
    try {
      if (!this.agentReady) {
        await this.startPythonAgent()
      }
      await this.downloadWithAgent(remotePath, localPath, onProgress)
      return
    } catch (error) {
      log.warn('Agent download failed:', error)
      this.agentReady = false
    }

    // 大文件不使用 base64 回退，直接失败
    if (fileSize > MAX_BASE64_SIZE) {
      throw new Error(`File too large (${Math.round(fileSize / 1024 / 1024)}MB) for fallback download. Agent required for files > 5MB.`)
    }

    // 小文件回退到 base64 方式（传入已知 fileSize 避免重复 stat）
    await this.downloadWithBase64(remotePath, localPath, onProgress, fileSize)
  }

  /**
   * Base64 方式 upload（原有实现，作为备选）
   */
  private async uploadWithBase64(
    localPath: string,
    remotePath: string,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<void> {
    // 检测 base64 是否可用
    const hasBase64 = await this.checkBase64Available()
    if (!hasBase64) {
      throw new Error('Remote system does not have base64 command. Upload not supported.')
    }

    // 读取本地文件
    const localContent = await fs.promises.readFile(localPath)
    const fileSize = localContent.length
    const taskId = uuidv4()

    log.info(`Base64 upload: ${localPath} -> ${remotePath} (${fileSize} bytes)`)

    // Base64 编码
    const base64Content = localContent.toString('base64')

    // 分块大小：32KB base64 数据
    const chunkSize = 32768
    const totalChunks = Math.ceil(base64Content.length / chunkSize)

    // 创建临时文件
    const tmpFile = `/tmp/upload_${uuidv4().replace(/-/g, '')}.b64`

    for (let i = 0; i < totalChunks; i++) {
      const chunk = base64Content.substring(i * chunkSize, (i + 1) * chunkSize)
      const escapedChunk = chunk.replace(/'/g, "'\\''")

      await this.execShellCommand(`printf '%s' '${escapedChunk}' >> ${tmpFile}`, 60000)

      const transferred = Math.min((i + 1) * chunkSize, base64Content.length)
      const progress: TransferProgress = {
        taskId,
        sessionId: this.sessionId,
        transferredSize: Math.round(transferred * 3 / 4),
        fileSize,
        progress: Math.round((transferred / base64Content.length) * 100),
        speed: 0
      }

      if (onProgress) {
        onProgress(progress)
      }
      this.emitProgress(progress)
    }

    await this.execShellCommand(`base64 -d ${tmpFile} > ${this.quotePath(remotePath)} && rm ${tmpFile}`)
    log.info(`Base64 upload completed: ${remotePath}`)
  }

  /**
   * Base64 方式 download（小文件备选方案，<=5MB）
   */
  private async downloadWithBase64(
    remotePath: string,
    localPath: string,
    onProgress?: (progress: TransferProgress) => void,
    knownFileSize?: number
  ): Promise<void> {
    const hasBase64 = await this.checkBase64Available()
    if (!hasBase64) {
      throw new Error('Remote system does not have base64 command. Download not supported.')
    }

    const taskId = uuidv4()
    const fileSize = knownFileSize || (await this.stat(remotePath)).size

    // 再次检查大小限制
    if (fileSize > 5 * 1024 * 1024) {
      throw new Error(`File too large for base64 download: ${Math.round(fileSize / 1024 / 1024)}MB`)
    }

    log.info(`Base64 download: ${remotePath} -> ${localPath} (${fileSize} bytes)`)

    const localDir = path.dirname(localPath)
    await fs.promises.mkdir(localDir, { recursive: true })

    // 报告开始进度
    const startProgress: TransferProgress = {
      taskId,
      sessionId: this.sessionId,
      transferredSize: 0,
      fileSize,
      progress: 0,
      speed: 0
    }
    if (onProgress) {
      onProgress(startProgress)
    }
    this.emitProgress(startProgress)

    // 计算超时时间：基础60秒 + 每MB额外30秒
    const timeoutMs = 60000 + Math.ceil(fileSize / 1024 / 1024) * 30000
    log.debug(`Base64 download timeout: ${timeoutMs}ms for ${fileSize} bytes`)

    const base64Output = await this.execShellCommand(`base64 ${this.quotePath(remotePath)}`, timeoutMs)
    const cleanBase64 = base64Output.replace(/[\s\r\n]/g, '')

    const decodedContent = Buffer.from(cleanBase64, 'base64')
    await fs.promises.writeFile(localPath, decodedContent)

    const progress: TransferProgress = {
      taskId,
      sessionId: this.sessionId,
      transferredSize: fileSize,
      fileSize,
      progress: 100,
      speed: 0
    }

    if (onProgress) {
      onProgress(progress)
    }
    this.emitProgress(progress)

    log.info(`Base64 download completed: ${localPath}`)
  }

  /**
   * 停止 Python Agent
   * 在断开连接时调用，确保远程进程退出
   */
  async stopAgent(): Promise<void> {
    if (!this.agentChannel || !this.agentReady) {
      return
    }

    try {
      // 发送 exit 命令
      const data = Buffer.from(JSON.stringify({action: 'exit'}), 'utf-8')
      const header = Buffer.alloc(4)
      header.writeUInt32BE(data.length, 0)

      this.agentChannel.write(header)
      this.agentChannel.write(data)

      // 等待响应（短暂等待）
      await new Promise(resolve => setTimeout(resolve, 200))

      log.info('Python agent stopped')
    } catch (error) {
      log.warn('Failed to stop agent gracefully:', error)
    }

    // 关闭 channel
    if (this.agentChannel) {
      this.agentChannel.close()
      this.agentChannel = null
    }

    this.agentReady = false
    this.agentBuffer = Buffer.alloc(0)
  }

  /**
   * 发送心跳到 Agent
   * 用于保持连接活跃，防止空闲超时退出
   */
  async pingAgent(): Promise<boolean> {
    if (!this.agentChannel || !this.agentReady) {
      return false
    }

    try {
      const resp = await this.sendAgentCommand({action: 'ping'})
      return resp['status'] === 'ok' && resp['pong'] === true
    } catch {
      return false
    }
  }

  /**
   * 清理资源
   * 在会话断开时调用
   */
  async cleanup(): Promise<void> {
    // 停止 agent
    await this.stopAgent()

    // 清理 shell channel
    if (this.shellChannel) {
      this.shellChannel.close()
      this.shellChannel = null
    }

    this.resetShellState()
    log.info(`ExecFileConnector cleanup completed for session ${this.sessionId}`)
  }

}