// @vitest-environment jsdom
/**
 * extractHeadings 测试 —— 核心契约：提取结果与 react-markdown 渲染出的 h1..h4
 * 数量/层级/顺序一一对应（OutlineRail scrollspy 按 index 映射 DOM，错位即漂移）。
 * 覆盖 ATX、setext 下划线、以及各类「打断段落」的边界。
 */
import { describe, expect, it } from 'vitest'
import { extractHeadings } from './docHeadings'

describe('extractHeadings：ATX', () => {
  it('提取 1-4 级标题并剥离行内标记', () => {
    const src = [
      '# 一级',
      '## 二级 **加粗**',
      '### 三级 `代码`',
      '#### 四级',
      '##### 五级（超出目录轨范围，不提取）',
      '普通段落'
    ].join('\n')
    expect(extractHeadings(src)).toEqual([
      { level: 1, text: '一级' },
      { level: 2, text: '二级 加粗' },
      { level: 3, text: '三级 代码' },
      { level: 4, text: '四级' }
    ])
  })

  it('缩进 0-3 空间的 ATX 是标题，4 空格缩进不是（缩进代码块）', () => {
    const src = '   ## 三空格缩进\n    ## 四空格缩进'
    expect(extractHeadings(src)).toEqual([{ level: 2, text: '三空格缩进' }])
  })

  it('ATX 收尾 # 序列前须有空白或独占整行：`# C#` 的井号是文本不是收尾序列', () => {
    expect(extractHeadings('# C#\n')).toEqual([{ level: 1, text: 'C#' }])
    expect(extractHeadings('## F# 语言\n')).toEqual([{ level: 2, text: 'F# 语言' }])
    expect(extractHeadings('# foo #\n')).toEqual([{ level: 1, text: 'foo' }])
    expect(extractHeadings('# #\n')).toEqual([{ level: 1, text: '' }])
  })
})

describe('extractHeadings：setext', () => {
  it('=== 下划线 → h1、--- 下划线 → h2（此前整体漏提，目录轨从此错位）', () => {
    const src = ['标题甲', '===', '', '标题乙', '---'].join('\n')
    expect(extractHeadings(src)).toEqual([
      { level: 1, text: '标题甲' },
      { level: 2, text: '标题乙' }
    ])
  })

  it('与 ATX 混排时顺序保持文档序', () => {
    const src = ['顶栏', '===', '', '## 中节', '', '底注', '---'].join('\n')
    expect(extractHeadings(src)).toEqual([
      { level: 1, text: '顶栏' },
      { level: 2, text: '中节' },
      { level: 2, text: '底注' }
    ])
  })

  it('多行段落保留完整文本（与 DOM textContent 逐字一致，含内部换行）', () => {
    const src = ['第一行', '第二行', '==='].join('\n')
    expect(extractHeadings(src)).toEqual([{ level: 1, text: '第一行\n第二行' }])
  })

  it('空行隔开的下划线不是 setext（--- 是主题分隔线）', () => {
    const src = ['段落', '', '---', '', '## 真 标题'].join('\n')
    expect(extractHeadings(src)).toEqual([{ level: 2, text: '真 标题' }])
  })

  it('连续主题分隔线不产生标题（---/--- 是两条分隔线）', () => {
    expect(extractHeadings('---\n---\n***\n___')).toEqual([])
  })

  it('列表 / 引用行打断段落，其后的下划线不构成 setext', () => {
    const src = ['段落', '- 列表项', '---', '', '> 引用行', '---'].join('\n')
    expect(extractHeadings(src)).toEqual([])
  })

  it('下划线允许 0-3 空格缩进，4 空格不算', () => {
    const src = '标题\n   ===\n\n标题2\n    ==='
    expect(extractHeadings(src)).toEqual([{ level: 1, text: '标题' }])
  })
})

describe('extractHeadings：围栏代码块', () => {
  it('围栏内的 # 与下划线不提取；围栏开合行本身打断段落', () => {
    const src = [
      '# 真 标题',
      '```markdown',
      '# 假 标题',
      '假 下划线文本',
      '---',
      '```',
      '---',
      '### 真 标题 二'
    ].join('\n')
    expect(extractHeadings(src)).toEqual([
      { level: 1, text: '真 标题' },
      { level: 3, text: '真 标题 二' }
    ])
  })

  it('波浪线围栏同样生效', () => {
    const src = ['~~~', '# 假 标题', '~~~', '# 真 标题'].join('\n')
    expect(extractHeadings(src)).toEqual([{ level: 1, text: '真 标题' }])
  })

  it('关栏字符须与开栏一致：``` 栏内 ~~~ 是字面量，不关栏', () => {
    const src = ['```', '~~~', '# 栏内假 标题', '```', '', '# 真 标题'].join('\n')
    expect(extractHeadings(src)).toEqual([{ level: 1, text: '真 标题' }])
  })

  it('4 空格缩进的 ``` 不是围栏（缩进代码块），不吞后面的真标题', () => {
    const src = ['    ```js', '# 真 标题', '```', '', '# 第二个'].join('\n')
    // CommonMark：缩进代码块一行即止，# 真 标题 是标题，之后的 ``` 开栏吞掉 # 第二个
    expect(extractHeadings(src)).toEqual([{ level: 1, text: '真 标题' }])
  })
})

describe('extractHeadings：幽灵标题防护（H2 回归）', () => {
  it('五级 ATX（#####）不是段落文本，其后的 --- 不产生幽灵 h2', () => {
    const src = '##### deep heading\n---\n\n# Real\n'
    expect(extractHeadings(src)).toEqual([{ level: 1, text: 'Real' }])
  })

  it('缩进代码块行不是段落文本，其后的 --- 不产生幽灵标题', () => {
    const src = '    code line\n---\n\n# Real\n'
    expect(extractHeadings(src)).toEqual([{ level: 1, text: 'Real' }])
  })

  it('引用/列表段落的惰性延续行不构成顶层 setext 候选', () => {
    const src = ['> 引用行', '惰性延续', '---', '', '# Real'].join('\n')
    expect(extractHeadings(src)).toEqual([{ level: 1, text: 'Real' }])
    const src2 = ['- 列表项', '惰性延续', '---', '', '# Real'].join('\n')
    expect(extractHeadings(src2)).toEqual([{ level: 1, text: 'Real' }])
  })
})

describe('extractHeadings：容器内标题（H4 回归）', () => {
  it('列表/引用内的 ATX 标题同样进 DOM h1-h4，必须提取', () => {
    const src = ['- # Chapter', '', '> # Quoted heading', '', '# Top level'].join('\n')
    expect(extractHeadings(src)).toEqual([
      { level: 1, text: 'Chapter' },
      { level: 1, text: 'Quoted heading' },
      { level: 1, text: 'Top level' }
    ])
  })

  it('嵌套容器标记循环剥净（> - # foo）', () => {
    expect(extractHeadings('> - # Deep\n')).toEqual([{ level: 1, text: 'Deep' }])
  })

  it('非容器行不受剥标记影响：#5 bolt 无空格不是 ATX', () => {
    expect(extractHeadings('#5 bolt\n')).toEqual([])
    // 但它是段落：后跟 --- 时按 CommonMark 渲染成 <h2>，须提取（对齐优先）
    expect(extractHeadings('#5 bolt\n---\n')).toEqual([{ level: 2, text: '#5 bolt' }])
  })
})
