// @vitest-environment jsdom
/**
 * docHeadings 与 react-markdown 的对齐契约测试 —— 最强锁法：
 * 直接用生产同款渲染器（react-markdown + remark-gfm）把 fixture 渲进 jsdom，
 * 查询 .doc-content h1..h4（OutlineRail scrollspy 的同款查询），与
 * extractHeadings 的结果按 (level, 顺序) 对照。任何一边多提/漏提一个条目，
 * 这里立即红 —— 而不是等用户看到目录轨点错章节。
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { extractHeadings } from './docHeadings'
import type { DocHeading } from './OutlineRail'

const fixtures: Array<{ name: string; src: string }> = [
  {
    name: '纯 ATX 文档',
    src: '# one\n\n## two\n\n### three\n\n#### four\n\n##### five\n\n###### six\n'
  },
  {
    name: 'setext + ATX 混排',
    src: '顶栏\n===\n\n## 中节\n\n底注\n---\n'
  },
  {
    name: '五级标题 + 下划线（幽灵防护）',
    src: '##### deep heading\n---\n\n# Real\n'
  },
  {
    name: '围栏字符不匹配',
    src: '```\n~~~\n# fake heading\n```\n\n# Real\n'
  },
  {
    name: '围栏内标题与下划线',
    src: '# Real\n\n```markdown\n# fake\nunderline text\n---\n```\n\n## Also real\n'
  },
  {
    name: '缩进代码块不产生幽灵',
    src: '    code line\n---\n\n# Real\n'
  },
  {
    name: '列表与引用打断 setext（含惰性延续）',
    src: '段落\n- 列表项\n---\n\n> 引用行\n惰性延续\n---\n\n# Real\n'
  },
  {
    name: '容器内 ATX 标题',
    src: '- # Chapter\n\n> # Quoted heading\n\n# Top level\n'
  },
  {
    name: '主题分隔线不产生幽灵',
    src: '---\n---\n***\n___\n\n# Real\n'
  },
  {
    name: '主题分隔线与 setext 的空行区分',
    src: 'para\n\n---\n\npara2\n---\n'
  },
  {
    name: '容器标记行上开栏（- ```）',
    src: '- ```\n  code\n  ```\n\n# Real heading\n'
  },
  {
    name: '容器标记行上开栏（有序列表波浪栏）',
    src: '1. ~~~\n   code\n   ~~~\n\n# Real\n'
  },
  {
    name: '长栏里的短栏是字面量（关栏长度校验）',
    src: '````\ncode\n```\n\n# Real\n'
  },
  {
    name: '长栏由等长关栏闭合',
    src: '````\ncode\n````\n\n# Real\n'
  },
  {
    name: '空 ATX 标题（裸 #）也占 DOM 位',
    src: '#\n\n# Real\n'
  },
  {
    name: '空 ATX 标题（## 尾空格）',
    src: '## \n\n# Real\n'
  },
  {
    name: '引用内 setext（> Title + > ===）',
    src: '> quoted\n> ===\n\n# Real\n'
  },
  {
    name: '列表项内 setext（缩进下划线）',
    src: '- item\n  text\n  ===\n'
  },
  {
    name: '列表后裸 === 不是标题',
    src: '- item\n===\n'
  },
  {
    name: 'tab 缩进是代码块不是标题',
    src: '\t# Notes\n\n# Real\n'
  },
  {
    name: 'tab 缩进下划线不成 setext',
    src: 'para\n\t===\n'
  },
  {
    name: '容器内开栏随容器隐式关（列表后的顶层标题不丢）',
    src: '# Top\n\n- ```js\n  code\n\n## H2\n\n### H3\n'
  },
  {
    name: '容器内开栏由内容列+缩进关栏闭合（缩进 4 ≥ 内容列）',
    src: '- ```\n    code\n    ```\n\n# Real\n'
  },
  {
    name: 'col-0 关栏关不掉列表内围栏（开出新顶层栏吞掉后续）',
    src: '# H1\n\n- ```js\n  code\n```\n\n## H2\n'
  },
  {
    name: '列表项 setext：缩进到内容列（有序列表双空格 → 内容列 4）',
    src: '1.  item\n    ===\n'
  },
  {
    name: '列表项 setext：tab 缩进（跳到第 4 列）',
    src: '- item\n\t===\n'
  },
  {
    name: '嵌套引用的下划线不归属外层段落（无幽灵）',
    src: '> quoted\n> > ===\n'
  },
  {
    name: '引用内列表段落的下划线不归属（无幽灵）',
    src: '> - item\n> ===\n'
  },
  {
    name: '多行 setext 段落（顶层）',
    src: 'line1\nline2\n===\n'
  },
  {
    name: '多行 setext 段落（引用内）',
    src: '> a\n> b\n> ===\n'
  },
  {
    name: '多行 setext 段落（列表项内）',
    src: '- a\n  b\n  ===\n'
  },
  {
    name: 'ATX 标题文本含尾 #（C#）不被当收尾序列削掉',
    src: '# C#\n\n## F#\n'
  },
  // —— 第八轮 review 锁定的形态（手写状态机曾在此分歧，现由同款解析器构造保证）——
  {
    name: '列表项内无标记开栏 + col-0 关栏（关掉列表后开新顶层栏吞掉后续）',
    src: '- item\n  ```\n  c\n```\n\n## B\n\n### C\n'
  },
  {
    name: '列表项内无标记开栏（真实形态：有序列表 + bash 块 + col-0 关栏）',
    src: '# Setup\n\n1. Install\n\n   ```bash\n   npm i\n```\n\n## Usage\n'
  },
  {
    name: '列表项内无标记开栏 + 深缩进关栏（内容列+2 是合法关栏）',
    src: '- item\n  ```\n  c\n    ```\n\n## B\n\n### C\n'
  },
  {
    name: '有序列表项后低于内容列的下划线不是 setext（无幽灵）',
    src: '1. item\n  ===\n'
  },
  {
    name: '有序列表幽灵压制（复合文档索引不漂移）',
    src: '# A\n\n1. item\n  ===\n\n## B\n\n### C\n'
  },
  {
    name: '两位数有序列表（内容列 4，缩进 3 的下划线不构成 setext）',
    src: '10. item\n   ===\n'
  },
  {
    name: '引用内围栏 + col-0 关栏（关掉引用后开新顶层栏吞掉后续）',
    src: '> ```\n> c\n```\n\n## B\n\n### C\n'
  },
  {
    name: '容器种类切换后候选重建（引用→列表 + 缩进下划线）',
    src: '> q\n- item\n  ===\n'
  },
  {
    name: '容器种类切换后候选重建（列表→引用 + 引用下划线）',
    src: '- i\n> q\n> ===\n'
  },
  {
    name: '引用内列表段落的缩进下划线（嵌套容器 setext）',
    src: '> - item\n>   ===\n'
  },
  {
    name: '引用内列表段落（更深缩进下划线）',
    src: '> - item\n>     ===\n'
  },
  {
    name: '列表内引用段落的引用下划线（反向嵌套）',
    src: '- > item\n  > ===\n'
  },
  {
    name: '列表项内 4 空格延续行不杀下划线（缩进代码不能打断段落）',
    src: '- item\n    code\n  ===\n'
  },
  {
    name: '宽松列表缩进段落 + col-0 下划线（下划线在列表外，无幽灵）',
    src: '- a\n\n  b\n===\n'
  },
  {
    name: '宽松列表缩进段落 + 内容列下划线（列表项内 setext 成立）',
    src: '- a\n\n  b\n  ===\n'
  },
  {
    name: 'tab 展开的列表内容列（-\\t 开栏的内容列是 4，缩进 2 关栏在外）',
    src: '-\t```\n  code\n  ```\n\n# H\n'
  }
]

// 渲染进 .doc-content（与 MarkdownDoc 同款容器类名），查询 h1-h4 的层级序列
const domHeadings = (src: string): DocHeading[] => {
  const { container } = render(
    <div className="doc-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{src}</ReactMarkdown>
    </div>
  )
  return Array.from(container.querySelectorAll('.doc-content h1, .doc-content h2, .doc-content h3, .doc-content h4'))
    .map(el => ({ level: Number(el.tagName.slice(1)), text: (el.textContent || '').trim() }))
}

describe('extractHeadings ↔ react-markdown 对齐', () => {
  for (const { name, src } of fixtures) {
    it(name, () => {
      const ours = extractHeadings(src)
      const dom = domHeadings(src)
      // 层级序列必须逐项相等（scrollspy 按 index 对 index 映射，这是硬契约）
      expect(ours.map(h => h.level)).toEqual(dom.map(h => h.level))
      // 文本近似（setext 多行段落只取末行、空标题文本为空等），只在两侧非空时断言前缀
      for (let i = 0; i < Math.min(ours.length, dom.length); i++) {
        const oursText = ours[i].text.replace(/[*_`~]/g, '').trim()
        if (oursText.length === 0) continue
        expect(dom[i].text.replace(/[*_`~]/g, '').trim().startsWith(oursText.slice(0, 8))).toBe(true)
      }
    })
  }
})
