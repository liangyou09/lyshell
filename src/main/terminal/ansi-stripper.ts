/* eslint-disable no-control-regex */
/**
 * ANSI 转义序列清洗工具
 * 将终端原始输出（含 ANSI 转义、控制字符）转换为可读的纯文本
 */

/**
 * CSI 序列：\x1b[ 后跟参数和终止字节（0x40–0x7E）
 * 涵盖颜色、光标移动、清屏、滚动等；终止字节包括字母及 ~ ` @ 等
 */
const CSI_RE = /\x1b\[[0-9;?]*[\x40-\x7e]/g

/**
 * OSC 序列：\x1b] 后跟文本，以 BEL(\x07) 或 ST(\x1b\\) 结束
 * 涵盖窗口标题、超链接等
 */
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/**
 * 其他单字符转义：\x1b 后跟一个 0x40-0x5F 的中间/终止字节
 * 如 \x1b(B（字符集）、\x1b>（数字键盘）、\x1b=（应用键盘）、\x1bD（索引）、\x1bM（反向索引）等
 */
const ESC_SINGLE_RE = /\x1b[\x40-\x5f]/g

/**
 * DCS / SOS / PM / APC 序列：\x1bP / \x1bX / \x1b^ / \x1b_ 开头，以 ST 结束
 */
const DCS_RE = /\x1b[PX^_][^\x1b]*(?:\x1b\\)/g

/**
 * 控制字符（保留 \t \n \r）
 */
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g

/**
 * 剥离 ANSI 转义序列，保留纯文本
 * 仅移除转义码，不处理回车覆盖/退格（由 stripAnsiToText 处理）
 */
export function stripAnsiCodes(input: string): string {
  return input
    .replace(DCS_RE, '')
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(ESC_SINGLE_RE, '')
    .replace(CONTROL_RE, '')
}

/**
 * 处理退格（\b 删除前一个字符）
 * 逐字符处理，\b 时弹出结果末尾字符
 */
function applyBackspaces(input: string): string {
  const out: string[] = []
  for (const ch of input) {
    if (ch === '\b') {
      out.pop()
    } else {
      out.push(ch)
    }
  }
  return out.join('')
}

/**
 * 处理回车（\r 不带 \n 表示覆盖当前行）
 * 终端原始数据中进度条、提示符重绘会使用此特性
 */
function processControlFlow(input: string): string {
  const lines = input.split('\n')
  const result: string[] = []

  for (const line of lines) {
    // 先消除退格，再按 \r 分段模拟逐段覆盖
    const cleaned = applyBackspaces(line)
    const segments = cleaned.split('\r')
    let current = ''

    for (const seg of segments) {
      // \r 后的内容覆盖当前行（终端标准行为）
      if (seg.length >= current.length) {
        current = seg
      } else {
        // 新内容比旧行短，覆盖前半部分，保留后半部分
        current = seg + current.slice(seg.length)
      }
    }

    result.push(current)
  }

  return result.join('\n')
}

/**
 * 折叠多余空行：连续 3+ 空行压缩为 2 空行
 * 去除每行尾部空白
 */
function collapseBlankLines(input: string): string {
  const lines = input.split('\n')
  const result: string[] = []
  let blankCount = 0

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '')
    if (line === '') {
      blankCount++
      if (blankCount <= 2) {
        result.push('')
      }
    } else {
      blankCount = 0
      result.push(line)
    }
  }

  // 去除开头/结尾的空行
  while (result.length > 0 && result[0] === '') result.shift()
  while (result.length > 0 && result[result.length - 1] === '') result.pop()

  return result.join('\n')
}

/**
 * 将终端原始输出转换为可读纯文本
 * 1. 剥离 ANSI 转义码
 * 2. 处理回车覆盖与退格
 * 3. 折叠多余空行、去除尾部空白
 */
export function stripAnsiToText(input: string): string {
  if (!input) return ''
  const noCodes = stripAnsiCodes(input)
  const noControlFlow = processControlFlow(noCodes)
  return collapseBlankLines(noControlFlow)
}
