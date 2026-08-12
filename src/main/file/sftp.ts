import log from 'electron-log'
import { BaseFileConnector } from './base'
import { SSHFileClient } from './ssh-file-client'
import type { FileInfo, TransferProgress } from '@shared/types'
import { FileConnectorType } from '@shared/types'
import type { SFTPWrapper } from '../types/global'
import * as fs from 'fs'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'

/**
 * 递归创建远程目录（mkdir -p 等价）。
 * ssh2 SFTP 无递归 mkdir，逐级创建并忽略"已存在"类错误（与 exec/Python 路径的 os.makedirs 行为对齐）。
 */
async function sftpMkdirP(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
  const norm = remoteDir.replace(/\/+/g, '/').replace(/\/$/, '')
  if (!norm || norm === '/' || norm === '.') return
  const parts = norm.split('/').filter(Boolean)
  let cur = norm.startsWith('/') ? '' : '.'
  for (const part of parts) {
    cur = cur === '' ? `/${part}` : cur === '.' ? part : `${cur}/${part}`
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(cur, (err) => {
        if (!err) return resolve()
        const code = (err as any).code
        if (code !== 4 && !/exist|failure/i.test(err.message)) return reject(err)
        // SSH_FX_FAILURE(4) 含义模糊（也可能是权限不足/父级非目录），仅在目标确为目录时忽略。
        sftp.stat(cur, (statErr, attrs) => {
          if (!statErr && attrs?.isDirectory()) return resolve()
          reject(err)
        })
      })
    })
  }
}

/**
 * SFTP 文件连接器
 * 使用 ssh2 的 SFTP 功能实现文件操作
 * 接收 SSHFileClient，使用独立的 SSH 连接
 */
export class SFTPFileConnector extends BaseFileConnector {
  private sshFileClient: SSHFileClient

  constructor(sessionId: string, sshFileClient: SSHFileClient) {
    super(sessionId, FileConnectorType.SFTP)
    this.sshFileClient = sshFileClient
  }

