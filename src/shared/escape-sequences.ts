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

/**
 * 判断给定字符码是否为"普通可见字符"--即 autoNewline 应当在其后补 \n 的字符。
 *
 * 排除 C0 控制字符（< 0x20，含 \n \r \t 及 \x03/\x1a 等控制序列）与 DEL(0x7f)：
 * 这些末尾本就代表"已提交"或"控制序列"，不应再追加换行。
 */
export function isPrintableTrailingChar(charCode: number): boolean {
  return charCode >= 0x20 && charCode !== 0x7f
}

/**
 * autoNewline：当 enabled 且文本非空、末尾为普通可见字符时，自动补一个 \n。
 *
 * 避免调用方忘记加换行导致命令只回显不执行；末尾已是 \n/\r 或控制序列
 * （Ctrl+C=\x03、Ctrl+Z=\x1a、Tab=\t、ESC=\x1b 等 C0 控制字符 / DEL）时不补。
 *
 * 注：是否启用由调用方决定--MCP 边界层默认 true（opt-in 关闭），核心层默认
 * false（opt-in 开启），故本函数只负责"启用 + 非空后的末字符判定"这一纯逻辑。
 */
export function appendAutoNewline(text: string, enabled: boolean): string {
  if (!enabled || text.length === 0) return text
  const lastChar = text.charCodeAt(text.length - 1)
  return isPrintableTrailingChar(lastChar) ? text + '\n' : text
}
