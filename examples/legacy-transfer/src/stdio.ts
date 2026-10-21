import type { Client } from 'ssh2'
import * as fs from 'fs'
import { dirname } from 'path/posix'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import type { LegacyTask, WorkerMessage } from './types'

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

/** Python 流替代旧常驻 JSON Agent；不写入固定 /tmp 脚本，也不隐式回退。 */
export function stdioCommand(task: LegacyTask): string {
  const remote = quote(task.remotePath)
  if (task.method === 'base64') {
    if (task.direction === 'download') return `base64 < ${remote}`
    return `mkdir -p ${quote(dirname(task.remotePath))} && base64 -d > ${remote}`
  }
  const code = task.direction === 'upload'
    ? 'import os,sys,shutil; p=sys.argv[1]; os.makedirs(os.path.dirname(p) or ".",exist_ok=True); f=open(p,"wb"); shutil.copyfileobj(sys.stdin.buffer,f); f.close()'
    : 'import sys,shutil; f=open(sys.argv[1],"rb"); shutil.copyfileobj(f,sys.stdout.buffer); sys.stdout.buffer.flush()'
  return `python3 -c ${quote(code)} ${remote}`
}

/** Base64 按 3/4 字节边界处理，任意 SSH 数据帧切分均不会损坏二进制。 */
export function base64Transform(encode: boolean): Transform {
  let tail = Buffer.alloc(0)
  let ended = false
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const input = encode ? chunk : Buffer.from(chunk.toString('latin1').replace(/[\t\r\n ]/g, ''), 'latin1')
      if (!encode && ((ended && input.length > 0) || !/^[A-Za-z0-9+/=]*$/.test(input.toString('latin1')))) {
        callback(new Error('Invalid base64 stream')); return
      }
      const data = Buffer.concat([tail, input])
      const length = data.length - data.length % (encode ? 3 : 4)
      tail = data.subarray(length)
      try {
        if (length) {
          const block = data.subarray(0, length)
          if (!encode) {
            const text = block.toString('latin1')
            if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('Invalid base64 stream')
            ended = text.includes('=')
            if (ended && tail.length) throw new Error('Invalid base64 stream')
          }
          this.push(encode ? block.toString('base64') : Buffer.from(block.toString('latin1'), 'base64'))
        }
        callback()
      } catch (error) { callback(error as Error) }
    },
    flush(callback) {
      if (!encode && tail.length) { callback(new Error('Truncated base64 stream')); return }
      if (tail.length) this.push(tail.toString('base64'))
      callback()
    }
  })
}

export async function transferStdio(client: Client, task: LegacyTask, send: (msg: WorkerMessage) => void): Promise<void> {
  const channel = await new Promise<import('ssh2').ClientChannel>((resolve, reject) => {
    client.exec(stdioCommand(task), (error, stream) => error ? reject(error) : resolve(stream))
  })
  const started = Date.now()
  let transferred = 0
  let stderr = ''
  channel.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096) })
  const closed = new Promise<void>((resolve, reject) => {
    let code: number | undefined
    channel.on('exit', (value: number) => { code = value })
    channel.on('close', () => code === 0 ? resolve() : reject(new Error(stderr.trim() || `Remote command failed (exit ${code ?? 'unknown'})`)))
    channel.on('error', reject)
  })
  void closed.catch(() => {})
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    transferred += chunk.length
    send({ type: 'progress', transferredSize: transferred, fileSize: task.fileSize,
      progress: task.fileSize ? Math.min(99, Math.round(transferred / task.fileSize * 100)) : 0,
      speed: transferred / Math.max(0.001, (Date.now() - started) / 1000) })
    callback(null, chunk)
  } })
  try {
    if (task.direction === 'upload') {
      // SSH Channel 是双工流，上传也须排空 stdout 才能收到 EOF/close 回执。
      channel.resume()
      const source = fs.createReadStream(task.localPath)
      await (task.method === 'base64'
        ? pipeline(source, meter, base64Transform(true), channel)
        : pipeline(source, meter, channel))
    } else {
      const destination = fs.createWriteStream(task.localPath, { flags: 'wx' })
      await (task.method === 'base64'
        ? pipeline(channel, base64Transform(false), meter, destination)
        : pipeline(channel, meter, destination))
    }
    await closed
    if (task.direction === 'upload' && transferred !== task.fileSize) throw new Error('Local file changed during upload')
    send({ type: 'complete', transferredSize: transferred, progress: 100 })
  } catch (error) {
    channel.destroy()
    throw error
  }
}
