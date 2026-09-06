// @vitest-environment jsdom
/**
 * 文档动作链接的渲染层回归守卫 —— react-markdown v9 对链接 href 先过
 * defaultUrlTransform（协议白名单 http/https/mailto 等），白名单外的
 * lyshell-action:// 会被清成空串，动作链接变成失效锚点（点击无任何反应）。
 * 单测此前只测 docActionFromHref 纯函数、不渲染 react-markdown，故漏过这条链。
 * 这里用生产同款 urlTransform 真渲染一遍，断言 href 全须全尾落地（仅内置
 * 文档放行该 scheme）；同时守住净化面没有被顺带放开（javascript: 仍被清空、
 * https/相对路径照常，非内置来源的动作 scheme 同样被清空）。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { docUrlTransform } from './MarkdownDoc'

afterEach(cleanup)

/** 以生产同款配置渲染一段 markdown，取渲染后第一个 a 的 href */
const renderedHref = (markdown: string, allowActionScheme: boolean): string | null => {
  const { container } = render(
    <ReactMarkdown urlTransform={(url) => docUrlTransform(url, allowActionScheme)}>{markdown}</ReactMarkdown>
  )
  return container.querySelector('a')?.getAttribute('href') ?? null
}

describe('docUrlTransform：lyshell-action:// 放行守卫', () => {
  it('内置文档动作链接 href 原样落地（含查询参数；默认净化会清空它 —— 这正是本守卫存在的原因）', () => {
    // 前置事实：默认净化确实剥离本 scheme（若 react-markdown 升级后行为有变，此断言会提醒重估包装层）
    expect(defaultUrlTransform('lyshell-action://open-session?id=s1')).toBe('')
    expect(renderedHref('[prod](lyshell-action://open-session?id=s1)', true)).toBe(
      'lyshell-action://open-session?id=s1'
    )
    expect(renderedHref('[新建](lyshell-action://new-agent)', true)).toBe('lyshell-action://new-agent')
  })

  it('非内置来源不放行：同一 scheme 走默认净化被清空（门禁在净化层，href 不落地）', () => {
    expect(docUrlTransform('lyshell-action://new-agent', false)).toBe('')
    expect(renderedHref('[prod](lyshell-action://open-session?id=s1)', false)).toBe('')
  })

  it('净化面未放开：javascript: 仍被清空，https 与相对路径照常通过', () => {
    expect(docUrlTransform('javascript:alert(1)', true)).toBe('')
    expect(docUrlTransform('https://example.com/a?b=1', true)).toBe('https://example.com/a?b=1')
    expect(docUrlTransform('./manual.en-US.md', false)).toBe('./manual.en-US.md')
    expect(docUrlTransform('#anchor', false)).toBe('#anchor')
    // 相对文档链接是清点/手册里动作链接之外唯一的 href 形态，走默认链不受影响
    expect(renderedHref('[next](./usage.md)', false)).toBe('./usage.md')
  })
})
