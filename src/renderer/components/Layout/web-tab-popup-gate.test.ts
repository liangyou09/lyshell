// @vitest-environment jsdom
/**
 * webview 弹窗转页签的防刷闸测试（纯逻辑，不渲染组件）。
 * 闸的两条规则各自锁行为：
 * 1. 同键去重 —— 同 origin+pathname（剥 query/hash）的弹窗,键册在且页签
 *    还开着 → 丢;页签关了 → 键出册放行（正常重开）。
 * 2. 短窗频控 —— 滚动 5s 窗口内放行超 3 个 → 丢,窗口滑过恢复。
 * 裁决（gateWebTabPopup）与登记（recordWebTabPopup）两相分离:admit 模拟调用方
 * 协议（MainWindow 转发链同款）—— 裁决通过 + openWebTab 挂载成功 → 登记;
 * 只裁决不登记 = openWebTab 失败路径,额度与键册都不记。
 * store 态直接 setState 铺（对齐 pane-store.webtab.test 的纯逻辑套路）,
 * Date.now 用 vi.spyOn 定桩控制窗口滑动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePaneStore } from '../../stores/pane-store'
import { gateWebTabPopup, recordWebTabPopup, resetWebTabPopupGateForTest } from './web-tab-popup-gate'
import type { OverlayPayload, OverlayRef, PaneLeaf, PaneLayout, PaneNode } from '@shared/types'

const leaf = (id: string, overlays: OverlayRef[]): PaneLeaf => ({
  id,
  type: 'leaf',
  sessions: [],
  activeSessionId: null,
  overlays
})
const layoutOf = (root: PaneNode): PaneLayout => ({ root, activePaneId: root.type === 'leaf' ? root.id : '' })

// 铺一个开着的网页页签（url = 打开时地址,nav.url = redirect 落点,任一命中即开着的键）
const setWebTab = (id: string, url: string, navUrl?: string): void => {
  const payload: OverlayPayload = {
    kind: 'web', url, title: 't', ...(navUrl ? { nav: { url: navUrl, canGoBack: false, canGoForward: false, loading: false } } : {})
  }
  usePaneStore.setState({
    layout: layoutOf(leaf('pane-1', [{ id, kind: 'web', active: true, slot: null }])),
    overlayPayloads: { [id]: payload }
  })
}

const clearTabs = (): void => {
  usePaneStore.setState({ layout: layoutOf(leaf('pane-1', [])), overlayPayloads: {} })
}

describe('web-tab-popup-gate', () => {
  let nowMs: number

  beforeEach(() => {
    resetWebTabPopupGateForTest()
    clearTabs()
    nowMs = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 调用方协议（MainWindow 转发链同款）：裁决通过 → openWebTab 成功 → 登记
  const admit = (url: string): boolean => {
    if (!gateWebTabPopup(url)) return false
    recordWebTabPopup(url)
    return true
  }

  it('裁决通过但未登记（openWebTab 失败）:不占键册也不占频控额度', () => {
    expect(gateWebTabPopup('https://www.bytedance.com/x')).toBe(true)
    // 未登记（挂载失败 / URL 最终非法）后同址再弹:仍是首弹 —— 键册与额度都未消耗
    expect(gateWebTabPopup('https://www.bytedance.com/x')).toBe(true)
    // 额度满额:此后仍可连开 3 个不同键,第 4 个才丢
    expect(admit('https://a.example.com/1')).toBe(true)
    expect(admit('https://b.example.com/2')).toBe(true)
    expect(admit('https://c.example.com/3')).toBe(true)
    nowMs += 100
    expect(admit('https://d.example.com/4')).toBe(false)
  })

  it('同键弹窗:页签开着丢(含 query 变体),关了恢复放行', () => {
    expect(admit('https://www.bytedance.com/')).toBe(true)
    setWebTab('wv-1', 'https://www.bytedance.com/')
    // 同键重刷(抖音式无手势重弹)
    expect(admit('https://www.bytedance.com/')).toBe(false)
    // 追踪参数变体同键(origin+pathname 剥 query)
    expect(admit('https://www.bytedance.com/?track=abc123')).toBe(false)
    // 页签关了 → 键出册,允许再开
    clearTabs()
    expect(admit('https://www.bytedance.com/')).toBe(true)
  })

  it('键对账认 redirect 落点:首航键压住,落点键最多多开一个', () => {
    expect(admit('https://sso.douyin.com/login')).toBe(true)
    // 页签被重定向到别处,payload.url 保留首航地址(见 pane-store nav 回写语义)
    // → 首航键的对账不受 redirect 影响,重刷仍被压住
    setWebTab('wv-1', 'https://sso.douyin.com/login', 'https://www.bytedance.com/passport')
    expect(admit('https://sso.douyin.com/login')).toBe(false)
    // 落点键不在弹窗键册,首弹放行;其后的重刷由落点页签(nav.url 对账)压住
    expect(admit('https://www.bytedance.com/passport')).toBe(true)
    expect(admit('https://www.bytedance.com/passport')).toBe(false)
  })

  it('不同键正常放行(用户连点不同链接)', () => {
    setWebTab('wv-1', 'https://example.com/')
    expect(admit('https://a.example.com/x')).toBe(true)
    expect(admit('https://b.example.com/y')).toBe(true)
    expect(admit('https://c.example.com/z')).toBe(true)
  })

  it('短窗频控:5s 内第 4 个不同键丢,窗口滑过恢复', () => {
    expect(admit('https://a.example.com/1')).toBe(true)
    nowMs += 100
    expect(admit('https://b.example.com/2')).toBe(true)
    nowMs += 100
    expect(admit('https://c.example.com/3')).toBe(true)
    nowMs += 100
    // 窗口内已有 3 个,第 4 个丢
    expect(admit('https://d.example.com/4')).toBe(false)
    nowMs += 100
    expect(admit('https://e.example.com/5')).toBe(false)
    // 首个时间戳滑出 5s 窗口 → 恢复放行
    nowMs += 4_700
    expect(admit('https://f.example.com/6')).toBe(true)
  })
})
