import { CommandOutputCollector } from './command-output'

interface OutputSpan { start: number; length: number }

/** stdout 控制标记单独识别；位置映射到合并输出，保留标记分片间的 stderr。 */
export class ShellCommandOutput {
  private tail = ''
  private tailSpans: OutputSpan[] = []
  private lineStart = true
  private published = 0
  private readonly prefix: string
  private readonly complete: RegExp
  private readonly collector: CommandOutputCollector

  constructor(marker: string, private readonly onData?: (chunk: string) => void, collector?: CommandOutputCollector) {
    this.prefix = `${marker}:`
    this.complete = new RegExp(`(?:^|\\n)(${marker}:(\\d{1,10})\\r?\\n)`, 'g')
    // 标记剥离与位置映射需要完整缓冲，因此 onData 由本类按剥离后的内容推送。
    this.collector = collector ?? new CommandOutputCollector()
  }

  stderr(chunk: string): void {
    if (!chunk) return
    this.collector.append(chunk)
    this.publish(this.tailSpans[0]?.start ?? this.collector.output.length)
  }

  stdout(chunk: string): { output: string; exitCode: number } | undefined {
    if (!chunk) return
    const start = this.collector.output.length
    this.collector.append(chunk)
    const spans = [...this.tailSpans, { start, length: chunk.length }]
    const scan = this.tail + chunk
    const atLineStart = this.tail.length > 0 || this.lineStart
    this.complete.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = this.complete.exec(scan))) {
      if (match.index === 0 && !match[0].startsWith('\n') && !atLineStart) continue
      const markerStart = match.index + match[0].length - match[1].length
      const removed = this.sliceSpans(spans, markerStart, scan.length)
      const parts: string[] = []
      let cursor = 0
      for (const span of removed) {
        parts.push(this.collector.output.slice(cursor, span.start))
        cursor = span.start + span.length
      }
      parts.push(this.collector.output.slice(cursor))
      const output = parts.join('')
      this.onData?.(output.slice(this.published))
      return { output, exitCode: Number(match[2]) }
    }

    const newline = scan.lastIndexOf('\n')
    const candidate = scan.slice(newline + 1)
    const candidateAtLineStart = newline >= 0 || atLineStart
    const partial = candidateAtLineStart && candidate.length > 0 && (
      this.prefix.startsWith(candidate) ||
      (candidate.startsWith(this.prefix) && /^\d{0,10}\r?$/.test(candidate.slice(this.prefix.length)))
    )
    // 仅保护可能成为标记的后缀；最多 prefix + 十位退出码 + CR，片段数同样有界。
    this.tail = partial ? candidate : ''
    this.tailSpans = partial ? this.sliceSpans(spans, scan.length - candidate.length, scan.length) : []
    this.lineStart = chunk.endsWith('\n')
    this.publish(this.tailSpans[0]?.start ?? this.collector.output.length)
    return undefined
  }

  /** 失败后释放完整输出占用；调用方从此不再读取本实例。 */
  discard(): void {
    this.collector.discard()
  }

  private publish(end: number): void {
    if (end <= this.published) return
    const chunk = this.collector.output.slice(this.published, end)
    this.published = end
    this.onData?.(chunk)
  }

  private sliceSpans(spans: readonly OutputSpan[], start: number, end: number): OutputSpan[] {
    const result: OutputSpan[] = []
    let offset = 0
    for (const span of spans) {
      const left = Math.max(0, start - offset)
      const right = Math.min(span.length, end - offset)
      if (right > left) result.push({ start: span.start + left, length: right - left })
      offset += span.length
    }
    return result
  }
}