  /**
   * 执行 shell 命令并返回原始输出（用于 MD5 计算）
   */
  async execRaw(command: string, timeout = 30000): Promise<string> {
    const client = await this.sshFileClient.getClient()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Command timeout after ${timeout}ms`))
      }, timeout)

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          reject(err)
          return
        }

        let output = ''

        stream.on('data', (data: Buffer) => {
          output += data.toString()
        })

        stream.on('close', () => {
          clearTimeout(timer)
          // 只去掉控制字符
          const cleaned = output
            // eslint-disable-next-line no-control-regex
            .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            // eslint-disable-next-line no-control-regex
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
            .trim()
          resolve(cleaned)
        })

        stream.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
      })
    })
  }

  /**
   * 流式执行命令：stdout/stderr 增量推送给 onData，最终返回 { output, exitCode }。
   * output 含 stdout+stderr（与 execRaw 仅 stdout 不同——流式面向 agent，stderr 同样重要）。
   * signal abort 时销毁 stream 以中止执行。
   */
  async execStream(
    command: string,
    timeout: number,
    onData: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<{ output: string; exitCode: number }> {
    const client = await this.sshFileClient.getClient()

    return new Promise((resolve, reject) => {
      let channel: { destroy: () => void } | null = null
      let exitCode = 0

      const timer = setTimeout(() => {
        channel?.destroy()
        reject(new Error(`Command timeout after ${timeout}ms`))
      }, timeout)

      const onAbort = () => {
        channel?.destroy()
        reject(new Error('Command aborted'))
      }
      if (signal) {
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          reject(err)
          return
        }
        channel = stream

        let output = ''
        stream.on('data', (data: Buffer) => {
          const c = data.toString()
          output += c
          onData(c)
        })
        stream.stderr?.on('data', (data: Buffer) => {
          const c = data.toString()
          output += c
          onData(c)
        })
        stream.on('exit', (code: number | null) => {
          if (typeof code === 'number') exitCode = code
        })
        stream.on('close', () => {
          clearTimeout(timer)
          if (signal) signal.removeEventListener('abort', onAbort)
          // 只去掉控制字符（与 execRaw 一致）
          const cleaned = output
            // eslint-disable-next-line no-control-regex
            .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            // eslint-disable-next-line no-control-regex
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
            .trim()
          resolve({ output: cleaned, exitCode })
        })
        stream.on('error', (e: Error) => {
          clearTimeout(timer)
          if (signal) signal.removeEventListener('abort', onAbort)
          reject(e)
        })
      })
    })
  }

  /**
   * 初始化 SFTP 会话
   */
  private async initSFTP(): Promise<SFTPWrapper> {
    return this.sshFileClient.getSFTP()
  }

  /**
   * 测试连接是否可用
   */
  async testConnection(): Promise<boolean> {
    try {
      const sftp = await this.initSFTP()
      // 尝试列出根目录来测试连接
      return new Promise((resolve) => {
        sftp.readdir('/', (err) => {
          if (err) {
            log.warn(`SFTP test failed: ${err.message}`)
            resolve(false)
          } else {
            log.info(`SFTP test passed for session: ${this.sessionId}`)
            resolve(true)
          }
        })
      })
    } catch (error) {
      log.error(`SFTP test error: ${error}`)
      return false
    }
  }

  /**
   * 列出目录内容
   */
  async listDir(dirPath: string): Promise<FileInfo[]> {
    const sftp = await this.initSFTP()

    return new Promise((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) {
          log.error(`SFTP listDir error: ${err.message}`)
          reject(err)
          return
        }

        const files: FileInfo[] = list.map((item) => ({
          name: item.filename,
          path: path.posix.join(dirPath, item.filename),
          isDir: item.attrs.isDirectory(),
          size: item.attrs.size,
          modifyTime: new Date(item.attrs.mtime * 1000),
          permissions: this.formatPermissions(item.attrs.mode),
          owner: item.attrs.uid?.toString(),
          group: item.attrs.gid?.toString()
        }))

        log.debug(`SFTP listed ${files.length} items in ${dirPath}`)
        resolve(files)
      })
    })
  }

  /**
   * 获取文件信息
   */
  async stat(filePath: string): Promise<FileInfo> {
    const sftp = await this.initSFTP()

    return new Promise((resolve, reject) => {
      sftp.stat(filePath, (err, stats) => {
        if (err) {
          log.error(`SFTP stat error: ${err.message}`)
          reject(err)
          return
        }

        const info: FileInfo = {
          name: path.posix.basename(filePath),
          path: filePath,
          isDir: stats.isDirectory(),
          size: stats.size,
          modifyTime: new Date(stats.mtime * 1000),
          permissions: this.formatPermissions(stats.mode),
          owner: stats.uid?.toString(),
          group: stats.gid?.toString()
        }

        resolve(info)
      })
    })
  }

  /**
   * 上传文件 - 使用流式传输避免阻塞主进程
   */
  async upload(
    localPath: string,
    remotePath: string,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<void> {
    const sftp = await this.initSFTP()
    const taskId = uuidv4()

    // 获取本地文件大小
    const localStat = await fs.promises.stat(localPath)
    const fileSize = localStat.size

    log.info(`SFTP upload (stream): ${localPath} -> ${remotePath} (${fileSize} bytes)`)

    // 确保远程父目录存在（与 exec/Python 路径的 os.makedirs 对齐）
    await sftpMkdirP(sftp, path.posix.dirname(remotePath))

    return new Promise((resolve, reject) => {
      let transferred = 0
      const startTime = Date.now()

      // 使用更大的缓冲区
      const readStream = fs.createReadStream(localPath, {
        highWaterMark: 256 * 1024  // 256KB
      })

      const writeStream = sftp.createWriteStream(remotePath)

      // 定时器发送进度，脱离 data 事件
      const progressInterval = setInterval(() => {
        if (transferred > 0 && fileSize > 0) {
          const elapsed = (Date.now() - startTime) / 1000
          const speed = elapsed > 0 ? transferred / elapsed : 0
          const progress: TransferProgress = {
            taskId,
            sessionId: this.sessionId,
            transferredSize: transferred,
            fileSize,
            progress: Math.round((transferred / fileSize) * 100),
            speed
          }
          if (onProgress) onProgress(progress)
          this.emitProgress(progress)
        }
      }, 500)  // 每 500ms 发送一次

      // 错误处理
      const handleError = (err: Error, source: string) => {
        log.error(`SFTP upload ${source} error: ${err.message}`)
        clearInterval(progressInterval)
        readStream.destroy()
        writeStream.destroy()
        reject(err)
      }

      readStream.on('error', (err) => handleError(err, 'read'))
      writeStream.on('error', (err) => handleError(err, 'write'))

      // 手动处理数据流，不使用 pipe
      readStream.on('data', (chunk: string | Buffer) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        transferred += buffer.length
        const canContinue = writeStream.write(buffer)
        if (!canContinue) {
          readStream.pause()
        }
      })

      writeStream.on('drain', () => {
        readStream.resume()
      })

      readStream.on('end', () => {
        clearInterval(progressInterval)
        writeStream.end()
      })

      writeStream.on('close', () => {
        // 发送最终进度
        const elapsed = (Date.now() - startTime) / 1000
        const speed = elapsed > 0 ? transferred / elapsed : 0
        const progress: TransferProgress = {
          taskId,
          sessionId: this.sessionId,
          transferredSize: transferred,
          fileSize,
          progress: 100,
          speed
        }
        if (onProgress) onProgress(progress)
        this.emitProgress(progress)

        log.info(`SFTP upload completed: ${remotePath}`)
        resolve()
      })
    })
  }

  /**
   * 下载文件 - 使用流式传输避免阻塞主进程
   */
  async download(
    remotePath: string,
    localPath: string,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<void> {
    const sftp = await this.initSFTP()
    const taskId = uuidv4()

    // 先获取远程文件大小
    const remoteStat = await this.stat(remotePath)
    const fileSize = remoteStat.size

    log.info(`SFTP download (stream): ${remotePath} -> ${localPath} (${fileSize} bytes)`)

    // 确保本地目录存在
    const localDir = path.dirname(localPath)
    await fs.promises.mkdir(localDir, { recursive: true })

    return new Promise((resolve, reject) => {
      let transferred = 0
      const startTime = Date.now()

      // 使用更大的缓冲区减少事件触发次数
      const readStream = sftp.createReadStream(remotePath, {
        highWaterMark: 256 * 1024  // 256KB
      })

      const writeStream = fs.createWriteStream(localPath, {
        highWaterMark: 256 * 1024
      })

      // 使用定时器发送进度，完全脱离 data 事件
      const progressInterval = setInterval(() => {
        if (transferred > 0 && fileSize > 0) {
          const elapsed = (Date.now() - startTime) / 1000
          const speed = elapsed > 0 ? transferred / elapsed : 0
          const progress: TransferProgress = {
            taskId,
            sessionId: this.sessionId,
            transferredSize: transferred,
            fileSize,
            progress: Math.round((transferred / fileSize) * 100),
            speed
          }
          if (onProgress) onProgress(progress)
          this.emitProgress(progress)
        }
      }, 500)  // 每 500ms 发送一次

      // 错误处理
      const handleError = (err: Error, source: string) => {
        log.error(`SFTP download ${source} error: ${err.message}`)
        clearInterval(progressInterval)
        readStream.destroy()
        writeStream.destroy()
        reject(err)
      }

      readStream.on('error', (err) => handleError(err, 'read'))
      writeStream.on('error', (err) => handleError(err, 'write'))

      // 手动处理数据流，不使用 pipe
      readStream.on('data', (chunk: string | Buffer) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        transferred += buffer.length
        const canContinue = writeStream.write(buffer)
        if (!canContinue) {
          readStream.pause()
        }
      })

      writeStream.on('drain', () => {
        readStream.resume()
      })

      readStream.on('end', () => {
        clearInterval(progressInterval)
        writeStream.end()
      })

      writeStream.on('finish', () => {
        // 发送最终进度
        const elapsed = (Date.now() - startTime) / 1000
        const speed = elapsed > 0 ? transferred / elapsed : 0
        const progress: TransferProgress = {
          taskId,
          sessionId: this.sessionId,
          transferredSize: transferred,
          fileSize,
          progress: 100,
          speed
        }
        if (onProgress) onProgress(progress)
        this.emitProgress(progress)

        log.info(`SFTP download completed: ${localPath}`)
        resolve()
      })
    })
  }

  /**
   * 删除文件或目录
   */
  async delete(targetPath: string): Promise<void> {
    const sftp = await this.initSFTP()

    // 先判断是文件还是目录
    const stat = await this.stat(targetPath)

    return new Promise((resolve, reject) => {
      if (stat.isDir) {
        // 递归删除目录
        this.deleteDirRecursive(sftp, targetPath)
          .then(() => {
            log.info(`SFTP deleted directory: ${targetPath}`)
            resolve()
          })
          .catch(reject)
      } else {
        // 删除文件
        sftp.unlink(targetPath, (err) => {
          if (err) {
            log.error(`SFTP delete file error: ${err.message}`)
            reject(err)
          } else {
            log.info(`SFTP deleted file: ${targetPath}`)
            resolve()
          }
        })
      }
    })
  }

  /**
   * 递归删除目录
   */
  private async deleteDirRecursive(sftp: SFTPWrapper, dirPath: string): Promise<void> {
    // 先列出目录内容
    const files = await this.listDir(dirPath)

    // 删除所有内容
    for (const file of files) {
      if (file.isDir) {
        await this.deleteDirRecursive(sftp, file.path)
      } else {
        await new Promise<void>((resolve, reject) => {
          sftp.unlink(file.path, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      }
    }

    // 删除空目录
    return new Promise<void>((resolve, reject) => {
      sftp.rmdir(dirPath, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  /**
   * 重命名文件或目录
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const sftp = await this.initSFTP()

    return new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => {
        if (err) {
          log.error(`SFTP rename error: ${err.message}`)
          reject(err)
        } else {
          log.info(`SFTP renamed: ${oldPath} -> ${newPath}`)
          resolve()
        }
      })
    })
  }

  /**
   * 创建目录
   */
  async mkdir(dirPath: string): Promise<void> {
    const sftp = await this.initSFTP()

    return new Promise((resolve, reject) => {
      sftp.mkdir(dirPath, (err) => {
        if (err) {
          log.error(`SFTP mkdir error: ${err.message}`)
          reject(err)
        } else {
          log.info(`SFTP created directory: ${dirPath}`)
          resolve()
        }
      })
    })
  }

  /**
   * 格式化权限字符串
   */
  private formatPermissions(mode: number): string {
    const perms: string[] = []
    perms.push(mode & 0o400 ? 'r' : '-')
    perms.push(mode & 0o200 ? 'w' : '-')
    perms.push(mode & 0o100 ? 'x' : '-')
    perms.push(mode & 0o040 ? 'r' : '-')
    perms.push(mode & 0o020 ? 'w' : '-')
    perms.push(mode & 0o010 ? 'x' : '-')
    perms.push(mode & 0o004 ? 'r' : '-')
    perms.push(mode & 0o002 ? 'w' : '-')
    perms.push(mode & 0o001 ? 'x' : '-')
    return perms.join('')
  }
}