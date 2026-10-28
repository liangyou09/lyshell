import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import {
  paintTerminalPreview,
  type TerminalPreviewMode,
  type TerminalPreviewOptions
} from './task-shelf-terminal-preview'

type FillOp = { kind: 'fill'; style: string; x: number; y: number; w: number; h: number }
type TextOp = { kind: 'text'; style: string; font: string; text: string; x: number; y: number }

interface CellSpec {
  chars?: string
  width?: number
  fg?: number
  bg?: number
  fgMode?: 'default' | 'palette' | 'rgb'
  bgMode?: 'default' | 'palette' | 'rgb'
  inverse?: boolean
  bold?: boolean
  italic?: boolean
  invisible?: boolean
}

const MODE_CODES = { default: 0, palette: 1, rgb: 2 } as const

/** 记录调用的假 2D 上下文：只实现缩略图实际用到的成员。 */
function createContext(measuredWidth = 0) {
  const ops: Array<FillOp | TextOp> = []
  const ctx: Record<string, unknown> = {
    fillStyle: '#000000',
    font: '10px monospace',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    // 默认返回 0，等价于“测量不可用”，让被测代码走字号比例回退。
    measureText: vi.fn(() => ({ width: measuredWidth }))
  }
  ctx.fillRect = vi.fn((x: number, y: number, w: number, h: number) => {
    ops.push({ kind: 'fill', style: String(ctx.fillStyle), x, y, w, h })
  })
  ctx.fillText = vi.fn((text: string, x: number, y: number) => {
    ops.push({ kind: 'text', style: String(ctx.fillStyle), font: String(ctx.font), text, x, y })
  })
  return {
    ctx,
    ops,
    fills: () => ops.filter((op): op is FillOp => op.kind === 'fill'),
    texts: () => ops.filter((op): op is TextOp => op.kind === 'text')
  }
}

function createCell(spec: CellSpec): Record<string, () => unknown> {
  const fgMode = spec.fgMode ?? 'default'
  const bgMode = spec.bgMode ?? 'default'
  return {
    getWidth: () => spec.width ?? 1,
    getChars: () => spec.chars ?? '',
    getCode: () => (spec.chars ?? ' ').codePointAt(0) ?? 0,
    getFgColorMode: () => MODE_CODES[fgMode],
    getBgColorMode: () => MODE_CODES[bgMode],
    getFgColor: () => spec.fg ?? 0,
    getBgColor: () => spec.bg ?? 0,
    isBold: () => (spec.bold ? 1 : 0),
    isItalic: () => (spec.italic ? 1 : 0),
    isDim: () => 0,
    isUnderline: () => 0,
    isBlink: () => 0,
    isInverse: () => (spec.inverse ? 1 : 0),
    isInvisible: () => (spec.invisible ? 1 : 0),
    isStrikethrough: () => 0,
    isOverline: () => 0,
    isFgRGB: () => fgMode === 'rgb',
    isBgRGB: () => bgMode === 'rgb',
    isFgPalette: () => fgMode === 'palette',
    isBgPalette: () => bgMode === 'palette',
    isFgDefault: () => fgMode === 'default',
    isBgDefault: () => bgMode === 'default',
    isAttributeDefault: () => false
  }
}

/** 一行文本按单元格展开（每字符一个单元格）。 */
function row(text: string, spec: CellSpec = {}): CellSpec[] {
  return Array.from(text, (ch) => ({ ...spec, chars: ch }))
}

function createLine(cells: CellSpec[]) {
  const objects = cells.map(createCell)
  return {
    isWrapped: false,
    length: objects.length,
    getCell(x: number, target?: Record<string, () => unknown>) {
      const cell = objects[x]
      if (!cell) return undefined
      // 与 xterm 一致：传入 target 时把数据填入并返回同一个对象。
      return target ? Object.assign(target, cell) : cell
    },
    translateToString: () => cells.map((cell) => cell.chars ?? ' ').join('')
  }
}

