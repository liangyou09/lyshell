import { EventEmitter } from 'events'
import log from 'electron-log'
import { BaseFileConnector } from './base'
import { SFTPFileConnector } from './sftp'
import { ExecFileConnector } from './exec'
import { SSHFileClient } from './ssh-file-client'
import type { FileInfo, TransferProgress, SSHConfig } from '@shared/types'
import { FileConnectorType } from '@shared/types'

/**
 * 获取 SSH 配置的回调函数类型
 * 返回 SSHConfig 而非 Client，让 FileManager 管理独立连接
 */
export type GetSSHConfigFn = (sessionId: string) => Promise<SSHConfig | null> | SSHConfig | null

/**
 * 文件管理器
 * 管理文件连接器，使用独立的 SSH 连接进行文件传输
 * 与终端 Shell 连接分离，避免传输时阻塞终端
 */
export class FileManager extends EventEmitter {
  private connectors: Map<string, BaseFileConnector> = new Map()
  private sshClients: Map<string, SSHFileClient> = new Map()  // 独立的 SSH 文件传输连接
  private testedSessions: Map<string, boolean> = new Map()  // 记录已测试 SFTP 的 session
  private getSSHConfigFn: GetSSHConfigFn | null = null

  /**
   * 设置获取 SSH 配置的回调函数
   */
  setGetSSHConfigFn(fn: GetSSHConfigFn): void {
    this.getSSHConfigFn = fn
  }

  /**
   * 获取或创建 SSH 文件传输客户端
   */
  private async getSSHClient(sessionId: string): Promise<SSHFileClient> {
    // 检查是否已有客户端
    const existing = this.sshClients.get(sessionId)
    if (existing && existing.isConnected()) {
      log.debug(`Using existing SSHFileClient for session: ${sessionId}`)
      return existing
    }

    // 获取 SSH 配置
    if (!this.getSSHConfigFn) {
      throw new Error('GetSSHConfigFn not set')
    }

    const sshConfig = await this.getSSHConfigFn(sessionId)
    if (!sshConfig) {
      throw new Error(`SSH config not available for session: ${sessionId}`)
    }

    // 创建新的 SSHFileClient
    log.info(`Creating new SSHFileClient for session: ${sessionId}`)
    const sshClient = new SSHFileClient(sessionId, sshConfig)

    // 监听连接事件
    sshClient.on('error', (err) => {
      log.error(`SSHFileClient error for ${sessionId}: ${err.message}`)
    })

    sshClient.on('close', () => {
      log.info(`SSHFileClient closed for ${sessionId}`)
      // 移除客户端，下次使用时会重新创建
      this.sshClients.delete(sessionId)
    })

    this.sshClients.set(sessionId, sshClient)
    return sshClient
  }

  /**
   * 断开指定 session 的 SSH 文件传输连接
   */
  async disconnectSSHClient(sessionId: string): Promise<void> {
    const sshClient = this.sshClients.get(sessionId)
    if (sshClient) {
      await sshClient.disconnect()
      this.sshClients.delete(sessionId)
      log.info(`SSHFileClient disconnected for session: ${sessionId}`)
    }
  }

