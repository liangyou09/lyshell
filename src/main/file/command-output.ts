import { StringDecoder } from 'string_decoder'
import { OperationError } from '@shared/operation'

/** 命令结果与增量输出共用硬上限；超限失败，不把部分结果伪装成成功。 */
export const MAX_COMMAND_OUTPUT_CHARS = 1024 * 1024

/** 失败时保留的诊断片段上限，避免把预算内的整段结果再次复制进响应。 */
export const MAX_PARTIAL_OUTPUT_CHARS = 4096

export function appendCommandOutput(output: string, chunk: string): string {
  if (chunk.length > MAX_COMMAND_OUTPUT_CHARS - output.length) {
    throw new Error(`Command output limit exceeded (max ${MAX_COMMAND_OUTPUT_CHARS} chars)`)
  }
  return output + chunk
}

/** 输出上限的可识别错误；调用方据此返回 RESOURCE_LIMIT 与 partialOutput。 */
export class CommandOutputLimitError extends OperationError {
  constructor(message: string, readonly partialOutput: string) {
    super('RESOURCE_LIMIT', message, 'never')
    this.name = 'CommandOutputLimitError'
  }
}

export interface CommandOutputCollectorOptions {
  /** 字符上限；默认 MAX_COMMAND_OUTPUT_CHARS。 */
  maxChars?: number
  /** 新增内容的字节增量预留；抛错即触达批次/全局预算。 */
  reserveBytes?: (deltaBytes: number) => void
  /** 增量回调；只在内容通过上限与预算后触发，分片 UTF-8 已解码。 */
  onData?: (chunk: string) => void
}

/**
 * 单条与批量共用的有界收集器。
 *
 * stdout/stderr 用独立 StringDecoder 增量解码，多字节字符跨 chunk 不会被截断。
 * 超限语义：抛出 CommandOutputLimitError（code=RESOURCE_LIMIT），不把部分结果当作完整 output。
 */
export class CommandOutputCollector {
  private readonly maxChars: number
  private readonly stdout = new StringDecoder('utf8')
  private readonly stderr = new StringDecoder('utf8')
  private text = ''
  private bytes = 0
  private publishedChars = 0
  private sanitized = false
  private flushedStdout = false
  private flushedStderr = false

  constructor(private readonly options: CommandOutputCollectorOptions = {}) {
    this.maxChars = options.maxChars ?? MAX_COMMAND_OUTPUT_CHARS
  }

  writeStdout(data: Buffer): void {
    if (this.flushedStdout) return
    this.append(this.stdout.write(data))
  }

  writeStderr(data: Buffer): void {
    if (this.flushedStderr) return
    this.append(this.stderr.write(data))
  }

  endStdout(): void {
    if (this.flushedStdout) return
    this.flushedStdout = true
    this.append(this.stdout.end())
  }

  endStderr(): void {
    if (this.flushedStderr) return
    this.flushedStderr = true
    this.append(this.stderr.end())
  }

  /** 同时冲刷两个解码器；用于执行结束（成功或失败）后的迟到字节。 */
  flush(): void {
    this.endStdout()
    this.endStderr()
  }

  append(chunk: string): void {
    if (!chunk || this.sanitized) return
    if (chunk.length > this.maxChars - this.text.length) {
      this.fail(`Command output limit exceeded (max ${this.maxChars} chars)`)
    }
    const deltaBytes = Buffer.byteLength(chunk, 'utf8')
    if (deltaBytes > 0 && this.options.reserveBytes) {
      try {
        this.options.reserveBytes(deltaBytes)
      } catch (error) {
        if (error instanceof OperationError && error.code === 'RESOURCE_LIMIT') {
          this.fail(error.message)
        }
        throw error
      }
    }
    this.text += chunk
    this.bytes += deltaBytes
    // 触达预算后不再推送增量，避免慢消费者看到已被丢弃的尾部。
    this.options.onData?.(chunk)
    this.publishedChars = this.text.length
  }

  /** 已接收的完整文本；触达上限后不再增长。 */
  get output(): string { return this.text }

  /** 已推送的增量字符数，用于判断流式输出是否完整。 */
  get streamedChars(): number { return this.publishedChars }

  /** 保守的字符串占用估计（UTF-16 码元），不作为 RSS 承诺。 */
  get encodedBytes(): number { return this.bytes }

  get charCount(): number { return this.text.length }

  /**
   * 失败结算后立即释放完整输出占用：partialOutput 已随错误对象带走，
   * 后续迟到分片不再累积，避免预算已归还但大字符串仍驻留。
   */
  discard(): void {
    this.sanitized = true
    this.text = ''
    this.bytes = 0
  }

  /** 失败诊断片段；有界，不冒充完整结果。 */
  get partialOutput(): string {
    return this.text.length <= MAX_PARTIAL_OUTPUT_CHARS
      ? this.text
      : this.text.slice(0, MAX_PARTIAL_OUTPUT_CHARS)
  }

  private fail(message: string): never {
    this.sanitized = true
    throw new CommandOutputLimitError(message, this.partialOutput)
  }
}