/** 完整滚动历史 + baseY，用于验证只读取当前屏幕区域。 */
function createBuffer(history: CellSpec[][], baseY: number, cursorY = 0) {
  const lines = history.map(createLine)
  return {
    type: 'normal' as const,
    cursorY,
    cursorX: 0,
    viewportY: baseY,
    baseY,
    length: lines.length,
    getLine: (y: number) => lines[y],
    getNullCell: () => ({})
  }
}

function createTerminal(config: {
  cols: number
  rows: number
  history: CellSpec[][]
  baseY?: number
  cursorY?: number
  options?: Record<string, unknown>
}) {
  const buffer = createBuffer(config.history, config.baseY ?? 0, config.cursorY ?? 0)
  return {
    cols: config.cols,
    rows: config.rows,
    buffer: { active: buffer, normal: buffer, alternate: buffer, onBufferChange: vi.fn() },
    options: config.options ?? {},
    resize: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    open: vi.fn(),
    dispose: vi.fn(),
    refresh: vi.fn(),
    reset: vi.fn(),
    clear: vi.fn(),
    loadAddon: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() }))
  }
}

function createCanvas(ctx: unknown) {
  let htmlWrites = 0
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn((id: string) => (id === '2d' ? ctx : null))
  }
  Object.defineProperty(canvas, 'innerHTML', {
    configurable: true,
    get: () => '',
    set: () => {
      htmlWrites += 1
    }
  })
  return { canvas, htmlWrites: () => htmlWrites }
}

function asCanvas(canvas: unknown): HTMLCanvasElement {
  return canvas as unknown as HTMLCanvasElement
}

function asTerminal(terminal: unknown): Terminal {
  return terminal as unknown as Terminal
}

/** 默认字号 13 → 单格 8x13。 */
const CELL_W = 8
const CELL_H = 13

