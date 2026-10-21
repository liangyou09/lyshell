import { Client } from 'ssh2'
import * as fs from 'fs'
import { randomBytes } from 'crypto'
import type { LegacyTask, WorkerMessage } from './types'
type SSHClientChannel = any
export function downloadViaExecPython(
  client: Client,
  task: LegacyTask,
  startTime: number,
  resolve: () => void,
  reject: (err: Error) => void,
  sendMessage: (msg: WorkerMessage) => void,
  log: (level: string, message: string) => void
) {
  const { taskId, sessionId, remotePath, localPath, fileSize, sshConfig } = task

  // 远端脚本名用 worker 内部生成的随机 hex，绝不能用外部 taskId——taskId 仅校验长度，
  // 含 ; / # 等字符会注入远端 shell 命令或改变脚本落点（如 "x; rm -rf ~; #"）。
  const scriptId = randomBytes(8).toString('hex')

  log('info', `Using Python TCP Server over SSH tunnel (encrypted)`)
  log('info', `[DEBUG] remotePath = "${remotePath}"`)
  log('info', `[DEBUG] remotePath length = ${remotePath.length}`)
  log('info', `[DEBUG] remotePath bytes = ${Buffer.from(remotePath).toString('hex')}`)

  let transferred = 0
  let lastProgressSent = 0
  let expectedSize = fileSize
  let transferComplete = false
  let remoteDone = false
  let settled = false
  let commandStream: SSHClientChannel | null = null
  let shellScriptTimer: ReturnType<typeof setTimeout> | undefined
  const fd = fs.openSync(localPath, 'wx')
  let fdClosed = false
  const closeFd = () => { if (!fdClosed) { try { fs.closeSync(fd) } catch { /* ignore close errors */ } fdClosed = true } }

  function clearShellScriptTimer(): void {
    if (shellScriptTimer) {
      clearTimeout(shellScriptTimer)
      shellScriptTimer = undefined
    }
  }

  function failDownload(error: Error, message: string = error.message): void {
    if (settled) return
    settled = true
    clearShellScriptTimer()
    if (timeoutTimer) clearTimeout(timeoutTimer)
    closeFd()
    client.off('error', onExecClientError)
    log('error', message)
    sendMessage({ type: 'error', taskId, sessionId, error: message })
    client.end()
    reject(error)
  }

  function onExecClientError(error: Error): void {
    failDownload(error, `SSH connection error: ${error.message}`)
  }

  client.once('error', onExecClientError)

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

  // 生成 Python 字符串字面量：JSON.stringify 产出合法 Python 双引号串，
  // 正确转义 " 与 \，避免 remotePath 注入 Python 代码（heredoc 已用 'ENDSCRIPT'，shell 层本就安全）
  const safePath = JSON.stringify(remotePath)

  // Python 脚本 - 会用 base64 编码传输
  const pythonCode = `
import socket
import os
import struct
import sys
import hmac
import time

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
# 仅绑定 127.0.0.1：配合 SSH forwardOut 隧道，避免 0.0.0.0 把传输端口暴露给同网段/同主机其他用户
server.bind(("127.0.0.1", 0))
server.listen(1)
port = server.getsockname()[1]
# 一次性 token：由 server 生成，经 SSH stdout（加密）回传给 Worker；Worker 通过 SSH 隧道回送 token 完成握手，
# 阻断同主机其他用户抢连 127.0.0.1 端口劫持传输（first-connection-wins）
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
        raise TimeoutError("download connection deadline exceeded")
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
try:
    os.unlink(__file__)  # 自删临时脚本，避免 /tmp 残留（脚本已载入内存，删除不影响执行）
except Exception:
    pass
print("===LYSHELL_DONE:" + str(file_size) + "===")
sys.stdout.flush()
`

  // 每次传输用唯一脚本名（scriptId 随机 hex）：并发任务共享 /tmp/nvsh_dl.py 会互相覆盖，
  // 导致 A 执行 B 的脚本（把 B 的远端文件写到 A 的本地路径）。
  // trap EXIT 清理脚本：Python 不存在 / forwarding 禁用 / 超时 / 取消时也删，避免 /tmp 无界残留。
  // Python 成功路径的 os.unlink(__file__) 提前删，trap 的 rm -f 幂等兜底。
  const pythonScript = `_NVSH_DL=/tmp/nvsh_dl_${scriptId}.py
trap 'rm -f "$_NVSH_DL"' EXIT
cat > "$_NVSH_DL" << 'ENDSCRIPT'
${pythonCode}
ENDSCRIPT
python3 "$_NVSH_DL" || python "$_NVSH_DL" || echo "PYTHON_FAILED"`

  // 超时保护：在启动 shell/exec 前初始化，所有失败与成功路径统一清理。
  const timeout = fileSize > 0 ? 60000 + Math.ceil(fileSize / 1024 / 1024) * 30000 : 30 * 60 * 1000
  const timeoutTimer = setTimeout(() => {
    if (!settled) {
      failDownload(new Error('Download timeout'))
    }
  }, timeout)
  timeoutTimer.unref?.()

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
        failDownload(err, `Shell error: ${err.message}`)
        return
      }

      commandStream = stream
      let shellOutput = ''
      let pythonPort = 0
      let pythonToken = ''
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
            phase = 'connecting'
            connectToPython(pythonPort, pythonToken)
          }
        }

        const doneMatch = shellOutput.match(/===LYSHELL_DONE:(\d+)===/)
        if (doneMatch) {
          log('info', `Python done: ${doneMatch[1]} bytes`)
          remoteDone = true
          finishDownload()
        }
      })

      stream.stderr?.on('data', (data: Buffer) => {
        log('warn', `stderr: ${data.toString().trim()}`)
      })

      stream.on('error', (err: Error) => {
        failDownload(err, `Shell stream error: ${err.message}`)
      })

      stream.on('close', () => {
        clearShellScriptTimer()
        log('info', `Shell closed`)
        finishDownload()
      })

      // 发送进入命令
      for (const cmd of enterCommands) {
        stream.write(`${cmd}\n`)
        log('info', `Sent enter: ${cmd}`)
      }

      // 等待后发送 Python 脚本；失败/关闭/完成时取消，避免向已关闭 stream 写入。
      shellScriptTimer = setTimeout(() => {
        shellScriptTimer = undefined
        if (settled) return
        try {
          stream.write(`${script}\n`)
          log('info', `Sent Python script`)
        } catch (error) {
          failDownload(error as Error, `Shell script write failed: ${(error as Error).message}`)
        }
      }, enterWait)
      shellScriptTimer.unref?.()
    })
  }

  function executeWithExec(client: Client, script: string) {
    client.exec(script, (err: Error | undefined, stream: SSHClientChannel) => {
      if (err) {
        failDownload(err, `Exec error: ${err.message}`)
        return
      }

      commandStream = stream
      let execOutput = ''
      let pythonPort = 0
      let pythonToken = ''
      let phase = 'waiting_port'

      stream.on('data', (data: Buffer) => {
        const output = data.toString()
        execOutput += output

        const trimmed = output.trim()
        if (trimmed.includes('LYSHELL')) {
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

        const doneMatch = execOutput.match(/===LYSHELL_DONE:(\d+)===/)
        if (doneMatch) {
          log('info', `Python done: ${doneMatch[1]} bytes`)
          remoteDone = true
          finishDownload()
        }
      })

      stream.stderr?.on('data', (data: Buffer) => {
        log('warn', `stderr: ${data.toString().trim()}`)
      })

      stream.on('error', (err: Error) => {
        failDownload(err, `Exec stream error: ${err.message}`)
      })

      stream.on('close', () => {
        log('info', `Exec closed`)
        finishDownload()
      })
    })
  }

  function connectToPython(port: number, token: string) {
    log('info', `Opening SSH tunnel to 127.0.0.1:${port} (encrypted, no direct TCP)...`)

    let buf = Buffer.alloc(0)
    let fileNameLen = 0
    let fileName = ''
    let dataPhase = 'waiting_header'
    let streamRef: SSHClientChannel | null = null

    const onStreamData = (data: Buffer) => {
      buf = Buffer.concat([buf, data])

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
            // 0 字节文件：远端不发数据，直接完成，避免落入 Incomplete: 0/0
            if (expectedSize === 0) {
              transferComplete = true
              closeFd()
              sendMessage({
                type: 'progress', taskId, sessionId,
                progress: 100, transferredSize: 0, fileSize: 0,
                speed: 0
              })
              log('info', `Download bytes received: ${fileName} (0 bytes)`)
              streamRef?.destroy()
              // 0 字节同样须收敛：header 走隧道、DONE 走 exec stdout，后者可能先到，
              // 此前 finishDownload 因 !transferComplete && remoteDone 早退；此处补调发出 complete。
              finishDownload()
              dataPhase = 'done'
              break
            }
            dataPhase = 'waiting_data'
            continue
          }
          break  // 数据不足，等待更多
        }

        if (dataPhase === 'waiting_data') {
          if (buf.length > 0) {
            const remaining = expectedSize - transferred
            if (buf.length > remaining) {
              // 正常 server 按 fileSize 精确发送不会超额；超额意味着对端异常/被抢占。只写够 expectedSize，丢弃超额
              log('warn', `[TCP] Received ${buf.length} bytes but only ${remaining} remaining; discarding overflow`)
              buf = buf.subarray(0, remaining)
            }
            fs.writeSync(fd, buf)
            transferred += buf.length
            buf = Buffer.alloc(0)
            sendProgress()

            if (transferred >= expectedSize) {
              dataPhase = 'done'
              transferComplete = true
              closeFd()
              sendMessage({
                type: 'progress', taskId, sessionId,
                progress: 100, transferredSize: transferred, fileSize: expectedSize,
                speed: transferred / ((Date.now() - startTime) / 1000)
              })
              log('info', `Download bytes received: ${fileName} (${transferred} bytes)`)
              streamRef?.destroy()
              // 数据全部到达即收敛：LYSHELL_DONE 走 exec stdout、文件数据走 SSH 隧道，两条流独立。
              // 若 DONE 先到，finishDownload 此前因 !transferComplete 且 remoteDone 早退；
              // 此处补调使其发出 complete，避免 exec close 也早退后最终被超时计时器判定失败。
              finishDownload()
            }
          }
          break
        }

        if (dataPhase === 'done') {
          break
        }
      }
    }

    const onStreamError = (err: Error) => {
      if (transferComplete) return  // 已完成，忽略后续流错误
      failDownload(err, `Transfer failed: ${err.message}`)
    }

    try {
      // 用 SSH direct-tcpip 隧道代替裸 TCP：流量加密 + 绑定 127.0.0.1 + 隧道本身已鉴权。
      // 若服务器禁止 direct-tcpip（AllowTcpForwarding no），forwardOut 回调带 err -- 不降级为明文，直接失败。
      client.forwardOut('', 0, '127.0.0.1', port, (err: Error | undefined, stream: SSHClientChannel) => {
        if (err) {
          const msg = `SSH TCP forwarding failed (${err.message}). The server may disallow direct-tcpip (AllowTcpForwarding no). Enable it or use SFTP.`
          failDownload(new Error(msg), msg)
          return
        }

        streamRef = stream
        log('info', `SSH tunnel established, sending auth token...`)

        stream.on('data', onStreamData)
        stream.on('error', onStreamError)
        stream.on('close', () => { log('info', `Tunnel closed`) })

        // 先发 token 握手，server 校验通过后才开始回传文件数据
        stream.write(Buffer.from(token, 'utf-8'))
      })
    } catch (e: any) {
      // forwardOut 在未连接时同步抛错
      const msg = `SSH TCP forwarding failed (${e.message}).`
      failDownload(e, msg)
    }
  }

  function finishDownload() {
    if (settled) return
    if (!transferComplete) {
      if (remoteDone) return
      const progress = expectedSize > 0 ? Math.round((transferred / expectedSize) * 100) : 0
      const errMsg = `Incomplete: ${transferred}/${expectedSize} (${progress}%)`
      failDownload(new Error(errMsg), errMsg)
      return
    }
    settled = true
    clearShellScriptTimer()
    if (timeoutTimer) clearTimeout(timeoutTimer)
    client.off('error', onExecClientError)
    sendMessage({ type: 'complete', taskId, sessionId, transferredSize: transferred })
    log('info', `Download completed: ${localPath} (${transferred} bytes)`)
    commandStream?.end()
    client.end()
    resolve()
  }

}
