import { EventEmitter } from 'events'
import type { FileInfo, TransferProgress, FileConnectorType } from '@shared/types'

/**
 * 文件连接器基类
 * 内置文件连接器仅支持 SFTP
 */
export abstract class BaseFileConnector extends EventEmitter {
  protected sessionId: string
  protected type: FileConnectorType

  constructor(sessionId: string, type: FileConnectorType) {
    super()
    this.sessionId = sessionId
    this.type = type
  }

  /**
   * 获取会话ID
   */
  getSessionId(): string {
    return this.sessionId
  }

  /**
   * 获取连接器类型
   */
  getType(): FileConnectorType {
    return this.type
  }

  /**
   * 测试连接是否可用
   */
  abstract testConnection(): Promise<boolean>

  /**
   * 列出目录内容
   */
  abstract listDir(path: string): Promise<FileInfo[]>

  /**
   * 获取文件信息
   */
  abstract stat(path: string): Promise<FileInfo>

  /**
   * 上传文件
   * @param localPath 本地文件路径
   * @param remotePath 远程文件路径
   * @param onProgress 进度回调
   */
  abstract upload(
    localPath: string,
    remotePath: string,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<void>

  /**
   * 下载文件
   * @param remotePath 远程文件路径
   * @param localPath 本地文件路径
   * @param onProgress 进度回调
   */
  abstract download(
    remotePath: string,
    localPath: string,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<void>

  /**
   * 删除文件或目录
   */
  abstract delete(path: string): Promise<void>

  /**
   * 重命名文件或目录
   */
  abstract rename(oldPath: string, newPath: string): Promise<void>

  /**
   * 创建目录
   */
  abstract mkdir(path: string): Promise<void>

  abstract realPath(path: string): Promise<string>

  abstract readFileBytes(path: string, maxSize: number): Promise<Buffer>

  /**
   * 发送进度事件
   */
  protected emitProgress(progress: TransferProgress): void {
    this.emit('progress', progress)
  }

  /**
   * 发送错误事件
   */
  protected emitError(error: Error): void {
    this.emit('error', error)
  }
}