import { EventEmitter } from 'events'
import type { FileInfo, TransferProgress, FileConnectorType } from '@shared/types'

/**
 * 文件连接器基类
 * 所有文件连接器（SFTP、Exec）继承此类
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

  /**
   * 执行 shell 命令（可选，仅 Exec 连接器支持）
   */
  exec?(command: string): Promise<string>

  /**
   * 执行命令返回原始输出（可选，用于 MD5 计算）
   */
  execRaw?(command: string, timeout?: number): Promise<string>

  /**
   * 读取文件原始字节（可选，文档预览用）。返回未解码 Buffer，
   * 由调用方按会话编码 iconv.decode —— execRaw 的 utf-8 解码对 GBK 文件有损。
   * encoding 为会话编码：exec 连接的无损 base64 通道不可用时，非 UTF-8 编码
   * 只能走有损 cat 兜底，此时直接抛错而不是回错误内容。
   * 超过 maxSize 抛错（不截断）。
   */
  readFileBytes?(path: string, maxSize: number, encoding?: string): Promise<Buffer>

  /**
   * 流式执行命令（可选）：stdout/stderr 增量通过 onData 回调推送，
   * 最终 resolve { output, exitCode }。用于 MCP execute_command stream 模式。
   * signal 可用于客户端断开时中止执行（best-effort）。
   */
  execStream?(command: string, timeout: number, onData: (chunk: string) => void, signal?: AbortSignal): Promise<{ output: string; exitCode: number }>

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