  /**
   * 获取或创建文件连接器
   * 使用独立的 SSH 连接，自动检测并选择合适的连接方式（SFTP 或 Exec）
   */
  async getConnector(sessionId: string): Promise<BaseFileConnector> {
    // 检查是否已有连接器
    const existing = this.connectors.get(sessionId)
    if (existing) {
      log.debug(`Using existing connector for session: ${sessionId}`)
      return existing
    }

    // 获取独立的 SSH 文件传输客户端
    const sshClient = await this.getSSHClient(sessionId)

    // 检查是否已测试过 SFTP（避免重复测试）
    const alreadyTested = this.testedSessions.get(sessionId)
    if (alreadyTested !== undefined) {
      if (alreadyTested) {
        // 已测试 SFTP 可用，直接创建 SFTP connector
        log.info(`Using cached result: SFTP for session: ${sessionId}`)
        const sftpConnector = new SFTPFileConnector(sessionId, sshClient)
        this.connectors.set(sessionId, sftpConnector)
        this.emit('connector:created', { sessionId, type: FileConnectorType.SFTP })
        return sftpConnector
      } else {
        // 已测试 SFTP 不可用，直接使用 Exec
        log.info(`Using cached result: Exec for session: ${sessionId}`)
        const sshConfig = await this.getSSHConfigFn!(sessionId)
        const execConnector = new ExecFileConnector(
          sessionId,
          sshClient,
          sshConfig?.shellEnterCommands,
          sshConfig?.shellEnterWait
        )
        this.connectors.set(sessionId, execConnector)
        this.emit('connector:created', { sessionId, type: FileConnectorType.EXEC })
        return execConnector
      }
    }

    // 标记为已测试（开始测试）
    this.testedSessions.set(sessionId, false)

    // 尝试 SFTP
    log.info(`Testing SFTP for session: ${sessionId}`)
    const sftpConnector = new SFTPFileConnector(sessionId, sshClient)

    try {
      const sftpAvailable = await sftpConnector.testConnection()

      if (sftpAvailable) {
        log.info(`Using SFTP for session: ${sessionId}`)
        this.testedSessions.set(sessionId, true)
        this.connectors.set(sessionId, sftpConnector)
        this.emit('connector:created', { sessionId, type: FileConnectorType.SFTP })
        return sftpConnector
      }
    } catch (error) {
      log.warn(`SFTP test failed: ${error}`)
    }

    // 回退到 Exec
    log.info(`SFTP not available, using Exec for session: ${sessionId}`)
    const sshConfig = await this.getSSHConfigFn!(sessionId)
    const execConnector = new ExecFileConnector(
      sessionId,
      sshClient,
      sshConfig?.shellEnterCommands,
      sshConfig?.shellEnterWait
    )

    // 预启动 Python agent（后台运行，不阻塞）
    execConnector.preStartAgent().catch(err => {
      log.warn(`Failed to pre-start agent: ${err.message}`)
    })

    this.connectors.set(sessionId, execConnector)
    this.emit('connector:created', { sessionId, type: FileConnectorType.EXEC })
    return execConnector
  }

  /**
   * 获取已存在的连接器（不创建新连接器）
   */
  getExistingConnector(sessionId: string): BaseFileConnector | undefined {
    return this.connectors.get(sessionId)
  }

  /**
   * 获取连接器类型
   */
  async getConnectorType(sessionId: string): Promise<FileConnectorType | null> {
    const connector = await this.getConnector(sessionId)
    return connector.getType()
  }

  /**
   * 移除连接器
   * 在会话断开时调用，清理远程 agent 进程和 SSH 连接
   */
  async removeConnector(sessionId: string): Promise<void> {
    const connector = this.connectors.get(sessionId)
    if (connector && typeof (connector as any).cleanup === 'function') {
      await (connector as any).cleanup()
    }
    this.connectors.delete(sessionId)
    this.testedSessions.delete(sessionId)

    // 断开独立的 SSH 文件传输连接
    await this.disconnectSSHClient(sessionId)

    log.info(`File connector removed for session: ${sessionId}`)
    this.emit('connector:removed', sessionId)
  }

  /**
   * 列出目录内容
   */
  async listDir(sessionId: string, path: string): Promise<FileInfo[]> {
    const connector = await this.getConnector(sessionId)
    return connector.listDir(path)
  }

  /**
   * 获取文件信息
   */
  async stat(sessionId: string, path: string): Promise<FileInfo> {
    const connector = await this.getConnector(sessionId)
    return connector.stat(path)
  }

