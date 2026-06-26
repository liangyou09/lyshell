/**
 * 输入文本转义序列解析
 *
 * main 进程（MCP send_input / send_and_wait）与 renderer（快速命令勾选转义）
 * 共用此实现，避免两处逻辑漂移。
 *
 * 支持：
 *   \n    -> 换行 (LF)
 *   \r    -> 回车 (CR)
 *   \t    -> Tab
 *   \xHH  -> 对应字节（如 \x03 = Ctrl+C, \x1b = ESC）
 *
 * 注：仅处理字面的反斜杠转义；textarea 中真实换行（按 Enter 产生）不在此处理范围内。
 */
export function processInputEscapeSequences(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\t/g, '\t')
}
