/**
 * 下载 Worker - 在独立线程中执行文件下载
 * 完全不阻塞主进程
 * 支持 SFTP 和 TCP 反向连接两种方式
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
interface DownloadTaskData {
  taskId: string
  sessionId: string
  method: 'sftp' | 'exec'  // 下载方式
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
  remotePath: string
  localPath: string
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

// 执行下载
async function executeDownload(task: DownloadTaskData) {
  const { taskId, sessionId, method, sshConfig, remotePath, localPath, fileSize } = task

  log('info', `Worker starting download (${method}): ${remotePath} -> ${localPath} (${fileSize} bytes)`)

  // 确保本地目录存在
  const localDir = path.dirname(localPath)
  await fs.promises.mkdir(localDir, { recursive: true })

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
    } else {
      log('warn', 'No authentication method provided!')
    }

    // 连接错误
    client.on('error', (err) => {
      const errMsg = err.message?.split('\n')[0] || err.toString()
      log('error', `SSH connection error: ${errMsg}`)
      sendMessage({
        type: 'error',
        taskId,
        sessionId,
        error: errMsg
      })
      reject(err)
    })

    // 连接就绪
    client.on('ready', () => {
      log('info', `SSH connection ready`)
      startTime = Date.now()

      if (method === 'sftp') {
        // SFTP 方式下载
        downloadViaSFTP(client, task, startTime, resolve, reject)
      } else {
        // Exec Python TCP 方式下载
        downloadViaExecPython(client, task, startTime, resolve, reject)
      }
    })

    // 开始连接
    client.connect(connectionConfig)
  })
}

// SFTP 方式下载
function downloadViaSFTP(
  client: Client,
  task: DownloadTaskData,
  startTime: number,
  resolve: () => void,
  reject: (err: Error) => void
) {
  const { taskId, sessionId, remotePath, localPath, fileSize } = task
  let transferred = 0
  let lastProgressSent = 0

  // 发送进度（限制频率）
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
      sendMessage({
        type: 'error',
        taskId,
        sessionId,
        error: `SFTP subsystem error: ${err.message}`
      })
      client.end()
      reject(err)
      return
    }

    log('info', `SFTP subsystem started, downloading...`)

    sftp.fastGet(remotePath, localPath, {
      step: (transferredBytes: number) => {
        transferred = transferredBytes
        sendProgress()
      },
      concurrency: 64,
      chunkSize: 32768
    }, (err) => {
      if (err) {
        log('error', `SFTP download error: ${err.message}`)
        sendMessage({
          type: 'error',
          taskId,
          sessionId,
          error: err.message
        })
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

        log('info', `SFTP download completed: ${localPath}`)
        client.end()
        resolve()
      }
    })
  })
}

// TCP 反向连接方式 - Python 启动 TCP Server，Worker 直接 TCP 连接
function downloadViaExecPython(
  client: Client,
  task: DownloadTaskData,
  startTime: number,
  resolve: () => void,
  reject: (err: Error) => void
) {
  const { taskId, sessionId, remotePath, localPath, fileSize, sshConfig } = task
  const serverIP = sshConfig.host

  log('info', `Using Python TCP Server + direct TCP method`)
  log('info', `[DEBUG] remotePath = "${remotePath}"`)
  log('info', `[DEBUG] remotePath length = ${remotePath.length}`)
  log('info', `[DEBUG] remotePath bytes = ${Buffer.from(remotePath).toString('hex')}`)

  let transferred = 0
  let lastProgressSent = 0
  let expectedSize = fileSize
  let transferComplete = false
  const fd = fs.openSync(localPath, 'w')

  const sendProgress = () => {
    const now = Date.now()
    if (now - lastProgressSent < 1000) return
    lastProgressSent = now
    const elapsed = (now - startTime) / 1000
    const speed = elapsed > 0 ? transferred / elapsed : 0
    sendMessage({
      type: 'progress', taskId, sessionId,
      progress: Math.round((transferred / expectedSize) * 100),
      transferredSize: transferred, fileSize: expectedSize, speed
    })
  }

  // 安全处理路径中的单引号
  const safePath = remotePath.replace(/'/g, "'\"'\"'")

  // Python 脚本 - 会用 base64 编码传输
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
file_size = os.path.getsize(file_path)
print("===DEBUG_PATH:" + file_path + "===")
print("===DEBUG_NAME:" + file_name + "===")
print("===DEBUG_SIZE:" + str(file_size) + "===")
sys.stdout.flush()
name_bytes = file_name.encode("utf-8")

conn.sendall(struct.pack(">I", len(name_bytes)))
conn.sendall(name_bytes)
conn.sendall(struct.pack(">Q", file_size))

with open(file_path, "rb") as f:
    while True:
        chunk = f.read(65536)
        if not chunk: break
        conn.sendall(chunk)

conn.close()
server.close()
print("===NOVASHELL_DONE:" + str(file_size) + "===")
sys.stdout.flush()
`

  // 执行命令：用 heredoc 写入 Python 脚本，直接执行
  const pythonScript = `cat > /tmp/nvsh_dl.py << 'ENDSCRIPT'
${pythonCode}
ENDSCRIPT
python3 /tmp/nvsh_dl.py || python /tmp/nvsh_dl.py || echo "PYTHON_FAILED"`

  // 根据是否有 shellEnterCommands 选择执行方式
  const enterCommands = sshConfig.shellEnterCommands?.split('\n').filter(c => c.trim()) || []
  const hasShellEnter = enterCommands.length > 0

  if (hasShellEnter) {
    // 有 shell 进入命令，必须用 shell 方式
    log('info', `Using shell mode (has enter commands: ${enterCommands.join(', ')})`)
    executeWithShell(client, pythonScript, enterCommands, sshConfig.shellEnterWait || 3000)
  } else {
    // 无 shell 进入命令，直接用 exec
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

      stream.on('data', (data: Buffer) => {
        const output = data.toString()
        shellOutput += output

        // 打印重要输出（跳过大量数据）
        const trimmed = output.trim()
        if (trimmed && trimmed.length < 100 && !trimmed.includes('python3')) {
          log('info', `Shell: ${trimmed}`)
        }

        if (phase === 'waiting_port') {
          const portMatch = shellOutput.match(/===NOVASHELL_PORT:(\d+)===/)
          if (portMatch) {
            pythonPort = parseInt(portMatch[1], 10)
            log('info', `Python TCP Server port: ${pythonPort}`)
            phase = 'connecting'
            connectToPython(pythonPort)
          }

          const doneMatch = shellOutput.match(/===NOVASHELL_DONE:(\d+)===/)
          if (doneMatch) {
            log('info', `Python done: ${doneMatch[1]} bytes`)
          }
        }
      })

      stream.stderr?.on('data', (data: Buffer) => {
        log('warn', `stderr: ${data.toString().trim()}`)
      })

      stream.on('close', () => {
        log('info', `Shell closed`)
        finishDownload()
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
        if (trimmed.includes('NOVASHELL')) {
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
            log('info', `Python done: ${doneMatch[1]} bytes`)
          }
        }
      })

      stream.stderr?.on('data', (data: Buffer) => {
        log('warn', `stderr: ${data.toString().trim()}`)
      })

      stream.on('close', () => {
        log('info', `Exec closed`)
        finishDownload()
      })
    })
  }

  function connectToPython(port: number) {
    log('info', `Connecting to ${serverIP}:${port} via direct TCP...`)

    let buf = Buffer.alloc(0)
    let fileNameLen = 0
    let fileName = ''
    let dataPhase = 'waiting_header'

    const tcpClient = net.connect({ host: serverIP, port: port }, () => {
      log('info', `Connected to Python TCP Server`)
      dataPhase = 'waiting_header'
    })

    tcpClient.on('data', (data: Buffer) => {
      buf = Buffer.concat([buf, data])
      log('info', `[TCP] Received ${data.length} bytes, total buf: ${buf.length}`)

      while (buf.length > 0) {
        if (dataPhase === 'waiting_header') {
          // 需要等待完整的头部：文件名长度(4字节)
          if (buf.length >= 4) {
            fileNameLen = buf.readUInt32BE(0)
            log('info', `[TCP] fileNameLen = ${fileNameLen}`)
            buf = buf.subarray(4)  // 移除已读的4字节
            dataPhase = 'waiting_filename'
            continue
          }
          break  // 数据不足，等待更多
        }

        if (dataPhase === 'waiting_filename') {
          // 需要等待完整的文件名
          if (buf.length >= fileNameLen) {
            fileName = buf.subarray(0, fileNameLen).toString('utf-8')
            log('info', `[TCP] fileName = "${fileName}"`)
            buf = buf.subarray(fileNameLen)  // 移除已读的文件名
            dataPhase = 'waiting_filesize'
            continue
          }
          break  // 数据不足，等待更多
        }

        if (dataPhase === 'waiting_filesize') {
          // 需要等待完整的文件大小(8字节)
          if (buf.length >= 8) {
            expectedSize = Number(buf.readBigUInt64BE(0))
            log('info', `[TCP] fileSize = ${expectedSize}`)
            buf = buf.subarray(8)  // 移除已读的8字节
            dataPhase = 'waiting_data'
            continue
          }
          break  // 数据不足，等待更多
        }

        if (dataPhase === 'waiting_data') {
          if (buf.length > 0) {
            fs.writeSync(fd, buf)
            transferred += buf.length
            buf = Buffer.alloc(0)
            sendProgress()

            if (transferred >= expectedSize) {
              dataPhase = 'done'
              transferComplete = true
              fs.closeSync(fd)
              sendMessage({
                type: 'progress', taskId, sessionId,
                progress: 100, transferredSize: transferred, fileSize: expectedSize,
                speed: transferred / ((Date.now() - startTime) / 1000)
              })
              sendMessage({ type: 'complete', taskId, sessionId, transferredSize: transferred })
              log('info', `Download completed: ${fileName} (${transferred} bytes)`)
              tcpClient.destroy()
            }
          }
          break
        }

        if (dataPhase === 'done') {
          break
        }
      }
    })

    tcpClient.on('error', (err: Error) => {
      log('error', `TCP error: ${err.message}`)
      sendMessage({ type: 'error', taskId, sessionId, error: `TCP failed: ${err.message}` })
    })

    tcpClient.on('close', () => {
      log('info', `TCP closed`)
    })
  }

  function finishDownload() {
    if (!transferComplete) {
      fs.closeSync(fd)
      const progress = expectedSize > 0 ? Math.round((transferred / expectedSize) * 100) : 0
      sendMessage({ type: 'error', taskId, sessionId, error: `Incomplete: ${transferred}/${expectedSize} (${progress}%)` })
    }
    client.end()
    resolve()
  }

  // 超时保护
  const timeout = 60000 + Math.ceil(fileSize / 1024 / 1024) * 30000
  setTimeout(() => {
    if (!transferComplete) {
      log('error', `Download timeout`)
      sendMessage({ type: 'error', taskId, sessionId, error: `Download timeout` })
      client.end()
      reject(new Error('Download timeout'))
    }
  }, timeout)
}

// Worker 入口
if (workerData) {
  const task = workerData as DownloadTaskData
  executeDownload(task)
    .then(() => {
      process.exit(0)
    })
    .catch((err) => {
      log('error', `Download failed: ${err.message}`)
      process.exit(1)
    })
}