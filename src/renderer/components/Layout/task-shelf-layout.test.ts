import { describe, expect, it } from 'vitest'
import { shelfDocked, shelfPanelWidth, shelfGridLayout, shelfHorizontalLayout, shelfDropEdge, shelfEdge, shelfPanelHeight } from './task-shelf-layout'

describe('任务区按实际窗口空间适配', () => {
  it('横向任务栏先填满每列，再向右扩展；高度不足时只显示方块', () => {
    const tall = shelfHorizontalLayout(1400, 440, 7)
    expect(tall).toMatchObject({ rows: 3, columns: 3, gridWidth: 420, showPreviews: true })
    expect(tall.previewWidth).toBeCloseTo((440 - 64) * 16 / 10)
    const short = shelfHorizontalLayout(1400, 160, 7)
    expect(short).toMatchObject({ rows: 1, columns: 7, showPreviews: false })
    expect(shelfHorizontalLayout(552, 350, 2)).toMatchObject({ rows: 2, columns: 1, previewWidth: 376, previewCardWidth: 378, showPreviews: true })
    expect(shelfHorizontalLayout(552, 220, 2).showPreviews).toBe(false)
    expect(shelfHorizontalLayout(552, 300, 4)).toMatchObject({ rows: 2, columns: 2, gridWidth: 284, showPreviews: false })
    expect(shelfHorizontalLayout(400, 440, 7).showPreviews).toBe(false)
    expect(shelfHorizontalLayout(1400, 0, 0)).toMatchObject({ rows: 1, showPreviews: false })
  })
  it('窗口宽度随横栏可用高度变化，内容区保持 16:10；不足最小可读尺寸时只显示方块', () => {
    const requiredHeight = 64 + 280 * 10 / 16
    expect(shelfHorizontalLayout(1400, requiredHeight, 2).showPreviews).toBe(true)
    expect(shelfHorizontalLayout(1400, requiredHeight - 1, 2).showPreviews).toBe(false)
    expect(shelfHorizontalLayout(1400, 400, 2).previewWidth).toBeGreaterThan(shelfHorizontalLayout(1400, 300, 2).previewWidth)
    expect(shelfHorizontalLayout(552, 400, 2).previewWidth).toBe(376)
  })
  it('网页地址栏单独预留，内容区仍是 16:10 且不超出可用正文', () => {
    // 同等高度下，网页小窗口的内容区宽度更小。
    const web = shelfHorizontalLayout(1400, 440, 2, false, 32)
    const terminal = shelfHorizontalLayout(1400, 440, 2)
    expect(web.previewWidth).toBeCloseTo((440 - 64 - 32) * 16 / 10)
    expect(web.previewWidth).toBeLessThan(terminal.previewWidth)
    expect(web.previewWidth).toBeCloseTo(terminal.previewWidth - 32 * 16 / 10)
    // 最低可见高度：终端 64 + 280*10/16，网页再多出固定地址栏高度。
    expect(web.previewWidth / (16 / 10) + 64 + 32).toBeLessThanOrEqual(440 + 1e-6)
    const terminalMinimum = 64 + 280 * 10 / 16
    const webMinimum = terminalMinimum + 32
    expect(shelfHorizontalLayout(1400, terminalMinimum, 2).showPreviews).toBe(true)
    expect(shelfHorizontalLayout(1400, terminalMinimum - 1, 2).showPreviews).toBe(false)
    expect(shelfHorizontalLayout(1400, webMinimum, 2, false, 32).showPreviews).toBe(true)
    expect(shelfHorizontalLayout(1400, webMinimum - 1, 2, false, 32).showPreviews).toBe(false)
    expect(shelfHorizontalLayout(1400, terminalMinimum, 2, false, 32).showPreviews).toBe(false)
    // 网页窗口的总高度（标题预算 + 地址栏 + 内容区）不超出可用高度。
    for (const height of [280, 300, 440, 600]) {
      const layout = shelfHorizontalLayout(1400, height, 2, false, 32)
      expect(layout.previewWidth / (16 / 10) + 64 + 32).toBeLessThanOrEqual(height + 1e-6)
    }
    // 宽度受限时地址栏不影响列数与方块区宽度，只压缩内容区高度。
    expect(shelfHorizontalLayout(552, 300, 2, false, 32)).toMatchObject({ rows: 2, columns: 1, gridWidth: 148 })
    expect(shelfHorizontalLayout(552, 300, 2, false, 32).previewWidth).toBeCloseTo((300 - 64 - 32) * 16 / 10)
    expect(shelfHorizontalLayout(552, 300, 2, false, 32).previewWidth).toBeLessThan(shelfHorizontalLayout(552, 300, 2).previewWidth)
  })
  it('显式选择横版任务时限制方块区域，为小窗口留出空间', () => {
    expect(shelfHorizontalLayout(552, 300, 4).showPreviews).toBe(false)
    const selected = shelfHorizontalLayout(552, 300, 4, true)
    expect(selected.showPreviews).toBe(true)
    expect(selected.previewWidth).toBeGreaterThanOrEqual(280)
    expect(selected.gridWidth + selected.previewWidth + 28).toBeLessThanOrEqual(552)
    expect(shelfHorizontalLayout(1400, 440, 50, true).showPreviews).toBe(true)
    expect(shelfHorizontalLayout(400, 440, 7, true).showPreviews).toBe(false)
  })
  it('拖高时保留方块行数，窗口仍按当前高度缩放，释放后采用新行数', () => {
    const start = shelfHorizontalLayout(1400, 440, 7, true, 32)
    const dragging = shelfHorizontalLayout(1400, 300, 7, true, 32, start.rows)
    const settled = shelfHorizontalLayout(1400, 300, 7, true, 32)
    expect(dragging.rows).toBe(3)
    expect(dragging.gridWidth).toBe(start.gridWidth)
    expect(dragging.previewWidth).toBeCloseTo((300 - 64 - 32) * 16 / 10)
    expect(dragging.previewWidth).toBeLessThan(start.previewWidth)
    expect(settled.rows).toBe(2)
    expect(settled.gridWidth).toBeGreaterThan(dragging.gridWidth)
  })
  it('仅吸附到有效内容区四边，中央或窗口外不换边', () => {
    const rect = { left: 100, top: 36, width: 1000, height: 700 }
    expect(shelfDropEdge(101, 350, rect)).toBe('left')
    expect(shelfDropEdge(1090, 350, rect)).toBe('right')
    expect(shelfDropEdge(500, 40, rect)).toBe('top')
    expect(shelfDropEdge(500, 730, rect)).toBe('bottom')
    expect(shelfDropEdge(500, 350, rect)).toBeNull()
    expect(shelfDropEdge(500, 20, rect)).toBeNull()
    expect(shelfDropEdge(500, 800, rect)).toBeNull()
    expect(shelfEdge('unknown')).toBe('right')
    expect(shelfPanelHeight(1000, 700)).toBe(455)
    expect(shelfPanelHeight(300, 100)).toBe(65)
  })
  it('任务卡随栏宽适配，宽栏保留可读宽度并限制五列', () => {
    expect(shelfGridLayout(200)).toEqual({ columns: 1 })
    expect(shelfGridLayout(240)).toEqual({ columns: 2 })
    expect(shelfGridLayout(304)).toEqual({ columns: 2 })
    expect(shelfGridLayout(400)).toEqual({ columns: 3 })
    expect(shelfGridLayout(640)).toEqual({ columns: 5 })
    expect(shelfGridLayout(800)).toEqual({ columns: 5 })
  })
  it('带鱼屏大窗口常驻，半屏和大侧栏占用回退悬停', () => {
    expect(shelfDocked('auto', 2400, 2000, 320, false)).toBe(true)
    expect(shelfDocked('auto', 1400, 1200, 320, true)).toBe(false)
    expect(shelfDocked('auto', 2400, 1000, 320, true)).toBe(false)
  })
  it('尊重显式悬停和常驻偏好，但不挤坏小窗口工作区', () => {
    expect(shelfDocked('hover', 3400, 3000, 320, true)).toBe(false)
    expect(shelfDocked('fixed', 1600, 1500, 280, false)).toBe(true)
    expect(shelfDocked('fixed', 1000, 900, 280, true)).toBe(false)
  })
  it('最大宽度随窗口变化且不超过五分之二', () => {
    expect(shelfPanelWidth(1200, 1700, 2000)).toBe(800)
    expect(shelfPanelWidth(1200, 1000, 1200)).toBe(480)
    expect(shelfPanelWidth(1200, 260, 1200)).toBe(228)
    expect(shelfPanelWidth(1200, 400, 500)).toBe(200)
  })
  it('阈值附近保持上次模式并钳制面板宽度', () => {
    expect(shelfDocked('auto', 1760, 1600, 304, true)).toBe(true)
    expect(shelfDocked('auto', 1760, 1600, 304, false)).toBe(false)
    expect(shelfPanelWidth(600, 2000)).toBe(600)
    expect(shelfPanelWidth(900, 2000)).toBe(800)
    expect(shelfPanelWidth(320, 300, 1000)).toBe(268)
  })
})
