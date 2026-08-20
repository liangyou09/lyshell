/**
 * 上传 Worker - 在独立线程中执行文件上传
 * 使用 TCP 反向连接方式，和下载模式一致
 */
import { parentPort, workerData } from 'worker_threads'
import { Client } from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { redactSecrets } from './redact'

// 类型定义
type SSHClientChannel = any
type SSHConnectConfig = any

// Worker 接收的任务数据
interface UploadTaskData {
  taskId: string
  sessionId: string
  method: 'sftp' | 'exec'  // 上传方式
  sshConfig: {
    host: string
    port: number
    username: string
    password?: string
    privateKey?: string
    passphrase?: string
    readyTimeout?: number
    keepaliveInterval?: number
    shellEnterCommands?: string
    shellEnterWait?: number
  }
  localPath: string   // 本地文件路径
  remotePath: string  // 远程目标路径
  fileSize: number
}

// 进度消息
interface ProgressMessage {
  type: 'progress'
  taskId: string
  sessionId: string
  progress: number
  transferredSize: number
  fileSize: number
  speed: number
}

// 完成消息
interface CompleteMessage {
  type: 'complete'
  taskId: string
  sessionId: string
  transferredSize: number
}

// 错误消息
interface ErrorMessage {
  type: 'error'
  taskId: string
  sessionId: string
  error: string
}

// 日志消息
interface LogMessage {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
}

type WorkerMessage = ProgressMessage | CompleteMessage | ErrorMessage | LogMessage

// 发送消息到主进程
function sendMessage(msg: WorkerMessage) {
  if (parentPort) {
    parentPort.postMessage(msg)
  }
}

// 日志函数（经 redactSecrets 闸口脱敏，确保一次性握手 token 不落盘）
function log(level: 'info' | 'warn' | 'error', message: string) {
  sendMessage({ type: 'log', level, message: redactSecrets(message) })
}

// 递归创建远程目录（mkdir -p 等价），与 sftp.ts 的 sftpMkdirP 行为一致。
// worker 不引入 SFTPWrapper 类型，按 any 处理（与 SSHClientChannel 同策略）。
async function sftpMkdirP(sftp: any, remoteDir: string): Promise<void> {
  const norm = remoteDir.replace(/\/+/g, '/').replace(/\/$/, '')
  if (!norm || norm === '/' || norm === '.') return
  const parts = norm.split('/').filter(Boolean)
  let cur = norm.startsWith('/') ? '' : '.'
  for (const part of parts) {
    cur = cur === '' ? `/${part}` : cur === '.' ? part : `${cur}/${part}`
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(cur, (err: any) => {
        if (!err) return resolve()
        const code = err?.code
        if (code !== 4 && !/exist|failure/i.test(err?.message || '')) return reject(err)
        sftp.stat(cur, (statErr: any, attrs: any) => {
          if (!statErr && attrs?.isDirectory()) return resolve()
          reject(err)
        })
      })
    })
  }
}

// 执行上传
async function executeUpload(task: UploadTaskData) {
  const { taskId, sessionId, method, sshConfig, localPath, remotePath, fileSize } = task

  log('info', `Worker starting upload (${method}): ${localPath} -> ${remotePath} (${fileSize} bytes)`)

  // 检查本地文件是否存在
  if (!fs.existsSync(localPath)) {
    sendMessage({ type: 'error', taskId, sessionId, error: 'Local file not found' })
    // 抛错走 .catch exit(1)，不走成功 return（否则入口 .then 会 exit(0)，错误却以成功码退出）
    throw new Error('Local file not found')
  }

  // 建立 SSH 连接
  const client = new Client()

  return new Promise<void>((resolve, reject) => {
    let startTime = Date.now()

    // 连接配置
    const connectionConfig: SSHConnectConfig = {
      host: sshConfig.host,
      port: sshConfig.port,
      username: sshConfig.username,
      readyTimeout: sshConfig.readyTimeout || 30000,
      keepaliveInterval: sshConfig.keepaliveInterval || 10000,
      keepaliveCountMax: 3,
    }

    log('info', `Connecting to ${sshConfig.host}:${sshConfig.port} as ${sshConfig.username}`)

    // 认证方式
    if (sshConfig.password) {
      connectionConfig.password = sshConfig.password
      log('info', 'Using password authentication')
    } else if (sshConfig.privateKey) {
      connectionConfig.privateKey = sshConfig.privateKey
      if (sshConfig.passphrase) {
        connectionConfig.passphrase = sshConfig.passphrase
      }
      log('info', 'Using privateKey authentication')
    }

    // 连接错误
    client.on('error', (err) => {
      const errMsg = err.message?.split('\n')[0] || err.toString()
      log('error', `SSH connection error: ${errMsg}`)
      sendMessage({ type: 'error', taskId, sessionId, error: errMsg })
      reject(err)
    })

    // 连接就绪
    client.on('ready', () => {
      log('info', `SSH connection ready`)
      startTime = Date.now()

      if (method === 'sftp') {
        uploadViaSFTP(client, task, startTime, resolve, reject)
      } else {
        uploadViaExecPython(client, task, startTime, resolve, reject)
      }
    })

    // 开始连接
    client.connect(connectionConfig)
  })
}

