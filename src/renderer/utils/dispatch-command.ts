import type { QuickCommand } from '@shared/types'
import { processInputEscapeSequences } from '@shared/escape-sequences'

/**
 * 快捷命令派发 —— 唯一实现：按 \n 拆行 → 转义解析/trim → 逐行写入 PTY（\r 结尾）。
 *
 * F 键直发（MainWindow 常驻监听）与侧栏面板点击共用；
 * 改派发规则（拆行/转义/结尾符）只改这里，别在调用侧再写一份。
 */
export const dispatchCommand = (cmd: QuickCommand, sessionId: string): void => {
  const lines = cmd.content.split('\n')
  lines.forEach(line => {
    const processed = cmd.escapeSequences ? processInputEscapeSequences(line) : line.trim()
    if (processed) {
      window.electronAPI?.terminalWrite(sessionId, processed + '\r')
    }
  })
}
