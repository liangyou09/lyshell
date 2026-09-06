// @vitest-environment jsdom
/**
 * 动作链接的来源门禁 —— lyshell-action://（/ls 清点文档的「新建/打开」入口）
 * 只对内置文档生效：远程/本地拖入的 md 是外部内容，不得借动作链接触发本应用
 * 的命令动作（open-session 直连、open-agent 启动）。这里真渲染 MarkdownDoc，
 * 门禁是双层的：净化层（docUrlTransform 按 source 决定放行，纯函数面另有
 * urlTransform.test 断言）清空非内置来源的 href，渲染层再守一道。内置来源
 * 照常派发（解析出的动作原样透传），非内置来源里 runDocAction 一次都不该跑
 * —— 它以 mock 替身断言调用与否，真函数的路由副作用另有 doc-actions.test
 * 覆盖。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import MarkdownDoc from './MarkdownDoc'
import { runDocAction } from '../../commands/doc-actions'
import type { DocOverlayPayload } from '@shared/types'

vi.mock('../../commands/doc-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../commands/doc-actions')>()
  return { ...actual, runDocAction: vi.fn() }
})

afterEach(() => {
  cleanup()
  vi.mocked(runDocAction).mockClear()
})

/** 动作链接正文：清点文档「打开既有条目」的原型形态（带查询参数） */
const MD = '[open](lyshell-action://open-session?id=s1)'

const payloadOf = (source: DocOverlayPayload['source']): DocOverlayPayload => ({
  source,
  docKind: 'markdown',
  path: '/srv/notes/x.md',
  title: 'x',
  size: 0,
  mtime: 0,
  content: MD
})

describe('MarkdownDoc：动作链接仅内置文档生效', () => {
  it('内置文档：链接走 doc-actions 派发（解析出的动作原样透传）', () => {
    render(<MarkdownDoc content={MD} payload={payloadOf('builtin')} paneId="pane-1" />)
    fireEvent.click(screen.getByRole('link'))
    expect(runDocAction).toHaveBeenCalledTimes(1)
    expect(runDocAction).toHaveBeenCalledWith({ id: 'open-session', params: { id: 's1' } })
  })

  it('远程 / 本地文档：同一 scheme 被净化层清空、回落只读渲染，点击不触发任何动作', () => {
    for (const source of ['remote', 'local'] as const) {
      const { container, unmount } = render(
        <MarkdownDoc content={MD} payload={payloadOf(source)} paneId="pane-1" />
      )
      // href 被清空后 a 连 link role 都不算了（无有效 href）,按元素直接取
      const link = container.querySelector('a')
      expect(link).not.toBeNull()
      // 双层门禁:净化层已把该 scheme 清空（href 落不了地）,渲染层也没走动作
      // 分支（无 doc-link-file 类）
      expect(link!.getAttribute('href') ?? '').not.toContain('lyshell-action')
      expect(link!.className).not.toContain('doc-link-file')
      fireEvent.click(link!)
      expect(runDocAction).not.toHaveBeenCalled()
      unmount()
    }
  })
})
