import { searchText } from './text-search'
import { runBoundedRegex } from './regex-search-client'
export interface TextSearchOptions {
  caseSensitive: boolean
  regex: boolean
  wholeWord: boolean
}

export const DOM_MATCH_LIMIT = 1000

/** 查找阅读文本，保留跨 inline 节点的匹配，不改写 React 管理的 DOM。 */
export async function findTextRanges(root: HTMLElement, query: string, options: TextSearchOptions, signal?: AbortSignal): Promise<{ ranges: Range[]; truncated: boolean }> {
  if (!query) return { ranges: [], truncated: false }
  if (query.length > 4096) throw new Error('Search query limit exceeded')
  const doc = root.ownerDocument
  const win = doc.defaultView!
  const walker = doc.createTreeWalker(root, 5) // SHOW_ELEMENT | SHOW_TEXT
  const segments: { node: Text; start: number; end: number }[] = []
  let text = ''
  let lastBlock: Element | null = null
  let truncated = false
  let yieldAt = performance.now() + 8
  let visitedNodes = 0
  while (walker.nextNode()) {
    if (signal?.aborted) throw new Error('Search cancelled')
    if (++visitedNodes > 20000 || text.length > 2 * 1024 * 1024) throw new Error('Search content limit exceeded')
    // DOM 收集按片让出 UI；慢机器上的合法小文档不因冷启动耗时被误判为超限。
    if (performance.now() >= yieldAt) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      if (signal?.aborted) throw new Error('Search cancelled')
      yieldAt = performance.now() + 8
    }
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
    if (node.data.length > 2 * 1024 * 1024 - text.length) throw new Error('Search content limit exceeded')
    if (segments.length && block !== lastBlock) text += '\n'
    lastBlock = block
    const start = text.length
    text += node.data
    segments.push({ node, start, end: text.length })
  }
  const result = options.regex
    ? await runBoundedRegex(text, query, options, signal)
    : searchText(text, query, options)
  if (signal?.aborted) throw new Error('Search cancelled')
  truncated = result.truncated
  const ranges: Range[] = []
  let cursor = 0
  for (const [start, end] of result.matches) {
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