describe('paintTerminalPreview', () => {
  it('从 baseY 起绘制当前屏幕，且只画 rows 行', () => {
    const history = [row('OLD-0'), row('OLD-1'), row('LIVE-A'), row('LIVE-B'), row('BOTTOM')]
    const terminal = createTerminal({ cols: 8, rows: 2, history, baseY: 2 })
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(true)

    expect(texts().map((op) => op.text)).toEqual(['LIVE-A', 'LIVE-B'])
    // 行高 13：第 0 行中线 6.5，第 1 行 19.5。
    expect(texts().map((op) => op.y)).toEqual([6.5, 19.5])
    expect(texts().map((op) => op.x)).toEqual([0, 0])
  })

  it('用主题背景铺满虚拟网格，并设置画布固有尺寸', () => {
    const terminal = createTerminal({
      cols: 4,
      rows: 2,
      history: [row('AB')],
      options: { theme: { foreground: '#eeeeee', background: '#101010' } }
    })
    const { ctx, fills } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(true)

    expect(canvas.width).toBe(4 * CELL_W)
    expect(canvas.height).toBe(2 * CELL_H)
    expect(fills()[0]).toEqual({ kind: 'fill', style: '#101010', x: 0, y: 0, w: 32, h: 26 })
    // 只剩一行文本，第二行（不存在的行）由底色覆盖。
    expect(textsOf(ctx)).toHaveLength(1)
  })

  it('双宽字符只绘制一次并跳过宽度为 0 的续格', () => {
    const history = [[{ chars: '中', width: 2 }, { chars: '', width: 0 }, { chars: 'A' }]]
    const terminal = createTerminal({ cols: 3, rows: 1, history })
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(true)

    expect(texts().map((op) => op.text)).toEqual(['中', 'A'])
    // 续格占一列，'A' 必须落在第 2 列（列号 2 * 8）。
    expect(texts()[1].x).toBe(2 * CELL_W)
  })

  it('保留默认色、ANSI 16 色、256 色与 RGB 前景色', () => {
    const theme = {
      foreground: '#dddddd',
      background: '#000000',
      red: '#aa0000',
      brightRed: '#ff5555'
    }
    const history: CellSpec[][] = [[
      { chars: 'D' },
      { chars: 'R', fgMode: 'palette', fg: 1 },
      { chars: 'X', fgMode: 'palette', fg: 196 },
      { chars: 'G', fgMode: 'palette', fg: 232 },
      { chars: 'C', fgMode: 'rgb', fg: 0x123456 },
      { chars: 'B', fgMode: 'palette', fg: 1, bold: true }
    ]]
    const terminal = createTerminal({ cols: 6, rows: 1, history, options: { theme } })
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(true)

    expect(texts().map((op) => op.text)).toEqual(['D', 'R', 'X', 'G', 'C', 'B'])
    expect(texts().map((op) => op.style)).toEqual([
      '#dddddd', // 默认前景色
      '#aa0000', // 调色板 1
      '#ff0000', // 256 色立方体 196
      '#080808', // 256 色灰阶 232
      '#123456', // RGB
      '#ff5555' // 加粗的调色板 0-7 提亮到 8-15
    ])
  })

  it('反色单元格交换前景与背景', () => {
    const theme = { foreground: '#ffffff', background: '#111111', blue: '#0000ff' }
    const history: CellSpec[][] = [[{ chars: 'I', fgMode: 'palette', fg: 4, inverse: true }]]
    const terminal = createTerminal({ cols: 1, rows: 1, history, options: { theme } })
    const { ctx, texts, fills, ops } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(true)

    expect(texts()[0].style).toBe('#111111')
    // 反色后该单元格背景为原前景色，覆盖 1x1 格。
    const cellFill = fills().find((op) => op.style === '#0000ff')
    expect(cellFill).toEqual({ kind: 'fill', style: '#0000ff', x: 0, y: 0, w: CELL_W, h: CELL_H })
    expect(ops.length).toBeGreaterThan(0)
  })

  it('按画布文本绘制字面内容，不注入 HTML', () => {
    const literal = '<b>&"x"</b>'
    const terminal = createTerminal({ cols: literal.length, rows: 1, history: [row(literal)] })
    const { ctx, texts } = createContext()
    const { canvas, htmlWrites } = createCanvas(ctx)

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(true)

    expect(texts().map((op) => op.text)).toEqual([literal])
    expect(htmlWrites()).toBe(0)
  })

  it('不会 resize / write / focus / open 或订阅终端事件', () => {
    const terminal = createTerminal({ cols: 5, rows: 1, history: [row('hello')] })
    const { ctx } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(true)

    expect(terminal.resize).not.toHaveBeenCalled()
    expect(terminal.write).not.toHaveBeenCalled()
    expect(terminal.writeln).not.toHaveBeenCalled()
    expect(terminal.focus).not.toHaveBeenCalled()
    expect(terminal.blur).not.toHaveBeenCalled()
    expect(terminal.open).not.toHaveBeenCalled()
    expect(terminal.refresh).not.toHaveBeenCalled()
    expect(terminal.reset).not.toHaveBeenCalled()
    expect(terminal.clear).not.toHaveBeenCalled()
    expect(terminal.loadAddon).not.toHaveBeenCalled()
    expect(terminal.onData).not.toHaveBeenCalled()
    expect(terminal.onResize).not.toHaveBeenCalled()
    expect(canvas.getContext).toHaveBeenCalledWith('2d')
  })

  it('只读：不改变终端的列数、行数与 baseY', () => {
    const terminal = createTerminal({ cols: 6, rows: 2, history: [row('abc'), row('def')], baseY: 1 })
    const { ctx } = createContext()
    const { canvas } = createCanvas(ctx)

    paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))

    expect(terminal.cols).toBe(6)
    expect(terminal.rows).toBe(2)
    expect(terminal.buffer.active.baseY).toBe(1)
    expect(terminal.buffer.active.viewportY).toBe(1)
  })

  it('拿不到 2D 上下文时返回 false', () => {
    const terminal = createTerminal({ cols: 4, rows: 1, history: [row('abcd')] })
    const canvas = { width: 0, height: 0, getContext: () => null }

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(false)
  })

  it('源对象不可用时返回 false 且不抛异常', () => {
    const { ctx } = createContext()
    const usable = () => asCanvas(createCanvas(ctx).canvas)

    // 无 canvas
    expect(paintTerminalPreview(null as unknown as HTMLCanvasElement, asTerminal(createTerminal({
      cols: 4,
      rows: 1,
      history: [row('abcd')]
    })))).toBe(false)

    // cols / rows 为 0 或非数字
    expect(paintTerminalPreview(usable(), asTerminal(createTerminal({ cols: 0, rows: 2, history: [] })))).toBe(false)
    expect(paintTerminalPreview(usable(), asTerminal(createTerminal({ cols: 4, rows: 0, history: [] })))).toBe(false)
    expect(paintTerminalPreview(usable(), asTerminal(createTerminal({
      cols: Number.NaN,
      rows: 2,
      history: []
    })))).toBe(false)

    // 缺少 buffer
    const noBuffer = { cols: 4, rows: 2, options: {}, buffer: undefined }
    expect(paintTerminalPreview(usable(), asTerminal(noBuffer))).toBe(false)

    // buffer.active 缺少 getLine / getNullCell
    const brokenBuffer = {
      cols: 4,
      rows: 2,
      options: {},
      buffer: { active: { baseY: 0, cols: 4, rows: 2 } }
    }
    expect(paintTerminalPreview(usable(), asTerminal(brokenBuffer))).toBe(false)

    // 读取 cols 时抛异常（例如终端已销毁）
    const throwing = {
      get cols(): number {
        throw new Error('disposed')
      },
      rows: 2
    }
    expect(paintTerminalPreview(usable(), asTerminal(throwing))).toBe(false)
  })

  it('缺失 options 时使用内置默认字体与配色', () => {
    const terminal = createTerminal({ cols: 3, rows: 1, history: [row('abc')] })
    delete (terminal as { options?: unknown }).options
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(true)

    expect(texts()[0].style).toBe('#ffffff')
    expect(texts()[0].font).toBe(`13px ${'Consolas, "Courier New", monospace'}`)
  })

  it('损坏的超大尺寸被裁剪，画布最长边不超过 2048', () => {
    const seenCols: number[] = []
    const seenRows: number[] = []
    const line = {
      isWrapped: false,
      length: 5000,
      getCell(x: number) {
        seenCols.push(x)
        return createCell({ chars: '<' })
      },
      translateToString: () => ''
    }
    const buffer = {
      type: 'normal' as const,
      cursorY: 0,
      cursorX: 0,
      viewportY: 0,
      baseY: 0,
      length: 1,
      getLine(y: number) {
        seenRows.push(y)
        // 首行返回超长行，其余返回 undefined（视为空行）。
        return y === 0 ? line : undefined
      },
      getNullCell: () => ({})
    }
    const terminal = { cols: 5000, rows: 5000, buffer: { active: buffer }, options: { fontSize: 20 } }
    const { ctx } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(true)

    // 列裁剪到 500、行裁剪到 200。
    expect(Math.max(...seenCols)).toBe(499)
    expect(seenRows).toHaveLength(200)
    expect(canvas.width).toBeLessThanOrEqual(2048)
    expect(canvas.height).toBeLessThanOrEqual(2048)
    expect(canvas.width).toBeGreaterThan(0)
    expect(ctx.setTransform).toHaveBeenCalled()
  })

  it('超过 2048 时按比例缩放绘制坐标', () => {
    const terminal = createTerminal({ cols: 500, rows: 200, history: [], options: { fontSize: 20 } })
    const { ctx } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(true)

    // 网格 6000x4000 → 缩放 2048/6000，画布 2048x1365。
    const args = (ctx.setTransform as ReturnType<typeof vi.fn>).mock.calls[0] as number[]
    expect(args[0]).toBeCloseTo(2048 / 6000, 5)
    expect(args[3]).toBeCloseTo(2048 / 6000, 5)
    expect(canvas.width).toBe(2048)
    expect(canvas.height).toBe(Math.round(4000 * (2048 / 6000)))
  })

  it('加粗/斜体反映到字体字符串，不可见字符不绘制', () => {
    const history = [[
      { chars: 'B', bold: true },
      { chars: 'I', italic: true },
      { chars: 'S', bold: true, italic: true },
      { chars: 'H', invisible: true }
    ]]
    const terminal = createTerminal({ cols: 4, rows: 1, history })
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(true)

    expect(texts().map((op) => op.text)).toEqual(['B', 'I', 'S'])
    expect(texts()[0].font).toContain('bold ')
    expect(texts()[1].font).toContain('italic ')
    expect(texts()[2].font).toBe('italic bold 13px Consolas, "Courier New", monospace')
  })

  it('使用终端 fontFamily/fontSize/lineHeight', () => {
    const terminal = createTerminal({
      cols: 2,
      rows: 2,
      history: [row('hi')],
      options: { fontFamily: 'Menlo, monospace', fontSize: 10, lineHeight: 1.2 }
    })
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(true)

    // 单格 6x12。
    expect(canvas.width).toBe(12)
    expect(canvas.height).toBe(24)
    expect(texts()[0].font).toBe('10px Menlo, monospace')
    expect(texts()[0].y).toBe(6)
  })

  it('使用实测字体步进作为单元格宽度', () => {
    const terminal = createTerminal({ cols: 2, rows: 1, history: [[
      { chars: 'A' },
      { chars: 'B', fgMode: 'palette', fg: 1 }
    ]], options: { theme: { red: '#aa0000' } } })
    const { ctx, texts } = createContext(9.5)
    const { canvas } = createCanvas(ctx)

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(true)

    // 网格 2 格 × 9.5 → 画布 19；第二段文本落在第 1 列。
    expect(canvas.width).toBe(19)
    expect(texts().map((op) => op.x)).toEqual([0, 9.5])
  })

  it('非法尺寸/未知颜色的选项回落到默认值', () => {
    const terminal = createTerminal({
      cols: 2,
      rows: 1,
      history: [row('ok')],
      options: {
        fontSize: -5,
        lineHeight: 0,
        fontFamily: '',
        theme: { foreground: 'url(http://evil)', background: '#222222', red: 'not a color!' }
      }
    })
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal))).toBe(true)

    expect(texts()[0].font).toBe('13px Consolas, "Courier New", monospace')
    expect(texts()[0].style).toBe('#ffffff')
    expect(canvas.height).toBe(CELL_H)
  })
})

