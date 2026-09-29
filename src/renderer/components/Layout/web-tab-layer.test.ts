// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  collectWebTabEntries,
  webTabWrapperRect,
  WEB_TAB_PLACEHOLDER_ATTR,
  WEB_TAB_WRAPPER_ATTR
} from './WebTabLayer'
import type { OverlayPayload, OverlayRef, PaneLeaf, PaneNode, PaneSplit } from '@shared/types'

const leaf = (id: string, overlays: OverlayRef[] = []): PaneLeaf => ({
  id,
  type: 'leaf',
  sessions: ['terminal-1'],
  activeSessionId: 'terminal-1',
  overlays
})

const split = (id: string, first: PaneNode, second: PaneNode): PaneSplit => ({
  id,
  type: 'split',
  direction: 'horizontal',
  splitRatio: 0.5,
  firstChild: first,
  secondChild: second
})

const webOverlay = (id: string, active = false): OverlayRef => ({ id, kind: 'web', active, slot: null })

const webPayload = (url: string, postToken?: string): OverlayPayload =>
  ({ kind: 'web', url, title: '', ...(postToken ? { postToken } : {}) })

describe('collectWebTabEntries', () => {
  it('按树序收集全部网页页签，携带宿主 pane 与激活态', () => {
    const tree = split('split-1',
      leaf('pane-a', [webOverlay('web-1', true), webOverlay('web-2')]),
      leaf('pane-b', [webOverlay('web-3')])
    )
    const payloads: Record<string, OverlayPayload | undefined> = {
      'web-1': webPayload('https://a.example/1'),
      'web-2': webPayload('https://a.example/2', 'token-2'),
      'web-3': webPayload('https://b.example/3')
    }
    expect(collectWebTabEntries(tree, payloads)).toEqual([
      { id: 'web-1', paneId: 'pane-a', active: true, url: 'https://a.example/1' },
      { id: 'web-2', paneId: 'pane-a', active: false, url: 'https://a.example/2', postToken: 'token-2' },
      { id: 'web-3', paneId: 'pane-b', active: false, url: 'https://b.example/3' }
    ])
  })

  it('跳过非网页种类与缺 payload 的挂载点', () => {
    const tree = leaf('pane-1', [
      { id: '__mcp_audit__', kind: 'mcpAudit', active: true, slot: null },
      webOverlay('web-x'),
      webOverlay('web-ghost')
    ])
    const payloads: Record<string, OverlayPayload | undefined> = {
      __mcp_audit__: { kind: 'mcpAudit' },
      'web-x': webPayload('https://x.example/')
      // web-ghost 无 payload：挂载点与字典瞬态写入非原子，清单侧容忍缺失
    }
    expect(collectWebTabEntries(tree, payloads)).toEqual([
      { id: 'web-x', paneId: 'pane-1', active: false, url: 'https://x.example/' }
    ])
  })

  it('空树 / 空 payload 字典返回空数组', () => {
    expect(collectWebTabEntries(leaf('pane-1'), {})).toEqual([])
  })
})

describe('webTabWrapperRect', () => {
  it('实体矩形 = 占位相对常驻层容器的偏移，宽高原样透传', () => {
    const base = { left: 320, top: 120, width: 1000, height: 700 }
    const placeholder = { left: 480, top: 300, width: 420, height: 260 }
    expect(webTabWrapperRect(base, placeholder)).toEqual({ left: 160, top: 180, width: 420, height: 260 })
  })

  it('占位与容器同点时为 0 偏移（单 pane 铺满）', () => {
    const r = { left: 10, top: 20, width: 800, height: 600 }
    expect(webTabWrapperRect(r, r)).toEqual({ left: 0, top: 0, width: 800, height: 600 })
  })
})

describe('DOM 锚点属性契约', () => {
  // 属性值同时出现在 CSS 选择器与跨文件查询里，锁死字面量防手滑改名漏改
  it('占位与实体属性名固定', () => {
    expect(WEB_TAB_PLACEHOLDER_ATTR).toBe('data-webtab-placeholder')
    expect(WEB_TAB_WRAPPER_ATTR).toBe('data-webtab-wrapper')
  })
})