// SFTP 方式上传
function uploadViaSFTP(
  client: Client,
  task: UploadTaskData,
  startTime: number,
  resolve: () => void,
  reject: (err: Error) => void
) {
  const { taskId, sessionId, localPath, remotePath, fileSize } = task
  let transferred = 0
  let lastProgressSent = 0

  const sendProgress = () => {
    const now = Date.now()
    if (now - lastProgressSent < 1000) return
    lastProgressSent = now

    const elapsed = (now - startTime) / 1000
    const speed = elapsed > 0 ? transferred / elapsed : 0

    sendMessage({
      type: 'progress',
      taskId,
      sessionId,
      progress: Math.round((transferred / fileSize) * 100),
      transferredSize: transferred,
      fileSize,
      speed
    })
  }

  client.sftp(async (err, sftp) => {
    if (err) {
      log('error', `SFTP init error: ${err.message}`)
      sendMessage({ type: 'error', taskId, sessionId, error: `SFTP error: ${err.message}` })
      client.end()
      reject(err)
      return
    }

    log('info', `SFTP subsystem started, uploading...`)

    // 确保远程父目录存在（与 exec/Python 路径的 os.makedirs 对齐）
    try {
      await sftpMkdirP(sftp, path.posix.dirname(remotePath))
    } catch (mkErr: any) {
      log('error', `SFTP mkdir parent dir error: ${mkErr.message}`)
      sendMessage({ type: 'error', taskId, sessionId, error: mkErr.message })
      client.end()
      reject(mkErr)
      return
    }

    sftp.fastPut(localPath, remotePath, {
      step: (transferredBytes: number) => {
        transferred = transferredBytes
        sendProgress()
      },
      concurrency: 64,
      chunkSize: 32768
    }, (err) => {
      if (err) {
        log('error', `SFTP upload error: ${err.message}`)
        sendMessage({ type: 'error', taskId, sessionId, error: err.message })
        client.end()
        reject(err)
      } else {
        const elapsed = (Date.now() - startTime) / 1000
        sendMessage({
          type: 'progress',
          taskId,
          sessionId,
          progress: 100,
          transferredSize: fileSize,
          fileSize,
          speed: fileSize / elapsed
        })

        sendMessage({
          type: 'complete',
          taskId,
          sessionId,
          transferredSize: fileSize
        })

        log('info', `SFTP upload completed: ${remotePath}`)
        client.end()
        resolve()
      }
    })
  })
}

