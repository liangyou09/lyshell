// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { DOM_MATCH_LIMIT, findTextRanges } from './dom-search'

const options = { caseSensitive: false, regex: false, wholeWord: false }
function find(html: string, query: string, changes = {}) {
  document.body.innerHTML = `<main>${html}</main>`
  return findTextRanges(document.querySelector('main')!, query, { ...options, ...changes })
}
afterEach(() => { document.body.innerHTML = '' })
describe('阅读内容搜索', () => {
  it('匹配跨 inline 元素文本，但不跨段落拼接', () => {
    const result = find('<p>hel<strong>lo</strong> world</p><p>hello</p>', 'hello')
    expect(result.ranges.map(range => range.toString())).toEqual(['hello', 'hello'])
    expect(find('<p>hel</p><p>lo</p>', 'hello').ranges).toHaveLength(0)
  })
  it('排除脚本、表单、隐藏文字和搜索面板', () => {
    const result = find('<p>hello</p><script>hello</script><textarea>hello</textarea><div hidden>hello</div><div style="display:none">hello</div><div data-search-panel>hello</div>', 'hello')
    expect(result.ranges).toHaveLength(1)
  })
  it('块间和 br 的换行可参与匹配，不产生无效 Range 偏移', () => {
    expect(find('<p>one</p><p>two</p>', '\\ntwo', { regex: true }).ranges.map(range => range.toString())).toEqual(['two'])
    expect(find('<p>one<br>two</p>', 'onetwo').ranges).toHaveLength(0)
    expect(find('<p>one<br>two</p>', 'one\\ntwo', { regex: true }).ranges.map(range => range.toString())).toEqual(['onetwo'])
  })
  it('支持字面转义、大小写、正则和 Unicode 全词边界', () => {
    expect(find('<p>a.b axb A.B</p>', 'a.b').ranges).toHaveLength(2)
    expect(find('<p>a.b A.B</p>', 'a.b', { caseSensitive: true }).ranges).toHaveLength(1)
    expect(find('<p>a.b axb A.B</p>', 'a.b', { regex: true }).ranges).toHaveLength(3)
    expect(find('<p>shell shells _shell shell中文 shell</p>', 'shell', { wholeWord: true }).ranges).toHaveLength(2)
  })
  it('匹配结束在连续逻辑换行内时不产生负偏移', () => {
    expect(find('<p>one<br><br>two</p>', 'one\\n', { regex: true }).ranges.map(range => range.toString())).toEqual(['one'])
  })
  it('零宽和无效正则不会挂起遍历', () => {
    expect(find('<p>😀hello</p>', '(?=.)', { regex: true }).ranges).toHaveLength(0)
    expect(() => find('<p>hello</p>', '[', { regex: true })).toThrow()
  })
  it('限制大文档的高亮数量并报告截断', () => {
    const result = find(`<p>${'hello '.repeat(DOM_MATCH_LIMIT + 2)}</p>`, 'hello')
    expect(result.ranges).toHaveLength(DOM_MATCH_LIMIT)
    expect(result.truncated).toBe(true)
  })
})