describe('paintTerminalPreview readable 模式', () => {
  it('默认使用 12px 字号与 1.5 倍行高，保留列位置且不缩放', () => {
    const terminal = createTerminal({
      cols: 4,
      rows: 2,
      history: [[{ chars: 'A' }, { chars: 'B', fgMode: 'palette', fg: 1 }, { chars: 'C' }]],
      options: { theme: { red: '#aa0000' } }
    })
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(
      paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), { mode: 'readable' })
    ).toBe(true)

    // 单格 7x18：12px × 0.6 兜底宽、12px × 1.5 行高；画布按固有像素尺寸 1:1 输出。
    expect(canvas.width).toBe(4 * 7)
    expect(canvas.height).toBe(18)
    expect(ctx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0)
    expect(texts().map((op) => op.font)).toEqual([
      '12px Consolas, "Courier New", monospace',
      '12px Consolas, "Courier New", monospace',
      '12px Consolas, "Courier New", monospace'
    ])
    expect(texts().map((op) => op.x)).toEqual([0, 7, 14])
    // 行高 18 时文本基线居中于 9。
    expect(texts().map((op) => op.y)).toEqual([9, 9, 9])
  })

  it('终端尚未 open（缺少 options）时按默认字号与主题绘制', () => {
    const terminal = createTerminal({ cols: 3, rows: 1, history: [row('abc')] })
    // 未 open 的终端没有可读的 options。
    ;(terminal as { options?: unknown }).options = undefined
    const { ctx, fills, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(
      paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), { mode: 'readable' })
    ).toBe(true)

    expect(canvas.width).toBe(3 * 7)
    expect(canvas.height).toBe(18)
    expect(texts()[0].font).toBe('12px Consolas, "Courier New", monospace')
    expect(texts()[0].style).toBe('#ffffff')
    expect(fills()[0]).toMatchObject({ style: '#000000', w: 3 * 7, h: 18 })
  })

  it('沿用终端字体族与主题配色', () => {
    const terminal = createTerminal({
      cols: 3,
      rows: 1,
      history: [row('abc')],
      options: {
        fontFamily: 'Menlo, monospace',
        theme: { foreground: '#eeeeee', background: '#101010' }
      }
    })
    const { ctx, fills, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(
      paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), { mode: 'readable' })
    ).toBe(true)

    expect(texts()[0].font).toBe('12px Menlo, monospace')
    expect(texts()[0].style).toBe('#eeeeee')
    expect(fills()[0]).toMatchObject({ style: '#101010', x: 0, y: 0, w: 3 * 7, h: 18 })
  })

  it('使用请求的字号，行高至少保持 1.5 倍', () => {
    const terminal = createTerminal({
      cols: 3,
      rows: 1,
      history: [row('abc')],
      // readable 模式不继承终端自身的字号与行高。
      options: { fontSize: 9, lineHeight: 1.2 }
    })
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(
      paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), {
        mode: 'readable',
        fontSize: 20
      })
    ).toBe(true)

    // 20px → 单格 12x30。
    expect(canvas.width).toBe(3 * 12)
    expect(canvas.height).toBe(30)
    expect(texts()[0].font).toBe('20px Consolas, "Courier New", monospace')
    expect(texts()[0].y).toBe(15)
  })

  it('裁掉当前屏幕底部的空行', () => {
    const terminal = createTerminal({
      cols: 4,
      rows: 8,
      history: [row('TOP'), row('MID'), row('BOT'), row('    '), row('    ')]
    })
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(
      paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), { mode: 'readable' })
    ).toBe(true)

    expect(canvas.height).toBe(3 * 18)
    expect(texts().map((op) => op.text)).toEqual(['TOP', 'MID', 'BOT'])
  })

  it('把游标行算作有意义行，即使该行为空', () => {
    const terminal = createTerminal({
      cols: 4,
      rows: 8,
      history: [row('ONLY'), row('    '), row('    '), row('    ')],
      cursorY: 3
    })
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(
      paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), { mode: 'readable' })
    ).toBe(true)

    expect(canvas.height).toBe(4 * 18)
    // 空白行只画背景，不产生可见文本。
    expect(texts().map((op) => op.text).filter((text) => text.trim())).toEqual(['ONLY'])
    expect(texts().map((op) => op.y)).toEqual([9, 27, 45, 63])
  })

  it('只保留最后 maxRows 行，行号按 baseY 偏移读取', () => {
    const terminal = createTerminal({
      cols: 4,
      rows: 5,
      history: [row('A0'), row('A1'), row('B0'), row('B1'), row('B2'), row('B3'), row('B4')],
      baseY: 2,
      cursorY: 4
    })
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(
      paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), {
        mode: 'readable',
        maxRows: 3
      })
    ).toBe(true)

    // baseY=2 的屏幕行 2..4 对应缓冲第 4..6 行，不能读到滚动历史 A0/A1。
    expect(texts().map((op) => op.text)).toEqual(['B2', 'B3', 'B4'])
    // 画布只包含裁剪后的窗口，纵坐标相对窗口起点。
    expect(texts().map((op) => op.y)).toEqual([9, 27, 45])
    expect(canvas.height).toBe(3 * 18)
  })

  it('maxRows 非法时回落到默认 18 行', () => {
    const history = Array.from({ length: 24 }, (_, index) => row(`R${String(index).padStart(2, '0')}`))
    const expected = history.slice(6).map((cells) => cells.map((cell) => cell.chars).join(''))

    for (const maxRows of [0, -2, Number.NaN, 500]) {
      const terminal = createTerminal({ cols: 3, rows: 24, history, cursorY: 23 })
      const { ctx, texts } = createContext()
      const { canvas } = createCanvas(ctx)

      expect(
        paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), {
          mode: 'readable',
          maxRows
        })
      ).toBe(true)

      expect(canvas.height).toBe(18 * 18)
      expect(texts().map((op) => op.text)).toEqual(expected)
    }
  })

  it('保留双宽字符位置与 ANSI 配色/字重', () => {
    const terminal = createTerminal({
      cols: 5,
      rows: 1,
      history: [
        [
          { chars: '中', width: 2 },
          { chars: '', width: 0 },
          { chars: 'R', fgMode: 'palette', fg: 1 },
          { chars: 'B', bold: true },
          { chars: 'G', bgMode: 'palette', bg: 2 }
        ]
      ],
      options: {
        theme: { foreground: '#dddddd', background: '#000000', red: '#aa0000', green: '#00aa00' }
      }
    })
    const { ctx, fills, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(
      paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), { mode: 'readable' })
    ).toBe(true)

    expect(texts().map((op) => op.text)).toEqual(['中', 'R', 'B', 'G'])
    expect(texts().map((op) => op.x)).toEqual([0, 2 * 7, 3 * 7, 4 * 7])
    expect(texts()[0].style).toBe('#dddddd')
    expect(texts()[1].style).toBe('#aa0000')
    expect(texts()[2].font).toBe('bold 12px Consolas, "Courier New", monospace')
    expect(fills().find((op) => op.style === '#00aa00')).toMatchObject({
      x: 4 * 7,
      y: 0,
      w: 7,
      h: 18
    })
  })

  it('行对象缺少 translateToString 时按单元格判断空行', () => {
    const buffer = {
      type: 'normal' as const,
      cursorY: 0,
      cursorX: 0,
      viewportY: 0,
      baseY: 0,
      length: 4,
      getLine: (y: number) => {
        if (y === 0) {
          return {
            isWrapped: false,
            length: 4,
            getCell: (x: number) => createCell({ chars: x === 0 ? 'X' : ' ' })
          }
        }
        if (y === 1) {
          return {
            isWrapped: false,
            length: 4,
            getCell: (x: number) => createCell({ chars: x === 0 ? 'Y' : ' ' })
          }
        }
        return {
          isWrapped: false,
          length: 4,
          getCell: () => createCell({ chars: ' ' })
        }
      },
      getNullCell: () => ({})
    }
    const terminal = { cols: 4, rows: 4, buffer: { active: buffer }, options: {} }
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(
      paintTerminalPreview(asCanvas(canvas), (terminal as unknown) as Terminal, {
        mode: 'readable'
      })
    ).toBe(true)

    // 第 1 行是最后一个有内容的行；底部两行空行被裁掉。
    expect(canvas.height).toBe(2 * 18)
    expect(texts().map((op) => op.text.trim())).toEqual(['X', 'Y'])
  })

  it('不修改终端尺寸、缓冲、游标、主题与字号', () => {
    const theme = { foreground: '#eeeeee', background: '#101010' }
    const terminal = createTerminal({
      cols: 6,
      rows: 3,
      history: [row('abc')],
      baseY: 1,
      cursorY: 1,
      options: { theme, fontSize: 9, lineHeight: 1.1 }
    })
    const buffer = terminal.buffer.active
    const { ctx } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(
      paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), {
        mode: 'readable',
        fontSize: 16
      })
    ).toBe(true)

    expect(terminal.cols).toBe(6)
    expect(terminal.rows).toBe(3)
    expect(buffer.baseY).toBe(1)
    expect(buffer.viewportY).toBe(1)
    expect(buffer.cursorY).toBe(1)
    expect(buffer.length).toBe(1)
    expect(terminal.options.theme).toEqual(theme)
    expect(terminal.options.fontSize).toBe(9)
    expect(terminal.options.lineHeight).toBe(1.1)
    for (const spy of [
      terminal.resize,
      terminal.write,
      terminal.writeln,
      terminal.focus,
      terminal.blur,
      terminal.open,
      terminal.dispose,
      terminal.refresh,
      terminal.reset,
      terminal.clear,
      terminal.loadAddon,
      terminal.onData,
      terminal.onResize
    ]) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('画布宽度超过 2048 时仍保持 1:1 像素', () => {
    const terminal = createTerminal({ cols: 300, rows: 1, history: [row('x')] })
    const { ctx } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(
      paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), { mode: 'readable' })
    ).toBe(true)

    expect(canvas.width).toBe(300 * 7)
    expect(canvas.height).toBe(18)
    expect(ctx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0)
  })

  it('异常尺寸触发像素保护时画布仍然有界', () => {
    const history = Array.from({ length: 200 }, () => row('x'))
    const terminal = createTerminal({
      cols: 500,
      rows: 200,
      history,
      cursorY: 199,
      options: { fontSize: 200 }
    })
    const { ctx } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(
      paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), {
        mode: 'readable',
        maxRows: 200,
        fontSize: 200
      })
    ).toBe(true)

    expect(canvas.width).toBeGreaterThan(0)
    expect(canvas.height).toBeGreaterThan(0)
    expect(canvas.width).toBeLessThanOrEqual(8192)
    expect(canvas.height).toBeLessThanOrEqual(8192)
  })

  it('整屏为空时保留一行背景而不是零高度画布', () => {
    const terminal = createTerminal({ cols: 4, rows: 4, history: [] })
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(
      paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), { mode: 'readable' })
    ).toBe(true)

    expect(canvas.height).toBe(18)
    expect(texts()).toEqual([])
  })

  it('游标行位于裁剪窗口上方时从游标行开始取窗口', () => {
    const history = Array.from({ length: 10 }, (_, index) => row(`C${index}`))
    const terminal = createTerminal({ cols: 3, rows: 10, history, cursorY: 2 })
    const { ctx, texts } = createContext()
    const { canvas } = createCanvas(ctx)

    expect(
      paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), {
        mode: 'readable',
        maxRows: 3
      })
    ).toBe(true)

    expect(texts().map((op) => op.text)).toEqual(['C2', 'C3', 'C4'])
    expect(canvas.height).toBe(3 * 18)
  })

  it('overview 模式忽略 readable 选项，与两参数调用完全一致', () => {
    const run = (options?: TerminalPreviewOptions) => {
      const terminal = createTerminal({
        cols: 6,
        rows: 2,
        history: [row('AB'), row('CD')]
      })
      const { ctx, ops } = createContext()
      const { canvas } = createCanvas(ctx)
      expect(paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), options)).toBe(true)
      return { width: canvas.width, height: canvas.height, ops }
    }

    const legacy = run()
    const overview = run({ mode: 'overview', maxRows: 1, fontSize: 40 })
    const unknownMode = run({ mode: 'weird' as TerminalPreviewMode })

    expect(legacy.width).toBe(6 * CELL_W)
    expect(legacy.height).toBe(2 * CELL_H)
    expect(overview).toEqual(legacy)
    expect(unknownMode).toEqual(legacy)
  })

  it('readable 模式拿不到 2D 上下文时返回 false', () => {
    const terminal = createTerminal({ cols: 4, rows: 1, history: [row('abcd')] })
    const canvas = { width: 0, height: 0, getContext: () => null }

    expect(
      paintTerminalPreview(asCanvas(canvas), asTerminal(terminal), { mode: 'readable' })
    ).toBe(false)
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(terminal.resize).not.toHaveBeenCalled()
  })
})

function textsOf(ctx: Record<string, unknown>) {
  const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls as unknown[][]
  return calls.map((call) => call[0])
}