// TCP 反向连接方式 - Python 启动 TCP Server 接收，Worker 直接 TCP 连接发送
function uploadViaExecPython(
  client: Client,
  task: UploadTaskData,
  startTime: number,
  resolve: () => void,
  rejectPromise: (err: Error) => void
) {
  const { taskId, sessionId, localPath, remotePath, fileSize, sshConfig } = task

  // 远端脚本名用 worker 内部生成的随机 hex，绝不能用外部 taskId——taskId 仅校验长度，
  // 含 ; / # 等字符会注入远端 shell 命令或改变脚本落点（如 "x; rm -rf ~; #"）。
  const scriptId = randomBytes(8).toString('hex')

  log('info', `Using Python TCP Server over SSH tunnel (encrypted)`)

  let transferred = 0
  let lastProgressSent = 0
  let uploadResolved = false  // 防止多次 resolve/reject
  let shellScriptTimer: ReturnType<typeof setTimeout> | undefined

  function clearShellScriptTimer(): void {
    if (shellScriptTimer) {
      clearTimeout(shellScriptTimer)
      shellScriptTimer = undefined
    }
  }

  function reject(err: Error): void {
    if (uploadResolved) return
    uploadResolved = true
    clearShellScriptTimer()
    clearTimeout(timeoutTimer)
    client.off('error', onExecClientError)
    rejectPromise(err)
  }

  function onExecClientError(err: Error): void {
    // executeUpload 的连接级 error handler 仍负责日志/renderer error；这里补齐 exec timer 清理。
    reject(err)
  }

  // 超时保护（对齐下载侧：基础 60s + 每 MB 额外 30s）。从进入 exec 路径起计时，
  // 覆盖脚本准备、SSH shell/exec、隧道建立与文件发送全流程。
  const timeout = 60000 + Math.ceil(fileSize / 1024 / 1024) * 30000
  const timeoutTimer = setTimeout(() => {
    if (uploadResolved) return
    log('error', `Upload timeout`)
    sendMessage({ type: 'error', taskId, sessionId, error: 'Upload timeout' })
    client.end()
    reject(new Error('Upload timeout'))
  }, timeout)
  // timer 只是兜底，不应单独保持 Worker 事件循环；成功/失败路径仍会主动 clearTimeout。
  timeoutTimer.unref?.()
  client.once('error', onExecClientError)

  const sendProgress = () => {
    const now = Date.now()
    if (now - lastProgressSent < 1000) return
    lastProgressSent = now

    const elapsed = (now - startTime) / 1000
    const speed = elapsed > 0 ? transferred / elapsed : 0

    sendMessage({
      type: 'progress',
      taskId,
      sessionId,
      progress: Math.round((transferred / fileSize) * 100),
      transferredSize: transferred,
      fileSize,
      speed
    })
  }

  // 生成 Python 字符串字面量：JSON.stringify 产出合法 Python 双引号串，
  // 正确转义 " 与 \，避免 remotePath 注入 Python 代码（heredoc 已用 'ENDSCRIPT'，shell 层本就安全）
  const safePath = JSON.stringify(remotePath)
  const fileName = path.basename(remotePath)

  // Python 脚本 - 启动 TCP Server 接收文件
  const pythonCode = `
import socket
import os
import struct
import sys
import hmac
import time

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
# 仅绑定 127.0.0.1 + 一次性 token 握手：配合 SSH forwardOut 隧道，避免端口暴露与抢连劫持
server.bind(("127.0.0.1", 0))
server.listen(1)
port = server.getsockname()[1]
token_hex = os.urandom(32).hex()
print("===LYSHELL_PORT:" + str(port) + "===")
print("===LYSHELL_TOKEN:" + token_hex + "===")
sys.stdout.flush()

# 握手：循环 accept，直到收到正确 token；总 deadline 防 Worker 失败后远端永久阻塞。
conn = None
accept_deadline = time.monotonic() + 60
server.settimeout(1)
while conn is None:
    if time.monotonic() >= accept_deadline:
        raise TimeoutError("upload connection deadline exceeded")
    try:
        conn, addr = server.accept()
    except socket.timeout:
        continue
    conn.settimeout(10)
    tok = b''
    while len(tok) < 64:
        c = conn.recv(64 - len(tok))
        if not c: break
        tok += c
    try:
        ok = len(tok) == 64 and hmac.compare_digest(tok.decode('ascii', 'replace'), token_hex)
    except Exception:
        ok = False
    if not ok:
        try: conn.close()
        except Exception: pass
        conn = None
        continue
    conn.settimeout(None)

file_path = ${safePath}
file_name = os.path.basename(file_path)

# 接收文件名长度和文件名
name_len_data = b''
while len(name_len_data) < 4:
    chunk = conn.recv(4 - len(name_len_data))
    if not chunk: break
    name_len_data += chunk
name_len = struct.unpack(">I", name_len_data)[0]

name_data = b''
while len(name_data) < name_len:
    chunk = conn.recv(name_len - len(name_data))
    if not chunk: break
    name_data += chunk
received_name = name_data.decode("utf-8")

# 接收文件大小
size_data = b''
while len(size_data) < 8:
    chunk = conn.recv(8 - len(size_data))
    if not chunk: break
    size_data += chunk
file_size = struct.unpack(">Q", size_data)[0]

print("===DEBUG_NAME:" + received_name + "===")
print("===DEBUG_SIZE:" + str(file_size) + "===")
sys.stdout.flush()

# 创建目录（如果需要）
os.makedirs(os.path.dirname(file_path) or '.', exist_ok=True)

# 接收文件数据
received = 0
with open(file_path, "wb") as f:
    while received < file_size:
        chunk = conn.recv(min(65536, file_size - received))
        if not chunk: break
        f.write(chunk)
        received += len(chunk)

conn.close()
server.close()
try:
    os.unlink(__file__)  # 自删临时脚本，避免 /tmp 残留（脚本已载入内存，删除不影响执行）
except Exception:
    pass
print("===LYSHELL_DONE:" + str(received) + "===")
sys.stdout.flush()
`

  // 每次传输用唯一脚本名（scriptId 随机 hex）：并发任务共享 /tmp/nvsh_ul.py 会互相覆盖，
  // 导致 A 执行 B 的脚本（把 A 的内容上传到 B 的目标路径）。
  // trap EXIT 清理脚本：Python 不存在 / forwarding 禁用 / 超时 / 取消时也删，避免 /tmp 无界残留。
  // Python 成功路径的 os.unlink(__file__) 提前删，trap 的 rm -f 幂等兜底。
  const pythonScript = `_NVSH_UL=/tmp/nvsh_ul_${scriptId}.py
trap 'rm -f "$_NVSH_UL"' EXIT
cat > "$_NVSH_UL" << 'ENDSCRIPT'
${pythonCode}
ENDSCRIPT
python3 "$_NVSH_UL" || python "$_NVSH_UL" || echo "PYTHON_FAILED"`

  // 根据是否有 shellEnterCommands 选择执行方式
  const enterCommands = sshConfig.shellEnterCommands?.split('\n').filter(c => c.trim()) || []
  const hasShellEnter = enterCommands.length > 0

  if (hasShellEnter) {
    log('info', `Using shell mode (has enter commands: ${enterCommands.join(', ')})`)
    executeWithShell(client, pythonScript, enterCommands, sshConfig.shellEnterWait || 3000)
  } else {
    log('info', `Using exec mode (no enter commands)`)
    executeWithExec(client, pythonScript)
  }

  function executeWithShell(
    client: Client,
    script: string,
    enterCommands: string[],
    enterWait: number
  ) {
    client.shell((err: Error | undefined, stream: SSHClientChannel) => {
      if (err) {
        log('error', `Shell error: ${err.message}`)
        sendMessage({ type: 'error', taskId, sessionId, error: err.message })
        client.end()
        reject(err)
        return
      }

      let shellOutput = ''
      let pythonPort = 0
      let pythonToken = ''
      let phase = 'waiting_port'
      let uploadFinished = false

      stream.on('data', (data: Buffer) => {
        const output = data.toString()
        shellOutput += output

        // 打印重要输出
        const trimmed = output.trim()
        if (trimmed && trimmed.length < 100 && !trimmed.includes('python3')) {
          log('info', `Shell: ${trimmed}`)
        }

        // 检测端口与 token
        if (phase === 'waiting_port') {
          const portMatch = shellOutput.match(/===LYSHELL_PORT:(\d+)===/)
          if (portMatch) {
            pythonPort = parseInt(portMatch[1], 10)
            log('info', `Python TCP Server port: ${pythonPort}`)
            phase = 'waiting_token'
          }
        }
        if (phase === 'waiting_token') {
          const tokenMatch = shellOutput.match(/===LYSHELL_TOKEN:([0-9a-fA-F]+)===/)
          if (tokenMatch) {
            pythonToken = tokenMatch[1]
            log('info', `Got auth token, opening SSH tunnel...`)
            phase = 'uploading'
            connectToPython(pythonPort, pythonToken)
          }
        }

        // 检测完成（所有阶段都检测）
        const doneMatch = shellOutput.match(/===LYSHELL_DONE:(\d+)===/)
        if (doneMatch && !uploadFinished) {
          log('info', `Python done: ${doneMatch[1]} bytes received`)
          uploadFinished = true
          finishUpload(Number(doneMatch[1]))
        }
      })

      stream.stderr?.on('data', (data: Buffer) => {
        log('warn', `stderr: ${data.toString().trim()}`)
      })

      stream.on('error', (err: Error) => {
        if (uploadResolved) return
        clearShellScriptTimer()
        log('error', `Shell stream error: ${err.message}`)
        sendMessage({ type: 'error', taskId, sessionId, error: err.message })
        client.end()
        reject(err)
      })

      stream.on('close', () => {
        if (uploadResolved) return
        clearShellScriptTimer()
        log('info', `Shell closed`)
        // 检测是否有 Python 错误
        if (shellOutput.includes('PYTHON_FAILED')) {
          log('error', `Python execution failed`)
          sendMessage({ type: 'error', taskId, sessionId, error: 'Python execution failed' })
          client.end()
          reject(new Error('Python execution failed'))
        } else if (shellOutput.includes('Traceback (most recent call last)')) {
          // 提取错误信息
          const lines = shellOutput.split('\n')
          let errorMsg = 'Python script error'
          for (const line of lines) {
            const errorMatch = line.match(/(?:OSError|PermissionError|IOError|Error):\s*(.+)$/)
            if (errorMatch) {
              errorMsg = errorMatch[1].trim()
              break
            }
          }
          log('error', `Python error: ${errorMsg}`)
          sendMessage({ type: 'error', taskId, sessionId, error: errorMsg })
          client.end()
          reject(new Error(errorMsg))
        } else if (!uploadFinished) {
          // stream 关闭但未收到 LYSHELL_DONE：远端 Python 未完成 / stdout 丢失 / 提前关闭。
          // 不应报成功--远端文件可能不完整。报错让调用方知晓。
          const errMsg = 'Upload stream closed without remote completion acknowledgment'
          log('error', errMsg)
          sendMessage({ type: 'error', taskId, sessionId, error: errMsg })
          client.end()
          reject(new Error(errMsg))
        }
      })

      // 发送进入命令
      for (const cmd of enterCommands) {
        stream.write(`${cmd}\n`)
        log('info', `Sent enter: ${cmd}`)
      }

      // 等待后发送 Python 脚本；失败/关闭/完成时统一取消，避免向已关闭 stream 写入。
      shellScriptTimer = setTimeout(() => {
        shellScriptTimer = undefined
        if (uploadResolved) return
        try {
          stream.write(`${script}\n`)
          log('info', `Sent Python script`)
        } catch (error) {
          // 写入失败须发终态 error 再 reject：入口 catch 不再兜底重发，
          // 此路径若不发 error，manager 只能靠 exit 兜底报 "exited with code 1"，丢失原因。
          const msg = `Shell script write failed: ${(error as Error).message}`
          log('error', msg)
          sendMessage({ type: 'error', taskId, sessionId, error: msg })
          reject(error as Error)
        }
      }, enterWait)
      shellScriptTimer.unref?.()
    })
  }

  function executeWithExec(client: Client, script: string) {
    client.exec(script, (err: Error | undefined, stream: SSHClientChannel) => {
      if (err) {
        log('error', `Exec error: ${err.message}`)
        sendMessage({ type: 'error', taskId, sessionId, error: err.message })
        client.end()
        reject(err)
        return
      }

      let execOutput = ''
      let pythonPort = 0
      let pythonToken = ''
      let phase = 'waiting_port'
      let uploadFinished = false

      stream.on('data', (data: Buffer) => {
        const output = data.toString()
        execOutput += output

        const trimmed = output.trim()
        if (trimmed && trimmed.length < 100) {
          log('info', `Exec: ${trimmed}`)
        }

        if (phase === 'waiting_port') {
          const portMatch = execOutput.match(/===LYSHELL_PORT:(\d+)===/)
          if (portMatch) {
            pythonPort = parseInt(portMatch[1], 10)
            log('info', `Python TCP Server port: ${pythonPort}`)
            phase = 'waiting_token'
          }
        }
        if (phase === 'waiting_token') {
          const tokenMatch = execOutput.match(/===LYSHELL_TOKEN:([0-9a-fA-F]+)===/)
          if (tokenMatch) {
            pythonToken = tokenMatch[1]
            log('info', `Got auth token, opening SSH tunnel...`)
            phase = 'connecting'
            connectToPython(pythonPort, pythonToken)
          }
        }

        // 检测完成（所有阶段都检测，与 shell 模式一致）
        const doneMatch = execOutput.match(/===LYSHELL_DONE:(\d+)===/)
        if (doneMatch && !uploadFinished) {
          log('info', `Python done: ${doneMatch[1]} bytes received`)
          uploadFinished = true
          finishUpload(Number(doneMatch[1]))
        }
      })

      stream.stderr?.on('data', (data: Buffer) => {
        log('warn', `stderr: ${data.toString().trim()}`)
      })

      stream.on('error', (err: Error) => {
        if (uploadResolved) return
        log('error', `Exec stream error: ${err.message}`)
        sendMessage({ type: 'error', taskId, sessionId, error: err.message })
        client.end()
        reject(err)
      })

      stream.on('close', () => {
        if (uploadResolved) return
        log('info', `Exec stream closed`)
        // 检测是否有 Python 错误
        if (execOutput.includes('PYTHON_FAILED')) {
          log('error', `Python execution failed`)
          sendMessage({ type: 'error', taskId, sessionId, error: 'Python execution failed' })
          client.end()
          reject(new Error('Python execution failed'))
        } else if (execOutput.includes('Traceback (most recent call last)')) {
          // 提取错误信息
          const lines = execOutput.split('\n')
          let errorMsg = 'Python script error'
          for (const line of lines) {
            const errorMatch = line.match(/(?:OSError|PermissionError|IOError|Error):\s*(.+)$/)
            if (errorMatch) {
              errorMsg = errorMatch[1].trim()
              break
            }
          }
          log('error', `Python error: ${errorMsg}`)
          sendMessage({ type: 'error', taskId, sessionId, error: errorMsg })
          client.end()
          reject(new Error(errorMsg))
        } else if (!uploadFinished) {
          // stream 关闭但未收到 LYSHELL_DONE：远端 Python 未完成 / stdout 丢失 / 提前关闭。
          // 不应报成功--远端文件可能不完整。报错让调用方知晓。
          const errMsg = 'Upload stream closed without remote completion acknowledgment'
          log('error', errMsg)
          sendMessage({ type: 'error', taskId, sessionId, error: errMsg })
          client.end()
          reject(new Error(errMsg))
        }
      })
    })
  }

  // 连接 Python TCP Server 发送文件（经 SSH direct-tcpip 隧道，加密）
  function connectToPython(port: number, token: string) {
    log('info', `Opening SSH tunnel to 127.0.0.1:${port} for upload (encrypted)`)

    const startSend = (stream: SSHClientChannel) => {
      log('info', `SSH tunnel established, sending auth token + file...`)

      // 先发 token 握手，server 校验通过后才开始接收文件数据
      stream.write(Buffer.from(token, 'utf-8'))

      // 发送文件名长度（4字节）
      const nameBytes = Buffer.from(fileName, 'utf-8')
      const nameLenBuf = Buffer.alloc(4)
      nameLenBuf.writeUInt32BE(nameBytes.length, 0)
      stream.write(nameLenBuf)

      // 发送文件名
      stream.write(nameBytes)

      // 发送文件大小（8字节）
      const sizeBuf = Buffer.alloc(8)
      sizeBuf.writeBigUInt64BE(BigInt(fileSize), 0)
      stream.write(sizeBuf)

      // 发送文件内容
      const readStream = fs.createReadStream(localPath, { highWaterMark: 65536 })

      readStream.on('data', (chunk: string | Buffer) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        transferred += buffer.length
        sendProgress()
        // 等待写入完成
        const canContinue = stream.write(buffer)
        if (!canContinue) {
          // 缓冲区满了，暂停读取
          readStream.pause()
          stream.once('drain', () => {
            readStream.resume()
          })
        }
      })

      readStream.on('end', () => {
        log('info', `File read complete, transferred: ${transferred}`)
        // 不立即关闭，等待远程确认（通过 shell 的 LYSHELL_DONE）
        // 保持连接，让 finishUpload 处理关闭
      })

      readStream.on('error', (err) => {
        log('error', `Read stream error: ${err.message}`)
        sendMessage({ type: 'error', taskId, sessionId, error: err.message })
        stream.destroy()
        client.end()
        reject(err)
      })

      stream.on('error', (err: Error) => {
        if (uploadResolved) return  // 已完成，忽略后续流错误
        log('error', `Tunnel error: ${err.message}`)
        sendMessage({ type: 'error', taskId, sessionId, error: `Transfer failed: ${err.message}` })
        client.end()
        reject(err)
      })
    }

    try {
      // 用 SSH direct-tcpip 隧道代替裸 TCP：流量加密 + 绑定 127.0.0.1 + 隧道本身已鉴权。
      // 若服务器禁止 direct-tcpip（AllowTcpForwarding no），forwardOut 回调带 err -- 不降级为明文，直接失败。
      client.forwardOut('', 0, '127.0.0.1', port, (err: Error | undefined, stream: SSHClientChannel) => {
        if (err) {
          const msg = `SSH TCP forwarding failed (${err.message}). The server may disallow direct-tcpip (AllowTcpForwarding no). Enable it or use SFTP.`
          log('error', msg)
          sendMessage({ type: 'error', taskId, sessionId, error: msg })
          client.end()
          reject(new Error(msg))
          return
        }
        startSend(stream)
      })
    } catch (e: any) {
      // forwardOut 在未连接时同步抛错
      const msg = `SSH TCP forwarding failed (${e.message}).`
      log('error', msg)
      sendMessage({ type: 'error', taskId, sessionId, error: msg })
      client.end()
      reject(e)
    }
  }

  // 完成上传
  function finishUpload(receivedByRemote?: number) {
    if (uploadResolved) return  // 已处理，防止重复

    // 校验远端实际写入字节数：Python server 回报 LYSHELL_DONE:<received>。
    // 隧道 EOF / 对端只写部分时 received < fileSize，此时远端文件不完整，必须报错。
    // 必须在置 uploadResolved 之前校验：reject() 包装器见已 resolved 会直接 no-op，
    // 先置位会让字节数不匹配的失败被吞掉——promise 不 reject、Worker 也不退出。
    if (receivedByRemote !== undefined && receivedByRemote !== fileSize) {
      const errMsg = `Remote received ${receivedByRemote} bytes but expected ${fileSize}; upload incomplete`
      log('error', errMsg)
      sendMessage({ type: 'error', taskId, sessionId, error: errMsg })
      client.end()
      reject(new Error(errMsg))  // reject 自身负责置 uploadResolved + 清理 timer/listener
      return
    }

    uploadResolved = true
    clearShellScriptTimer()
    clearTimeout(timeoutTimer)
    client.off('error', onExecClientError)

    const elapsed = (Date.now() - startTime) / 1000
    const speed = elapsed > 0 ? transferred / elapsed : 0

    sendMessage({
      type: 'progress',
      taskId,
      sessionId,
      progress: 100,
      transferredSize: transferred,
      fileSize,
      speed
    })

    sendMessage({
      type: 'complete',
      taskId,
      sessionId,
      transferredSize: transferred
    })

    log('info', `Upload completed: ${remotePath}`)
    client.end()
    resolve()
  }

}

// Worker 入口
// 与 download-worker 一致：成功 exit(0)、失败 exit(1)。顶层异常或连接/流资源未自然关闭时，
// Worker 线程不会自行退出--管理器靠 exit 事件回收任务，缺 exit 会永久挂起、占用资源。
// catch 不重发 error：各失败路径已在 reject 前发送唯一终态 error 消息，这里只日志+退出，
// 避免 manager 收到两条 error 把同一失败报两次给渲染进程。
if (workerData) {
  const task: UploadTaskData = workerData
  executeUpload(task)
    .then(() => {
      process.exit(0)
    })
    .catch((err) => {
      log('error', `Upload failed: ${err.message}`)
      process.exit(1)
    })
}