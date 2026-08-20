/**
 * 文件传输相关类型定义
 */

/**
 * 文件信息
 */
export interface FileInfo {
  name: string
  path: string
  isDir: boolean
  size: number
  modifyTime: Date
  permissions?: string
  owner?: string
  group?: string
}

/**
 * 传输方向
 */
export enum TransferDirection {
  UPLOAD = 'upload',
  DOWNLOAD = 'download'
}

/**
 * 传输状态
 */
export enum TransferStatus {
  PENDING = 'pending',
  TRANSFERRING = 'transferring',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

/**
 * 传输任务
 */
export interface TransferTask {
  id: string
  sessionId: string
  direction: TransferDirection
  localPath: string
  remotePath: string
  fileName: string
  fileSize: number
  transferredSize: number
  progress: number        // 0-100
  status: TransferStatus
  error?: string
  startTime?: Date
  endTime?: Date
  speed?: number          // bytes/s
  md5?: string            // 文件 MD5（下载完成后计算）
}

/**
 * 传输进度
 */
export interface TransferProgress {
  taskId: string
  sessionId: string
  transferredSize: number
  fileSize: number
  progress: number
  speed: number  // bytes/s
  direction?: 'upload' | 'download'
}

/**
 * 文件连接器类型
 */
export enum FileConnectorType {
  SFTP = 'sftp',
  EXEC = 'exec'
}

/**
 * 文件操作结果
 */
export interface FileOperationResult {
  success: boolean
  error?: string
  data?: unknown
}