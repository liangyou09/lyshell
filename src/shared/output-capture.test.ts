import { describe, it, expect } from 'vitest'
import { createOutputCapture, OUTPUT_CAPTURE_LIMIT } from './output-capture'

const MARKER = '\n[LyShell] 输出超过 1MB,结果已截断'

describe('createOutputCapture', () => {
  it('不超限时原样累积', () => {
    const cap = createOutputCapture()
    cap.push('hello')
    cap.push(' world')
    expect(cap.text()).toBe('hello world')
  })

  it('跨过上限的当次数据块即追加截断标记（最后一个数据块恰好跨限也必有提示）', () => {
    const cap = createOutputCapture()
    cap.push('x'.repeat(OUTPUT_CAPTURE_LIMIT - 1))
    cap.push('y'.repeat(10)) // 最后一块,跨过上限
    expect(cap.text()).toHaveLength(OUTPUT_CAPTURE_LIMIT + MARKER.length)
    expect(cap.text()).toContain('结果已截断')
    expect((cap.text().match(/结果已截断/g) ?? []).length).toBe(1) // 标记只追加一次
  })

  it('恰好填满上限不标记,后续数据被丢弃时才标记', () => {
    const cap = createOutputCapture()
    cap.push('x'.repeat(OUTPUT_CAPTURE_LIMIT)) // 恰好填满,无截断发生
    expect(cap.text()).not.toContain('结果已截断')
    cap.push('more') // 被丢弃,标记
    expect(cap.text()).toContain('结果已截断')
    expect(cap.text()).not.toContain('more')
  })

  it('超限后继续 push 不再重复标记', () => {
    const cap = createOutputCapture()
    cap.push('x'.repeat(OUTPUT_CAPTURE_LIMIT + 5))
    cap.push('more')
    cap.push('even more')
    expect((cap.text().match(/结果已截断/g) ?? []).length).toBe(1)
  })
})
