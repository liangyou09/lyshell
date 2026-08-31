/**
 * 终端输出内的 http(s) URL 识别 —— 纯函数（link provider 与单测共用）。
 *
 * 与 docLink.ts 的路径识别并排扫描：带协议的 URL 整体归这里（路径正则的
 * lookbehind 已保证 https://…/README.md 不会被截成文档路径，两边无重叠）。
 * 仅认显式 http(s):// 前缀；无协议裸域名维持文档路径的既有取舍不升级
 * （example.com/a.md 仍按相对路径处理）。
 *
 * 边界规则：
 * - URL 主体到首个「空白 / <>"'` / CJK（含全角标点·假名）」为止 —— 终端里
 *   URL 后紧跟中文是常态（`https://a.com详见`），宁可截断也不吞文案；含
 *   raw CJK 的 IRI 路径会被截到 CJK 前，属已知取舍。韩文/西里尔等其它
 *   非 ASCII 文字不在排除类里，会留在 URL 主体内（IRI 合法，浏览器可编码）。
 * - 结尾句读剥离：ASCII `.,;:!?` 循环剥；右括号 `)]}` 仅当 URL 内无对应
 *   左括号时剥（`wiki/Stack_(software)` 的成对括号是合法路径）。
 * - 有效性闸门复用 normalizeWebBarUrl（单一事实源：非 http/https、无
 *   hostname 一律不成链，与网页访问栏口径一致）。
 */
import { normalizeWebBarUrl } from '../../stores/pane-store'

// 主体排除：空白（\s 已含全角空格 U+3000）/ 尖括号引号反引号 /
// CJK 符号与假名(、-ヿ，含全角标点) / CJK 扩展A(㐀-䶿) / CJK 统一汉字(一-鿿) /
// 全角形式(＀-￯，含全角（）！？)
const URL_RE = /https?:\/\/[^\s<>"'`、-ヿ㐀-䶿一-鿿＀-￯]+/gi

/** 尾部句读剥离（规则见文件头注释） */
function stripTrailingPunct(url: string): string {
  const pair: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  let end = url.length
  while (end > 0) {
    const ch = url[end - 1]
    if ('.,;:!?'.includes(ch)) { end--; continue }
    if (ch in pair && !url.slice(0, end).includes(pair[ch])) { end--; continue }
    break
  }
  return url.slice(0, end)
}

/** 一次匹配结果：url 在 text 中的区间 [start, end) 与剥掉尾部句读后的原文 */
export interface UrlMatch {
  start: number
  end: number
  url: string
}

/** 扫描整行文本，返回全部可打开的 http(s) URL 匹配（非重叠，按出现序） */
export function matchHttpUrls(text: string): UrlMatch[] {
  const out: UrlMatch[] = []
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text)) !== null) {
    const url = stripTrailingPunct(m[0])
    // 闸门与网页访问栏同源：剥完句读仍不合法（如裸 https://）不成链
    if (url && normalizeWebBarUrl(url)) {
      out.push({ start: m.index, end: m.index + url.length, url })
    }
  }
  return out
}
