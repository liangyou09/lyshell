/**
 * 带上限的输出累积器（python execute/runScript 的 stdout/stderr 捕获用）。
 *
 * 失控脚本可短时间产出海量输出，不设限会把主进程内存吃穿。超过上限即截断，
 * 且必须在**发生截断的当次**数据块追加标记 —— 等下一次 data 事件再补是不行的：
 * 最后一个数据块恰好跨过上限时不会再有后续事件，结果会被无提示截断（P2 评审）。
 */
export const OUTPUT_CAPTURE_LIMIT = 1_000_000

const TRUNCATION_MARKER = '\n[LyShell] 输出超过 1MB,结果已截断'

export interface OutputCapture {
  push(s: string): void
  text(): string
}

export function createOutputCapture(): OutputCapture {
  let buf = ''
  let truncated = false
  const mark = (): void => {
    if (!truncated) {
      truncated = true
      buf += TRUNCATION_MARKER
    }
  }
  return {
    push(s: string): void {
      if (buf.length >= OUTPUT_CAPTURE_LIMIT) {
        mark()
        return
      }
      const remaining = OUTPUT_CAPTURE_LIMIT - buf.length
      buf += s.slice(0, remaining)
      // 本次 slice 实际发生截断:当场补标记
      if (s.length > remaining) mark()
    },
    text: () => buf
  }
}
