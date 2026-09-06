// @vitest-environment jsdom
/**
 * 刷新钮的可刷新性门禁 —— 内置文档里只有清点页（/ls）是时点快照、刷新有意义；
 * 手册这类随包内容重读无意义，刷新钮按 isDocTabRefreshable 禁用并以 title 说明
 * （此前是静默无操作，会让人怀疑按钮坏了）。远端/本地文档照常可刷。
 * 门槛与 refreshDocTab 的分支同源（readDoc 的 isDocTabRefreshable），此处只断
 * 按钮态与文案，行为面由该函数兜底。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import DocHeader from './DocHeader'
import { BUILTIN_INVENTORY_PATH } from '../../commands/inventory'
import type { DocOverlayPayload } from '@shared/types'

afterEach(cleanup)

const payloadOf = (source: DocOverlayPayload['source'], path: string): DocOverlayPayload => ({
  source, docKind: 'markdown', path, title: 'x', size: 10, mtime: 0, content: 'x'
})

describe('DocHeader：刷新钮可刷新性', () => {
  it('远端 / 本地 / 清点页签：刷新钮可用', () => {
    for (const [source, path] of [
      ['remote', '/srv/a.md'],
      ['local', 'C:\\docs\\a.md'],
      ['builtin', BUILTIN_INVENTORY_PATH]
    ] as const) {
      render(<DocHeader id="doc-1" payload={payloadOf(source, path)} hasHeadings={false} onClose={() => {}} />)
      const btn = screen.getByTitle('Refresh') as HTMLButtonElement
      expect(btn.disabled).toBe(false)
      cleanup()
    }
  })

  it('内置手册页签：刷新钮禁用，title 说明无需刷新', () => {
    render(
      <DocHeader id="doc-1" payload={payloadOf('builtin', 'lyshell://help.md')} hasHeadings={false} onClose={() => {}} />
    )
    const btn = screen.getByTitle(/nothing to refresh/i) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})
