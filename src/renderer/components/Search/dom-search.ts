export interface TextSearchOptions {
  caseSensitive: boolean
  regex: boolean
  wholeWord: boolean
}

export const DOM_MATCH_LIMIT = 1000

/** 查找阅读文本，保留跨 inline 节点的匹配，不改写 React 管理的 DOM。 */
export function findTextRanges(root: HTMLElement, query: string, options: TextSearchOptions): { ranges: Range[]; truncated: boolean } {
  if (!query) return { ranges: [], truncated: false }
  const doc = root.ownerDocument
  const win = doc.defaultView!
  const walker = doc.createTreeWalker(root, 5) // SHOW_ELEMENT | SHOW_TEXT
  const segments: { node: Text; start: number; end: number }[] = []
  let text = ''
  let lastBlock: Element | null = null
  let truncated = false
  while (walker.nextNode()) {
    if (walker.currentNode.nodeType === 1) {
      if (walker.currentNode.nodeName === 'BR') text += '\n'
      continue
    }
    const node = walker.currentNode as Text
    const parent = node.parentElement
    if (!parent || !node.data || parent.closest('script,style,noscript,textarea,input,select,svg,[hidden],[aria-hidden="true"],[data-search-panel],[data-tab-search-ignore]')) continue
    let element: Element | null = parent
    let block: Element | null = null
    let hidden = false
    while (element) {
      const style = win.getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') { hidden = true; break }
      if (!block && ['block', 'flex', 'grid', 'list-item', 'table-cell', 'table-row'].includes(style.display)) block = element
      if (element === root) break
      element = element.parentElement
    }
    if (hidden) continue
    if (segments.length && block !== lastBlock) text += '\n'
    lastBlock = block
    const start = text.length
    text += node.data
    segments.push({ node, start, end: text.length })
  }
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(source, options.caseSensitive ? 'gu' : 'giu')
  const word = /[\p{L}\p{N}_]/u
  const ranges: Range[] = []
  let match: RegExpExecArray | null
  let cursor = 0
  while ((match = pattern.exec(text))) {
    if (!match[0].length) {
      // 零宽正则不产生可定位结果；按 Unicode 码点推进以免死循环。
      pattern.lastIndex += (text.codePointAt(pattern.lastIndex) ?? 0) > 0xffff ? 2 : 1
      continue
    }
    const start = match.index
    const end = start + match[0].length
    if (options.wholeWord && ((start > 0 && word.test(Array.from(text.slice(Math.max(0, start - 2), start)).pop()!)) || (end < text.length && word.test(String.fromCodePoint(text.codePointAt(end)!))))) continue
    if (ranges.length === DOM_MATCH_LIMIT) { truncated = true; break }
    while (cursor < segments.length && segments[cursor].end <= start) cursor++
    const first = segments[cursor]
    let lastIndex = cursor
    while (lastIndex + 1 < segments.length && segments[lastIndex + 1].start < end) lastIndex++
    const last = segments[lastIndex]
    if (!first || !last) continue
    // 块间换行是逻辑分隔符；不把它当成文本节点中的负偏移。
    if (end <= first.start) continue
    const range = doc.createRange()
    range.setStart(first.node, Math.max(0, start - first.start))
    range.setEnd(last.node, Math.min(last.node.length, end - last.start))
    ranges.push(range)
  }
  return { ranges, truncated }
}