  /**
   * 上传文件
   */
  async upload(
    sessionId: string,
    localPath: string,
    remotePath: string,
    taskId: string,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<void> {
    const connector = await this.getConnector(sessionId)

    // 包装进度回调，添加 taskId 并发送进度事件
    const progressWrapper = (progress: TransferProgress) => {
      progress.taskId = taskId
      progress.direction = 'upload'
      if (onProgress) onProgress(progress)
      this.emit('transfer:progress', progress)
    }

    await connector.upload(localPath, remotePath, progressWrapper)
    this.emit('transfer:completed', { taskId, sessionId, direction: 'upload' })
  }

  /**
   * 下载文件
   */
  async download(
    sessionId: string,
    remotePath: string,
    localPath: string,
    taskId: string,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<{ md5?: string }> {
    const connector = await this.getConnector(sessionId)

    // 包装进度回调，添加 taskId 并发送进度事件
    const progressWrapper = (progress: TransferProgress) => {
      progress.taskId = taskId
      if (onProgress) onProgress(progress)
      this.emit('transfer:progress', progress)
    }

    await connector.download(remotePath, localPath, progressWrapper)

    // 先发送完成事件（不含 MD5），让 UI 立即响应
    this.emit('transfer:completed', { taskId, sessionId, direction: 'download', md5: undefined })

    // 异步计算 MD5，不阻塞
    this.calculateMD5(localPath).then(md5 => {
      // 发送 MD5 更新事件
      this.emit('transfer:md5', { taskId, sessionId, md5 })
    }).catch(err => {
      log.warn(`Failed to calculate MD5 for ${localPath}:`, err.message)
    })

    return {}
  }

  /**
   * 计算文件 MD5
   */
  private async calculateMD5(filePath: string): Promise<string> {
    const crypto = await import('crypto')
    const fs = await import('fs')

    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5')
      const stream = fs.createReadStream(filePath)

      stream.on('data', (data) => hash.update(data))
      stream.on('end', () => resolve(hash.digest('hex')))
      stream.on('error', reject)
    })
  }

  /**
   * 计算远程文件 MD5（通过 exec 命令）
   */
  async calculateRemoteMD5(sessionId: string, filePath: string): Promise<string> {
    const connector = await this.getConnector(sessionId)

    if (!connector.execRaw) {
      throw new Error('This connector does not support shell commands')
    }

    // 安全引用路径（处理特殊字符）
    const safePath = filePath.includes("'")
      ? `"${filePath}"`  // 路径含单引号时用双引号
      : `'${filePath}'`  // 否则用单引号

    // 直接尝试 md5sum（Linux 常用）
    try {
      const result = await connector.execRaw(`md5sum ${safePath} 2>/dev/null`)
      // 提取 32 位十六进制 hash（md5sum 输出格式: "hash  filename"）
      const match = result.match(/^[a-f0-9]{32}/i) || result.match(/\n[a-f0-9]{32}/i)
      if (match) {
        return match[0].trim()
      }
    } catch {
      // 继续尝试其他方式
    }

    // 尝试 md5 -q（BSD/macOS）
    try {
      const result = await connector.execRaw(`md5 -q ${safePath} 2>/dev/null`)
      const match = result.match(/^[a-f0-9]{32}/i) || result.match(/\n[a-f0-9]{32}/i)
      if (match) {
        return match[0].trim()
      }
    } catch {
      // 继续尝试其他方式
    }

    // 尝试 md5（某些系统）
    try {
      const result = await connector.execRaw(`md5 ${safePath} 2>/dev/null`)
      // MD5 (filename) = hash 格式 或纯 hash
      const match = result.match(/[a-f0-9]{32}/i)
      if (match) {
        return match[0]
      }
    } catch {
      // 所有方式都失败
    }

    throw new Error('Remote system does not have md5sum or md5 command available')
  }

  /**
   * 删除文件或目录
   */
  async delete(sessionId: string, path: string): Promise<void> {
    const connector = await this.getConnector(sessionId)
    return connector.delete(path)
  }

  /**
   * 重命名文件或目录
   */
  async rename(sessionId: string, oldPath: string, newPath: string): Promise<void> {
    const connector = await this.getConnector(sessionId)
    return connector.rename(oldPath, newPath)
  }

  /**
   * 创建目录
   */
  async mkdir(sessionId: string, path: string): Promise<void> {
    const connector = await this.getConnector(sessionId)
    return connector.mkdir(path)
  }
}

// 单例
export const fileManager = new FileManager()