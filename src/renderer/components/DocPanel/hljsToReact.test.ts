// @vitest-environment jsdom
/**
 * hljsToReact 测试：语言归一化（alias / 未注册拒绝）与
 * 高亮 HTML → React 节点转换（span 结构保留、纯文本回退）。
 */
import { describe, expect, it } from 'vitest'
import React from 'react'
import { normalizeLang, hljsToReact } from './hljsToReact'

describe('normalizeLang：语言归一化', () => {
  it('注册语言原样（小写化）', () => {
    expect(normalizeLang('Python')).toBe('python')
    expect(normalizeLang('JSON')).toBe('json')
  })

  it('hljs 自带 alias 被接受（原样返回 —— highlight 本身可用 alias 高亮）', () => {
    expect(normalizeLang('sh')).toBe('sh')
    expect(normalizeLang('ts')).toBe('ts')
    expect(normalizeLang('html')).toBe('html')
    expect(normalizeLang('yml')).toBe('yml')
  })

  it('未注册语言返回 null（调用方回退纯文本）', () => {
    expect(normalizeLang('rust')).toBeNull()
    expect(normalizeLang('')).toBeNull()
    expect(normalizeLang(undefined)).toBeNull()
  })
})

describe('hljsToReact：高亮 → React 节点', () => {
  it('960 KiB 与 10 MiB 代码块直接回退单一文本节点', () => {
    for (const code of ['const x = 123;\n'.repeat(65536), 'x'.repeat(10 * 1024 * 1024)]) {
      const result = hljsToReact(code, 'javascript')
      expect(result.ok).toBe(false)
      expect(result.nodes).toEqual([code])
    }
  })

  it('大小门限内节点过多时也回退纯文本', () => {
    const code = 'const x=1;'.repeat(1200)
    expect(hljsToReact(code, 'javascript')).toEqual({ nodes: [code], ok: false })
  })
  it('已知语言：产出带 hljs-* class 的元素树（零 dangerouslySetInnerHTML）', () => {
    const { nodes, ok } = hljsToReact('const x = "hi" // note', 'javascript')
    expect(ok).toBe(true)
    expect(nodes.length).toBeGreaterThan(0)
    const spans = nodes.filter(n => React.isValidElement(n)) as React.ReactElement<{ className?: string }>[]
    expect(spans.length).toBeGreaterThan(0)
    const classes = spans.map(s => s.props.className || '')
    expect(classes.join(' ')).toMatch(/hljs-(keyword|string|comment)/)
  })

  it('代码文本无损（各 token 文本拼回原文）', () => {
    const src = 'def f():\n    return 42'
    const { nodes, ok } = hljsToReact(src, 'python')
    expect(ok).toBe(true)
    const textOf = (n: React.ReactNode): string => {
      if (n == null || typeof n === 'boolean') return ''
      if (typeof n === 'string' || typeof n === 'number') return String(n)
      if (Array.isArray(n)) return n.map(textOf).join('')
      if (React.isValidElement(n)) return textOf((n.props as { children?: React.ReactNode }).children)
      return ''
    }
    expect(textOf(nodes)).toBe(src)
  })

  it('未知语言 / null：回退纯文本节点且 ok=false', () => {
    expect(hljsToReact('plain text', null)).toEqual({ nodes: ['plain text'], ok: false })
    expect(hljsToReact('plain text', 'rust')).toEqual({ nodes: ['plain text'], ok: false })
  })
})
