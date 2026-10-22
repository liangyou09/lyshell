import { appendCommandOutput } from './command-output'

interface OutputSpan { start: number; length: number }

/** stdout 控制标记单独识别；位置映射到合并输出，保留标记分片间的 stderr。 */
export class ShellCommandOutput {
  private output = ''
  private tail = ''
  private tailSpans: OutputSpan[] = []
  private lineStart = true
  private published = 0
  private readonly prefix: string
  private readonly complete: RegExp

  constructor(marker: string, private readonly onData?: (chunk: string) => void) {
    this.prefix = `${marker}:`
    this.complete = new RegExp(`(?:^|\\n)(${marker}:(\\d{1,10})\\r?\\n)`, 'g')
  }

  stderr(chunk: string): void {
    if (!chunk) return
    this.output = appendCommandOutput(this.output, chunk)
    this.publish(this.tailSpans[0]?.start ?? this.output.length)
  }

  stdout(chunk: string): { output: string; exitCode: number } | undefined {
    if (!chunk) return
    const start = this.output.length
    this.output = appendCommandOutput(this.output, chunk)
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
        parts.push(this.output.slice(cursor, span.start))
        cursor = span.start + span.length
      }
      parts.push(this.output.slice(cursor))
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
    this.publish(this.tailSpans[0]?.start ?? this.output.length)
    return undefined
  }

  private publish(end: number): void {
    if (end <= this.published) return
    const chunk = this.output.slice(this.published, end)
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
