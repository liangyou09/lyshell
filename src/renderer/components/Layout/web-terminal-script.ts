import { WEB_TERMINAL_MAX_TEXT, isWebTerminalText } from '@shared/web-terminal'
export const WEB_SCRIPT_LIMIT = 65536

/** 保留缩进、空行和反斜线；仅把文件换行统一成逐行输入。 */
export function webTerminalLines(text: string): string[] {
  if (!text || text.length > WEB_SCRIPT_LIMIT || !isWebTerminalText(text)) throw new Error('invalid')
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  // 先验证整个脚本，避免前几行已发送后才在后续行发现非法字符。
  if (lines.some(line => line.length > WEB_TERMINAL_MAX_TEXT || !isWebTerminalText(line))) throw new Error('invalid')
  return lines
}

export function waitWebTerminalDelay(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, delay)
    signal.addEventListener('abort', done, { once: true })
  })
}
