/**
 * markdown 标题提取 —— 独立模块而非 MarkdownDoc 内部函数：
 * MarkdownDoc 走 lazy 加载（DocTabOverlay 首开 md 才拉 bundle），
 * 而 DocHeader 需要在文档渲染前就知道「有无标题」（目录轨开关的显隐门控），
 * 因此提取逻辑须可被非 lazy 侧静态引用。
 *
 * 实现直接复用渲染器同款解析器（remark-parse + remark-gfm，与 MarkdownDoc
 * 的 react-markdown 管线共享同一颗 CommonMark 语法树）：提取与渲染对 h1..h4
 * 的一一对应由构造保证 —— 此前手写的逐行状态机在连续 review 轮中暴露出
 * 围栏/容器/setext 的长尾分歧（列表内开栏、有序列表下划线、嵌套容器……），
 * 修复互为回归、不收敛。代价是 micromark 随本模块进入 eager 侧（DocTabOverlay
 * 静态引用），量级几十 KB，换取对齐零漂移。改动仍须过 docHeadings.alignment.test
 * （以生产渲染器为 oracle 的对齐契约 —— 现在锁的是 AST 遍历正确性与未来
 * remark 升级不漂移，而非逐条正则）。
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Content, PhrasingContent, Root } from 'mdast'
import type { DocHeading } from './OutlineRail'

// 与 MarkdownDoc 渲染管线完全同款插件链，保证 tokenization 一致；
// unified 实例可复用，parse 无内部状态
const parser = unified().use(remarkParse).use(remarkGfm)

// 刻意不做缓存：调用方（DocTabOverlay 的 hasHeadings 门控 + MarkdownDoc 的
// 目录轨）各自 useMemo 在 [content] 上，内容只在打开/刷新时变化，且渲染管线
// 本身每次都要全量解析同一份内容 —— 省一次解析是噪音。而任何 src 键控缓存
// 都给调用结构加隐性约束（单槽依赖「成对调用」才省得下来，Map 键是字符串
// 不能进 WeakMap、常驻持有 MB 级文档源会泄漏）。新增调用方无须感知本模块
// 的任何调用约定

/**
 * 行内文本收集：text/inlineCode 取 value；emphasis/strong/link 等容器递归子节点。
 * html 不贡献文本（react-markdown 未开 rehype-raw，行内 html 不进 DOM），
 * image/break 亦无文本。多行 setext 段落的内部换行保留 —— DOM textContent
 * 同样含换行，归一化反而会造成文本比对失配。
 */
const phrasingText = (nodes: ReadonlyArray<PhrasingContent>): string => {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'inlineCode') out += node.value
    else if ('children' in node && node.children) out += phrasingText(node.children)
  }
  return out
}

/** 深度遍历：标题可出现在任意容器（引用/列表项/脚注定义）内，渲染器都会产出 h1-h4 */
const walk = (node: Root | Content, out: DocHeading[]): void => {
  if (node.type === 'heading' && node.depth <= 4) {
    out.push({ level: node.depth, text: phrasingText(node.children) })
  } else if ('children' in node) {
    for (const child of node.children) walk(child, out)
  }
}

/** 从 markdown 源提取标题（1-4 级；ATX/setext/容器内标题均由解析器统一判定） */
export function extractHeadings(src: string): DocHeading[] {
  const headings: DocHeading[] = []
  try {
    walk(parser.parse(src), headings)
  } catch {
    // micromark 对任意输入都不抛；保险起见按无标题处理，不让目录轨拖垮文档面板
  }
  return headings
}
