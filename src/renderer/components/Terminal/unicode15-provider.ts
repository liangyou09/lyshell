/**
 * 自定义 xterm Unicode 15 宽度表（IUnicodeVersionProvider）。
 *
 * 背景：xterm 5.5.0 只内置 Unicode 6（core）与 Unicode 11（@xterm/addon-unicode11）。
 * Unicode 11 表只覆盖到 Unicode 12 的 emoji，且把「emoji 呈现」符号当 1 格；
 * 而 Claude Code / 现代 string-width 用 emoji-regex + eastasianwidth（Unicode 15.1），
 * 把 emoji 当 2 格。二者对同一字符「占 1 格还是 2 格」判定不同，导致：
 *   每出现一个 Unicode 12+ emoji 或 ⚠️✌️☝️ 这类符号，光标就左偏 1 格，累积成
 *   「行首文字被挤到行尾 / 边框错位」的漂移（raw-mode TUI 尤其明显）。
 *
 * 本 provider 把宽度算法对齐现代 string-width：
 *   控制/格式/组合符/变体选择符/肤色修饰符 → 0
 *   emoji（emoji-regex）或 全角（EAW W/F）          → 2
 *   其余                                          → 1
 *
 * charProperties 的位打包与 shouldJoin 逻辑逐行对齐 @xterm/addon-unicode11 的 UnicodeV11，
 * 避免组合符（音标、ZWJ 序列）回归。
 */
import { eastAsianWidth } from 'eastasianwidth'
import emojiRegex from 'emoji-regex'
import type { IUnicodeVersionProvider } from '@xterm/xterm'

// emoji-regex() 会构造一张庞大的正则，只构造一次，避免逐字符重建。
// 注意：emojiRegex() 默认返回带 g flag 的正则，.test() 会推进 lastIndex，
// 逐字符连续调用会因残留状态错判（交替 true/false）。这里去掉 g，得到无状态正则。
const EMOJI_RE = (() => {
  const re = emojiRegex()
  return new RegExp(re.source, re.flags.replace('g', ''))
})()

// Unicode 组合标记（Mn/Mc/Me）。Chromium 支持 \p{M}，覆盖所有组合符
const COMBINING_RE = /\p{M}/u

/**
 * 零宽字符：除组合符（用 \p{M} 判定）外的格式字符、变体选择符、肤色修饰符、tag 字符。
 * 这些字符本身不推进光标（在终端里表现为 0 列宽）。
 */
function isZeroWidth(cp: number): boolean {
  // C0 控制符（0x00–0x1F）、DEL（0x7F）、C1 控制符（0x80–0x9F）
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return true
  // ZWSP/ZWNJ/ZWJ/LRM/RLM/ALM（U+200B–U+200F）
  if (cp >= 0x200b && cp <= 0x200f) return true
  // 双向控制符（U+202A–U+202E）
  if (cp >= 0x202a && cp <= 0x202e) return true
  // 词连接符 / 不可见运算符 / 双向嵌入（U+2060–U+206F）
  if (cp >= 0x2060 && cp <= 0x206f) return true
  // 变体选择符（U+FE00–U+FE0F，含 VS16）
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true
  // 变体选择符增补（U+E0100–U+E01EF）
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true
  // emoji 肤色修饰符（U+1F3FB–U+1F3FF）
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return true
  // tag 字符（U+E0001、U+E0020–U+E007F）
  if (cp === 0xe0001 || (cp >= 0xe0020 && cp <= 0xe007f)) return true
  return false
}

// 惰性缓存：xterm 在解析热路径上逐码点调用 wcwidth，Map 缓存避免对重复字符重复跑正则
const widthCache = new Map<number, 0 | 1 | 2>()

function computeWidth(cp: number): 0 | 1 | 2 {
  if (isZeroWidth(cp)) return 0
  const ch = String.fromCodePoint(cp)
  if (COMBINING_RE.test(ch)) return 0
  if (EMOJI_RE.test(ch)) return 2
  const w = eastAsianWidth(ch)
  // 仅「宽 W」与「全角 F」占 2 格；歧义 A / 中性 N / 窄 Na / 半角 H 一律按 1 格（终端默认歧义为窄）
  return w === 'W' || w === 'F' ? 2 : 1
}

function wcwidth(cp: number): 0 | 1 | 2 {
  const cached = widthCache.get(cp)
  if (cached !== undefined) return cached
  const width = computeWidth(cp)
  widthCache.set(cp, width)
  return width
}

export const Unicode15Provider: IUnicodeVersionProvider = {
  version: '15',
  wcwidth,

  /**
   * 位打包属性：与 @xterm/addon-unicode11 的 UnicodeV11.charProperties 完全一致。
   *  - width: (value >> 1) & 3
   *  - shouldJoin: value & 1（组合符应合并到前一字符，不单独推进光标）
   */
  charProperties(cp: number, preceding: number): number {
    let width = wcwidth(cp)
    let shouldJoin = width === 0 && preceding !== 0
    if (shouldJoin) {
      const precedingWidth = (preceding >> 1) & 3
      if (precedingWidth === 0) {
        shouldJoin = false
      } else if (precedingWidth > width) {
        width = precedingWidth as 0 | 1 | 2
      }
    }
    // createPropertyValue(0, width, shouldJoin)
    return ((width & 3) << 1) | (shouldJoin ? 1 : 0)
  },
}
