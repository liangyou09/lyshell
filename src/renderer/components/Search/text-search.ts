import type { TextSearchOptions } from './dom-search'
const DOM_MATCH_LIMIT = 1000
export function searchText(text: string, query: string, options: TextSearchOptions): { matches: Array<[number, number]>; truncated: boolean } {
  if (!query) return { matches: [], truncated: false }
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(source, options.caseSensitive ? 'gu' : 'giu')
  const word = /[\p{L}\p{N}_]/u
  const matches: Array<[number, number]> = []
  let truncated = false
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (!match[0].length) {
      // 零宽正则不产生可定位结果；按 Unicode 码点推进以免死循环。
      pattern.lastIndex += (text.codePointAt(pattern.lastIndex) ?? 0) > 0xffff ? 2 : 1
      continue
    }
    const start = match.index
    const end = start + match[0].length
    if (options.wholeWord && ((start > 0 && word.test(Array.from(text.slice(Math.max(0, start - 2), start)).pop()!)) || (end < text.length && word.test(String.fromCodePoint(text.codePointAt(end)!))))) continue
    if (matches.length === DOM_MATCH_LIMIT) { truncated = true; break }
    matches.push([start, end])
  }
  return { matches, truncated }
}
