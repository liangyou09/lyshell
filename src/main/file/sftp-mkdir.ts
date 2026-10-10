import { posix } from 'path'

interface DirectoryStats {
  isDirectory(): boolean
}

interface SFTPDirectoryClient {
  stat(path: string, callback: (err: Error | undefined, stats: DirectoryStats) => void): void
  mkdir(path: string, callback: (err: Error | undefined) => void): void
}

/**
 * 仅创建缺失的父目录。已有目录先 stat，避免对 Windows 的 /D: 盘符根目录
 * 或无权创建子目录的上级执行 mkdir，导致可写目标被误报 Permission denied。
 */
export async function sftpMkdirP(sftp: SFTPDirectoryClient, remoteDir: string): Promise<void> {
  // 不折叠 ..：远端符号链接后的 .. 由服务端解析，本地 normalize 会改变目标。
  const dir = remoteDir.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
  if (dir === '/' || dir === '.') return

  const directoryExists = () => new Promise<boolean>((resolve, reject) => {
    sftp.stat(dir, (err, attrs) => {
      if (err) {
        // SSH_FX_NO_SUCH_FILE(2) 才允许尝试创建；权限等错误保留原始原因。
        if ((err as Error & { code?: number }).code === 2) resolve(false)
        else reject(err)
      } else if (attrs.isDirectory()) {
        resolve(true)
      } else {
        reject(new Error(`Remote path is not a directory: ${dir}`))
      }
    })
  })

  if (await directoryExists()) return
  await sftpMkdirP(sftp, posix.dirname(dir))

  await new Promise<void>((resolve, reject) => {
    sftp.mkdir(dir, (err) => {
      if (!err) {
        resolve()
        return
      }
      // 另一个上传可能在 stat 后创建了目录；只在确认目录存在时忽略错误。
      directoryExists().then(exists => {
        if (exists) resolve()
        else reject(err)
      }, () => reject(err))
    })
  })
}
