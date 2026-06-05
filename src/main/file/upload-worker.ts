/**
 * 上传 Worker - 在独立线程中执行文件上传
 * 使用 TCP 反向连接方式，和下载模式一致
 */
import { parentPort, workerData } from 'worker_threads'
import { Client } from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import * as net from 'net'

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

// 日志函数
function log(level: 'info' | 'warn' | 'error', message: string) {
  sendMessage({ type: 'log', level, message })
}

// 执行上传
async function executeUpload(task: UploadTaskData) {
  const { taskId, sessionId, method, sshConfig, localPath, remotePath, fileSize } = task

  log('info', `Worker starting upload (${method}): ${localPath} -> ${remotePath} (${fileSize} bytes)`)

  // 检查本地文件是否存在
  if (!fs.existsSync(localPath)) {
    sendMessage({ type: 'error', taskId, sessionId, error: 'Local file not found' })
    return
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

  client.sftp((err, sftp) => {
    if (err) {
      log('error', `SFTP init error: ${err.message}`)
      sendMessage({ type: 'error', taskId, sessionId, error: `SFTP error: ${err.message}` })
      client.end()
      reject(err)
      return
    }

    log('info', `SFTP subsystem started, uploading...`)

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
  reject: (err: Error) => void
) {
  const { taskId, sessionId, localPath, remotePath, fileSize, sshConfig } = task
  const serverIP = sshConfig.host

  log('info', `Using Python TCP Server + direct TCP method for upload`)

  let transferred = 0
  let lastProgressSent = 0
  let transferComplete = false
  let uploadResolved = false  // 防止多次 resolve

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

  // 安全处理路径中的单引号
  const safePath = remotePath.replace(/'/g, "'\"'\"'")
  const fileName = path.basename(remotePath)

  // Python 脚本 - 启动 TCP Server 接收文件
  const pythonCode = `
import socket
import os
import struct
import sys

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("0.0.0.0", 0))
server.listen(1)
port = server.getsockname()[1]
print("===NOVASHELL_PORT:" + str(port) + "===")
sys.stdout.flush()

conn, addr = server.accept()
file_path = "${safePath}"
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
print("===NOVASHELL_DONE:" + str(received) + "===")
sys.stdout.flush()
`

  // 执行脚本
  const pythonScript = `cat > /tmp/nvsh_ul.py << 'ENDSCRIPT'
${pythonCode}
ENDSCRIPT
python3 /tmp/nvsh_ul.py || python /tmp/nvsh_ul.py || echo "PYTHON_FAILED"`

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

        // 检测端口（只在 waiting_port 阶段）
        if (phase === 'waiting_port') {
          const portMatch = shellOutput.match(/===NOVASHELL_PORT:(\d+)===/)
          if (portMatch) {
            pythonPort = parseInt(portMatch[1], 10)
            log('info', `Python TCP Server port: ${pythonPort}`)
            phase = 'uploading'
            connectToPython(pythonPort)
          }
        }

        // 检测完成（所有阶段都检测）
        const doneMatch = shellOutput.match(/===NOVASHELL_DONE:(\d+)===/)
        if (doneMatch && !uploadFinished) {
          log('info', `Python done: ${doneMatch[1]} bytes received`)
          uploadFinished = true
          finishUpload()
        }
      })

      stream.stderr?.on('data', (data: Buffer) => {
        log('warn', `stderr: ${data.toString().trim()}`)
      })

      stream.on('close', () => {
        log('info', `Shell closed`)
        finishUpload()
      })

      // 发送进入命令
      for (const cmd of enterCommands) {
        stream.write(`${cmd}\n`)
        log('info', `Sent enter: ${cmd}`)
      }

      // 等待后发送 Python 脚本
      setTimeout(() => {
        stream.write(`${script}\n`)
        log('info', `Sent Python script`)
      }, enterWait)
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
      let phase = 'waiting_port'

      stream.on('data', (data: Buffer) => {
        const output = data.toString()
        execOutput += output

        const trimmed = output.trim()
        if (trimmed && trimmed.length < 100) {
          log('info', `Exec: ${trimmed}`)
        }

        if (phase === 'waiting_port') {
          const portMatch = execOutput.match(/===NOVASHELL_PORT:(\d+)===/)
          if (portMatch) {
            pythonPort = parseInt(portMatch[1], 10)
            log('info', `Python TCP Server port: ${pythonPort}`)
            phase = 'connecting'
            connectToPython(pythonPort)
          }

          const doneMatch = execOutput.match(/===NOVASHELL_DONE:(\d+)===/)
          if (doneMatch) {
            log('info', `Python done: ${doneMatch[1]} bytes received`)
            finishUpload()
          }
        }
      })

      stream.stderr?.on('data', (data: Buffer) => {
        log('warn', `stderr: ${data.toString().trim()}`)
      })

      stream.on('close', () => {
        log('info', `Exec stream closed`)
        finishUpload()
      })
    })
  }

  // 连接 Python TCP Server 发送文件
  function connectToPython(port: number) {
    log('info', `Connecting to ${serverIP}:${port} for upload`)

    const tcpClient = new net.Socket()
    let sendComplete = false
    let receivedConfirm = false

    tcpClient.on('error', (err) => {
      log('error', `TCP connection error: ${err.message}`)
      sendMessage({ type: 'error', taskId, sessionId, error: `TCP error: ${err.message}` })
      tcpClient.destroy()
      client.end()
      reject(err)
    })

    // 接收远程确认
    tcpClient.on('data', (data: Buffer) => {
      // 检查是否有完成确认（通过 shell 输出的 NOVASHELL_DONE）
      // TCP socket 本身不接收数据，确认通过 shell 输出
    })

    tcpClient.connect(port, serverIP, () => {
      log('info', `TCP connected to Python server, sending file...`)

      // 发送文件名长度（4字节）
      const nameBytes = Buffer.from(fileName, 'utf-8')
      const nameLenBuf = Buffer.alloc(4)
      nameLenBuf.writeUInt32BE(nameBytes.length, 0)
      tcpClient.write(nameLenBuf)

      // 发送文件名
      tcpClient.write(nameBytes)

      // 发送文件大小（8字节）
      const sizeBuf = Buffer.alloc(8)
      sizeBuf.writeBigUInt64BE(BigInt(fileSize), 0)
      tcpClient.write(sizeBuf)

      // 发送文件内容
      const readStream = fs.createReadStream(localPath, { highWaterMark: 65536 })

      readStream.on('data', (chunk: Buffer) => {
        transferred += chunk.length
        sendProgress()
        // 等待写入完成
        const canContinue = tcpClient.write(chunk)
        if (!canContinue) {
          // 缓冲区满了，暂停读取
          readStream.pause()
          tcpClient.once('drain', () => {
            readStream.resume()
          })
        }
      })

      readStream.on('end', () => {
        log('info', `File read complete, transferred: ${transferred}`)
        sendComplete = true
        // 不立即关闭，等待远程确认（通过 shell 的 NOVASHELL_DONE）
        // 保持连接，让 finishUpload 处理关闭
      })

      readStream.on('error', (err) => {
        log('error', `Read stream error: ${err.message}`)
        sendMessage({ type: 'error', taskId, sessionId, error: err.message })
        tcpClient.destroy()
        client.end()
        reject(err)
      })
    })

    tcpClient.on('close', () => {
      log('info', `TCP connection closed`)
      if (sendComplete && receivedConfirm) {
        transferComplete = true
      }
    })
  }

  // 完成上传
  function finishUpload() {
    if (uploadResolved) return  // 已处理，防止重复
    uploadResolved = true

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
if (workerData) {
  const task: UploadTaskData = workerData
  executeUpload(task).catch((err) => {
    log('error', `Upload failed: ${err.message}`)
    sendMessage({
      type: 'error',
      taskId: task.taskId,
      sessionId: task.sessionId,
      error: err.message
    })
  })
}