// @vitest-environment jsdom
/**
 * FileBrowser 筛选框（双开画轴）状态机回归 —— CSS 机械（.scroll-search 纸幅/
 * 辊面/系绳）全在 globals.css 且与「会话搜索框/写轮眼小窗地址栏」同款共用；
 * 这里锁组件侧的常开裁决与结构：纸两半恒相向铺开、正中合缝（open 常挂,
 * 失焦且空也不收卷 —— 搜索/筛选是常在的动作位,与会话搜索框同步撤掉
 * 「失焦且空即收」的双卷态;写轮眼小窗地址栏保留 rolled/open 语义）。
 * 筛选条受 hasFileSession 门控（真机无 SSH 连接时 FileBrowser 整个不挂，
 * 状态机在此锁定）；filterPattern 是受控 prop —— 用状态壳组件走真实的
 * onFilterChange 回路，而不是 mock 直改。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import React, { useState } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FileBrowser from './FileBrowser'
import '../../i18n'

const noop = (): void => {}
const base = {
  files: [
    { name: 'a.log', path: '/a.log', isDir: false, size: 1024, modifyTime: new Date('2026-01-01') },
    { name: 'b.conf', path: '/b.conf', isDir: false, size: 2048, modifyTime: new Date('2026-01-02') }
  ],
  currentPath: '/',
  loading: false,
  hasSession: true,
  sessionId: 's1',
  onEnterDir: vi.fn(),
  onGoUp: noop,
  onDownload: vi.fn(),
  onRefresh: noop
}

/** 受控壳：filterPattern 走真实 setState 回路（组件的开合裁决吃这个 prop） */
const Harness: React.FC<{ initial?: string }> = ({ initial = '' }) => {
  const [pattern, setPattern] = useState(initial)
  return <FileBrowser {...base} filterPattern={pattern} onFilterChange={setPattern} />
}

/** 筛选条的双开画轴 label（点筛选钮展开条带后取） */
const labelOf = (): HTMLLabelElement | null =>
  (screen.queryByPlaceholderText('*.log, *.conf') as HTMLInputElement | null)?.closest('label') ?? null

afterEach(() => cleanup())

describe('FileBrowser 筛选框（双开画轴）', () => {
  it('点筛选钮展开条带：六件机械齐备（纸×2/辊×2/绳×2），autoFocus 落墨即展开', () => {
    render(<Harness />)
    // 未开条带时筛选框不在 DOM
    expect(labelOf()).toBeNull()
    fireEvent.click(screen.getByTitle('Filter files'))
    const label = labelOf()
    expect(label).toBeTruthy()
    expect(label?.className).toContain('scroll-search')
    expect(label?.className).toContain('h-[32px]')   // 条带恒 32px：细棍长 24 上下各留 4px 气
    expect(label?.querySelectorAll('.scroll-search-paper')).toHaveLength(2)
    expect(label?.querySelectorAll('.scroll-search-rod')).toHaveLength(2)
    expect(label?.querySelectorAll('.scroll-search-tie')).toHaveLength(2)
    // 墨的落法：mono、居中、amber 插入符立于合缝（类挂态，具体渲染交给 CSS 族）
    const input = screen.getByPlaceholderText('*.log, *.conf') as HTMLInputElement
    expect(input.className).toContain('scroll-search-input')
    expect(input.className).toContain('text-center')
    expect(input.className).toContain('font-mono')
    expect(input.className).toContain('caret-[var(--amber)]')
    // autoFocus：条带一开输入即持焦 —— 聚焦即展开
    expect(document.activeElement).toBe(input)
    expect(label?.className).toContain('open')
  })

  it('常开裁决：失焦且空也不收卷，有筛/清筛全程恒 open', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTitle('Filter files'))
    const label = labelOf()!
    const input = screen.getByPlaceholderText('*.log, *.conf') as HTMLInputElement
    // 失焦且空 → 恒 open（常开:不随聚焦收放）
    fireEvent.blur(input)
    expect(label.className).toContain('open')
    expect(label.className).not.toContain('rolled')
    // 落墨（受控回路真实走 setState）：仍展开
    fireEvent.change(input, { target: { value: '*.log' } })
    expect(label.className).toContain('open')
    // ✕ 清筛出现在轴外右端；清掉 + 已失焦 → 仍是展开的纸
    fireEvent.click(screen.getByTitle('Clear filter'))
    expect((screen.queryByTitle('Clear filter'))).toBeNull()   // 无筛即隐
    expect(label.className).toContain('open')
    expect(label.className).not.toContain('rolled')
    // 计数徽章常驻轴外（挂筛选条期间）
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('点纸即落墨：label 隐式关联输入（点纸/点辊的点击交由原生 label 语义聚焦）', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTitle('Filter files'))
    const label = labelOf()!
    const input = screen.getByPlaceholderText('*.log, *.conf') as HTMLInputElement
    // 结构契约：input 是 label 的隐式控件（label.control）—— 真浏览器里点纸面/
    // 辊面的 click 冒泡到 label 后由原生激活行为把焦点交给输入。jsdom 不模拟
    // mousedown 聚焦与 label 激活，这里锁关联契约本身（真机点击聚焦由
    // Playwright 探针覆盖）
    expect(label.control).toBe(input)
    // 全套装饰件（纸×2/辊×2/绳×2 span + 绳结里的 SVG×2）都对无障碍树隐身，
    // 不夺输入的语义位 —— 唯一暴露给 a11y 的就是 input 本身
    expect(label.querySelectorAll('[aria-hidden="true"]')).toHaveLength(8)
    expect(input.getAttribute('aria-hidden')).toBeNull()
  })
})
