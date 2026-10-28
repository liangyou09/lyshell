/**
 * 任务架（TaskShelf）终端缩略图绘制。
 *
 * 只读工具：React 包装层在面板可见时每 500ms 调用一次，本模块从
 * terminal.buffer.active 的 baseY 起读取“当前屏幕”，把只读缩略图画到 canvas。
 * 不打开/调整终端尺寸、不订阅 PTY、不写入终端数据、不修改传入对象。
 *
 * 两种绘制模式：
 * - overview（默认）：终端原始字号下的虚拟网格尺寸（最长边上限 2048），由父级 CSS 缩放到缩略图宽度。
 * - readable：按可读字号 1:1 像素绘制，裁掉当前屏幕底部的空行，画布按固有像素宽度横向滚动。
 */
import type { ITheme, Terminal } from '@xterm/xterm'

type ActiveBuffer = Terminal['buffer']['active']
type BufferLine = NonNullable<ReturnType<ActiveBuffer['getLine']>>
type BufferCell = NonNullable<ReturnType<BufferLine['getCell']>>

/** 画布任一方向的最大像素尺寸（虚拟网格按比例缩小以适配）。 */
const MAX_CANVAS_DIMENSION = 2048
/** 终端列数上限：避免损坏的 cols 造成无界绘制。 */
const MAX_PREVIEW_COLS = 500
/** 终端行数上限：避免损坏的 rows 造成无界绘制。 */
const MAX_PREVIEW_ROWS = 200
/** readable 模式默认字号（px）：固定为可读大小，不跟随终端自身可能偏小的字号。 */
const DEFAULT_READABLE_FONT_SIZE = 12
/** readable 模式最小行高倍数：行距过小会让终端文本连成一片。 */
const MIN_READABLE_LINE_HEIGHT = 1.5
/** readable 模式默认保留的当前屏幕行数。 */
const DEFAULT_READABLE_MAX_ROWS = 18
/** readable 模式画布单边像素上限（内存保护，正常终端尺寸不会触发）。 */
const READABLE_MAX_DIMENSION = 8192
/** readable 模式画布总像素上限（4 字节/像素约 32MB，内存保护）。 */
const READABLE_MAX_PIXELS = 8_388_608
const DEFAULT_FONT_FAMILY = 'Consolas, "Courier New", monospace'
const DEFAULT_FONT_SIZE = 13
const DEFAULT_LINE_HEIGHT = 1
const DEFAULT_FOREGROUND = '#ffffff'
const DEFAULT_BACKGROUND = '#000000'
/** 等宽字体单字宽与字号之比的近似值，仅用于缩略图网格布局。 */
const CELL_WIDTH_RATIO = 0.6

const STYLE_BOLD = 1
const STYLE_ITALIC = 2

/** 主题未提供时使用的 ANSI 0-15 兜底色（xterm 风格）。 */
const FALLBACK_PALETTE_16: readonly string[] = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff'
]

const ANSI_THEME_KEYS: ReadonlyArray<keyof ITheme> = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite'
]

/** 256 色立方体的通道取值。 */
const COLOR_CUBE_STEPS: readonly number[] = [0, 95, 135, 175, 215, 255]

const EMPTY_EXTENDED: ReadonlyArray<unknown> = []

interface PreviewTheme {
  foreground: string
  background: string
  /** ANSI 0-15。 */
  palette16: string[]
  /** 主题自定义的 16-255 扩展色（可能为空）。 */
  extended: ReadonlyArray<unknown>
}

interface PaintState {
  ctx: CanvasRenderingContext2D
  cols: number
  cellWidth: number
  cellHeight: number
  fontSize: number
  fontFamily: string
  theme: PreviewTheme
  rgbCache: Map<number, string>
  scratch: BufferCell
}

/** 绘制模式：overview 为原有整屏缩略图；readable 为可读字号 1:1 绘制并裁掉底部空行。 */
export type TerminalPreviewMode = 'overview' | 'readable'

/** 可选的绘制参数；省略时等价于原有的两参数调用（overview）。 */
export interface TerminalPreviewOptions {
  /** 绘制模式，默认 'overview'。 */
  mode?: TerminalPreviewMode
  /** readable 模式保留的当前屏幕行数，默认 18，有效范围 1..200，非法值回落默认值。 */
  maxRows?: number
  /** readable 模式字号（px），默认 12，有效范围 4..200。 */
  fontSize?: number
  /** 分配画布像素前准入；返回 false 时不改变原画布，保留旧画面。 */
  beforeResize?: (width: number, height: number) => boolean
}

interface ResolvedPreviewOptions {
  mode: TerminalPreviewMode
  maxRows: number
  fontSize: number
  beforeResize?: (width: number, height: number) => boolean
}

/** 一次绘制使用的网格布局。 */
interface PreviewFrame {
  /** 实际绘制的列数；保留原始列位置，只在异常尺寸触发像素上限时裁剪。 */
  cols: number
  /** 实际绘制的行数。 */
  rows: number
  /** 相对当前屏幕顶部（baseY）的起始行偏移。 */
  startRow: number
  /** 网格坐标到画布像素的缩放。 */
  scale: number
}

/**
 * 把终端当前屏幕画成只读缩略图。
 *
 * @param options 绘制选项；省略时使用 overview 模式，行为与两参数调用完全一致。
 * @returns 画布可用且绘制完成时返回 true；拿不到 2D 上下文或源对象不可用时返回 false。
 */
export function paintTerminalPreview(
  canvas: HTMLCanvasElement,
  terminal: Terminal,
  options?: TerminalPreviewOptions
): boolean {
  if (!canvas || typeof canvas.getContext !== 'function' || !terminal) return false

  try {
    const preview = readPreviewOptions(options)
    const cols = clampDimension(terminal.cols, MAX_PREVIEW_COLS)
    const rows = clampDimension(terminal.rows, MAX_PREVIEW_ROWS)
    if (cols < 1 || rows < 1) return false

    const buffer = terminal.buffer?.active
    if (!buffer || typeof buffer.getLine !== 'function' || typeof buffer.getNullCell !== 'function') return false

    // 只读取 option 的公开字段；options 可能是 undefined（未 open 的终端）。
    const terminalOptions = terminal.options as
      | { fontSize?: number; lineHeight?: number; fontFamily?: string; theme?: ITheme }
      | undefined
    // readable 模式沿用字体族/主题/ANSI 配色，但字号与行高按可读性取值。
    const fontSize = preview.mode === 'readable'
      ? preview.fontSize
      : boundedNumber(terminalOptions?.fontSize, DEFAULT_FONT_SIZE, 4, 200)
    const lineHeight = preview.mode === 'readable'
      ? MIN_READABLE_LINE_HEIGHT
      : boundedNumber(terminalOptions?.lineHeight, DEFAULT_LINE_HEIGHT, 0.5, 4)
    const fontFamily = fontFamilyOf(terminalOptions?.fontFamily)
    const theme = readTheme(terminalOptions?.theme)

    const ctx = canvas.getContext('2d')
    if (!ctx) return false

    // 单格宽度优先用字体实测步进：整行文本按字符串绘制时不会逐字累积漂移。
    const cellWidth = measureCellWidth(ctx, fontFamily, fontSize)
    const cellHeight = Math.max(1, Math.round(fontSize * lineHeight))
    const baseY = normalizeBaseY(buffer.baseY)
    const scratch = buffer.getNullCell()

    const frame = preview.mode === 'readable'
      ? planReadableFrame(buffer, cols, rows, baseY, cellWidth, cellHeight, preview.maxRows, scratch)
      : planOverviewFrame(cols, rows, cellWidth, cellHeight)

    const gridWidth = frame.cols * cellWidth
    const gridHeight = frame.rows * cellHeight
    const scale = frame.scale
    const nextWidth = Math.max(1, Math.round(gridWidth * scale))
    const nextHeight = Math.max(1, Math.round(gridHeight * scale))
    // 分配像素前先由调用方预留预算；拒绝时不触碰画布，旧画面保持可读。
    if (preview.beforeResize && !preview.beforeResize(nextWidth, nextHeight)) return false

    canvas.width = nextWidth
    canvas.height = nextHeight

    // 设置画布尺寸会重置上下文状态，因此状态一律放在其后设置。
    // 以虚拟网格坐标绘制，再整体缩放到画布像素（readable 模式固定 1:1）。
    if (typeof ctx.setTransform === 'function') ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.clearRect(0, 0, gridWidth, gridHeight)
    ctx.fillStyle = theme.background
    ctx.fillRect(0, 0, gridWidth, gridHeight)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    const state: PaintState = {
      ctx,
      cols: frame.cols,
      cellWidth,
      cellHeight,
      fontSize,
      fontFamily,
      theme,
      rgbCache: new Map<number, string>(),
      scratch
    }

    for (let row = 0; row < frame.rows; row++) {
      const line = buffer.getLine(baseY + frame.startRow + row)
      // 该行不存在时保留默认底色。
      if (!line) continue
      paintRowBackground(state, line, row)
      paintRowText(state, line, row)
    }

    return true
  } catch {
    // 终端已销毁或伪造尺寸等异常：视为源不可用，不向调用方抛出。
    return false
  }
}

/** overview：整屏虚拟网格，最长边超过 2048 时整体缩放。 */
function planOverviewFrame(cols: number, rows: number, cellWidth: number, cellHeight: number): PreviewFrame {
  const gridWidth = cols * cellWidth
  const gridHeight = rows * cellHeight
  return {
    cols,
    rows,
    startRow: 0,
    scale: Math.min(1, MAX_CANVAS_DIMENSION / Math.max(gridWidth, gridHeight))
  }
}

/**
 * readable：从当前屏幕最后一行往上找最后一个有意义的行，裁掉底部空行，
 * 最多保留 maxRows 行；像素固定 1:1，只在异常尺寸下按内存上限裁剪。
 */
function planReadableFrame(
  buffer: ActiveBuffer,
  cols: number,
  rows: number,
  baseY: number,
  cellWidth: number,
  cellHeight: number,
  maxRows: number,
  scratch: BufferCell
): PreviewFrame {
  const cursorRow = normalizeCursorRow(buffer.cursorY, rows)
  const lastMeaningful = findLastMeaningfulRow(buffer, cols, rows, baseY, cursorRow, scratch)

  // 只裁底部：最后一个有意义行之后不再留空；整屏为空时保留一行背景。
  let visibleRows = Math.max(1, Math.min(maxRows, lastMeaningful + 1))
  let startRow = Math.max(0, lastMeaningful + 1 - visibleRows)
  // 游标行必须留在窗口内：游标在窗口上方时从游标行开始取窗口。
  if (lastMeaningful >= 0 && cursorRow >= 0 && cursorRow < startRow) {
    startRow = cursorRow
    visibleRows = Math.max(1, Math.min(maxRows, lastMeaningful + 1 - startRow))
  }

  // 像素/内存上限：只裁剪不缩放，避免把可读字号又缩回看不清。
  const heightCap = Math.max(1, Math.floor(READABLE_MAX_DIMENSION / cellHeight))
  if (visibleRows > heightCap) {
    startRow += visibleRows - heightCap
    visibleRows = heightCap
  }
  const widthCap = Math.max(
    1,
    Math.floor(
      Math.min(
        READABLE_MAX_DIMENSION,
        Math.floor(READABLE_MAX_PIXELS / Math.max(1, visibleRows * cellHeight))
      ) / cellWidth
    )
  )
  const visibleCols = Math.max(1, Math.min(cols, widthCap))

  return { cols: visibleCols, rows: visibleRows, startRow, scale: 1 }
}

/**
 * 当前屏幕内最后一个有意义的行（相对屏幕顶部）。游标行总是算有意义；
 * 文本优先用 translateToString(true) 判断，行对象没有该方法时回退为逐格检查。
 */
function findLastMeaningfulRow(
  buffer: ActiveBuffer,
  cols: number,
  rows: number,
  baseY: number,
  cursorRow: number,
  scratch: BufferCell
): number {
  for (let row = rows - 1; row >= 0; row--) {
    if (row === cursorRow) return row
    const line = buffer.getLine(baseY + row)
    if (line && lineHasText(line, cols, scratch)) return row
  }
  return -1
}

/** 行是否含可见文本。 */
function lineHasText(line: BufferLine, cols: number, scratch: BufferCell): boolean {
  if (typeof line.translateToString === 'function') {
    try {
      const text = line.translateToString(true)
      if (typeof text === 'string') return text.trim().length > 0
    } catch {
      // 忽略翻译失败，走逐格检查。
    }
  }
  if (typeof line.getCell !== 'function') return false
  for (let col = 0; col < cols; col++) {
    const cell = line.getCell(col, scratch)
    if (!cell) break
    if (widthOf(cell.getWidth()) === 0) continue
    if (cell.isInvisible()) continue
    if ((cell.getChars() || '').trim()) return true
  }
  return false
}

/** 游标在当前屏幕内的行号；越界或非法值返回 -1（忽略游标行）。 */
function normalizeCursorRow(value: unknown, rows: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return -1
  const row = Math.floor(n)
  return row < rows ? row : -1
}

/** 解析第三个参数；非法/缺失时回落到 overview 与默认值。 */
function readPreviewOptions(raw: unknown): ResolvedPreviewOptions {
  const source = raw && typeof raw === 'object' ? (raw as TerminalPreviewOptions) : {}
  const mode: TerminalPreviewMode = source.mode === 'readable' ? 'readable' : 'overview'
  const beforeResize = typeof source.beforeResize === 'function' ? source.beforeResize : undefined
  if (mode !== 'readable') {
    return { mode, maxRows: DEFAULT_READABLE_MAX_ROWS, fontSize: DEFAULT_READABLE_FONT_SIZE, beforeResize }
  }
  return {
    mode,
    maxRows: Math.floor(boundedNumber(source.maxRows, DEFAULT_READABLE_MAX_ROWS, 1, MAX_PREVIEW_ROWS)),
    fontSize: boundedNumber(source.fontSize, DEFAULT_READABLE_FONT_SIZE, 4, 200),
    beforeResize
  }
}

/** 合并连续同底色单元格，减少填充次数。 */
function paintRowBackground(state: PaintState, line: BufferLine, row: number): void {
  const { ctx, cols, cellWidth, cellHeight, theme, rgbCache, scratch } = state
  const top = row * cellHeight

  let col = 0
  while (col < cols) {
    const cell = line.getCell(col, scratch)
    const background = cell ? paintedBackground(cell, theme, rgbCache) : theme.background
    let end = col + 1
    while (end < cols) {
      const next = line.getCell(end, scratch)
      if (!next) {
        // 超出该行有效单元格后一律按默认底色处理。
        if (background === theme.background) end = cols
        break
      }
      if (paintedBackground(next, theme, rgbCache) !== background) break
      end += 1
    }
    if (background !== theme.background) {
      ctx.fillStyle = background
      ctx.fillRect(col * cellWidth, top, (end - col) * cellWidth, cellHeight)
    }
    col = end
  }
}

/** 按前景色/字重/斜体合并连续单元格后绘制文本。 */
function paintRowText(state: PaintState, line: BufferLine, row: number): void {
  const { ctx, cols, cellWidth, cellHeight, fontSize, fontFamily, theme, rgbCache, scratch } = state
  const top = row * cellHeight

  let col = 0
  while (col < cols) {
    const cell = line.getCell(col, scratch)
    if (!cell) break

    const width = widthOf(cell.getWidth())
    if (width === 0) {
      // 双宽字符的续格：宽度为 0，不单独绘制。
      col += 1
      continue
    }

    const chars = cell.getChars() || ''
    if (!chars || cell.isInvisible()) {
      col += width
      continue
    }

    const foreground = paintedForeground(cell, theme, rgbCache)
    const flags = styleFlagsOf(cell)
    let text = chars
    let end = col + width
    // 只合并单宽单元格：双宽字形的前进宽度不一定等于 2 格，单独绘制才能保证列位置精确。
    if (width === 1) {
      while (end < cols) {
        const next = line.getCell(end, scratch)
        if (!next) break
        const nextWidth = widthOf(next.getWidth())
        if (nextWidth !== 1) break
        const nextChars = next.getChars() || ''
        if (!nextChars || next.isInvisible()) break
        if (styleFlagsOf(next) !== flags) break
        if (paintedForeground(next, theme, rgbCache) !== foreground) break
        text += nextChars
        end += nextWidth
      }
    }

    ctx.fillStyle = foreground
    ctx.font = fontOf(fontFamily, fontSize, flags)
    ctx.fillText(text, col * cellWidth, top + cellHeight / 2)
    col = end
  }
}

function styleFlagsOf(cell: BufferCell): number {
  let flags = 0
  if (cell.isBold()) flags |= STYLE_BOLD
  if (cell.isItalic()) flags |= STYLE_ITALIC
  return flags
}

function fontOf(family: string, size: number, flags: number): string {
  const italic = flags & STYLE_ITALIC ? 'italic ' : ''
  const weight = flags & STYLE_BOLD ? 'bold ' : ''
  return `${italic}${weight}${size}px ${family}`
}

/** 等宽字体的实测前进宽度；测量不可用或结果异常时按字号比例估算。 */
function measureCellWidth(ctx: CanvasRenderingContext2D, family: string, size: number): number {
  try {
    if (typeof ctx.measureText === 'function') {
      ctx.font = fontOf(family, size, 0)
      const measured = ctx.measureText('M').width
      if (Number.isFinite(measured) && measured >= 1 && measured <= size * 4) return measured
    }
  } catch {
    // 忽略测量失败，走比例回退。
  }
  return Math.max(1, Math.round(size * CELL_WIDTH_RATIO))
}

/** 前景色（反色时改用背景色）。 */
function paintedForeground(cell: BufferCell, theme: PreviewTheme, rgb: Map<number, string>): string {
  return cell.isInverse() ? rawBackground(cell, theme, rgb) : rawForeground(cell, theme, rgb)
}

/** 背景色（反色时改用前景色）。 */
function paintedBackground(cell: BufferCell, theme: PreviewTheme, rgb: Map<number, string>): string {
  return cell.isInverse() ? rawForeground(cell, theme, rgb) : rawBackground(cell, theme, rgb)
}

function rawForeground(cell: BufferCell, theme: PreviewTheme, rgb: Map<number, string>): string {
  if (cell.isFgRGB()) return rgbColor(cell.getFgColor(), rgb)
  if (cell.isFgPalette()) {
    const index = cell.getFgColor()
    // 与 xterm 默认行为一致：加粗的 0-7 调色板色提亮为 8-15。
    const boost = cell.isBold() && index >= 0 && index < 8 ? 8 : 0
    return paletteColor(index + boost, theme)
  }
  return theme.foreground
}

function rawBackground(cell: BufferCell, theme: PreviewTheme, rgb: Map<number, string>): string {
  if (cell.isBgRGB()) return rgbColor(cell.getBgColor(), rgb)
  if (cell.isBgPalette()) return paletteColor(cell.getBgColor(), theme)
  return theme.background
}

/** 256 色：0-15 取主题，16-255 优先取主题扩展色，否则按标准立方体/灰阶计算。 */
function paletteColor(value: number, theme: PreviewTheme): string {
  const index = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  if (index < 16) return theme.palette16[index] ?? theme.foreground

  const custom = theme.extended[index - 16]
  if (isColorString(custom)) return custom

  if (index < 232) {
    const cube = index - 16
    const r = COLOR_CUBE_STEPS[Math.floor(cube / 36)]
    const g = COLOR_CUBE_STEPS[Math.floor(cube / 6) % 6]
    const b = COLOR_CUBE_STEPS[cube % 6]
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`
  }
  if (index < 256) {
    const level = hex2(8 + (index - 232) * 10)
    return `#${level}${level}${level}`
  }
  return theme.foreground
}

function rgbColor(value: number, cache: Map<number, string>): string {
  const n = Number.isFinite(value) ? Math.max(0, Math.min(0xffffff, Math.floor(value))) : 0
  const cached = cache.get(n)
  if (cached) return cached
  const color = `#${n.toString(16).padStart(6, '0')}`
  cache.set(n, color)
  return color
}

function hex2(value: number): string {
  return Math.max(0, Math.min(255, Math.floor(value))).toString(16).padStart(2, '0')
}

function readTheme(raw: unknown): PreviewTheme {
  const theme = raw && typeof raw === 'object' ? (raw as ITheme) : {}
  return {
    background: colorOr(theme.background, DEFAULT_BACKGROUND),
    foreground: colorOr(theme.foreground, DEFAULT_FOREGROUND),
    palette16: ANSI_THEME_KEYS.map((key, index) => colorOr(theme[key], FALLBACK_PALETTE_16[index])),
    extended: Array.isArray(theme.extendedAnsi) ? theme.extendedAnsi : EMPTY_EXTENDED
  }
}

/** 只接受 CSS 颜色字面量，避免把 url()/表达式等非颜色值写进画布状态。 */
function isColorString(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 64) return false
  return /^[#a-z0-9(),.%\s+-]+$/i.test(trimmed)
}

function colorOr(value: unknown, fallback: string): string {
  return isColorString(value) ? value.trim() : fallback
}

function fontFamilyOf(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_FONT_FAMILY
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 200) return DEFAULT_FONT_FAMILY
  return trimmed
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < min || n > max) return fallback
  return n
}

/** 列/行数：非有限或小于 1 视为损坏，超过上限的裁剪掉。 */
function clampDimension(value: unknown, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 1) return 0
  return Math.min(Math.floor(n), max)
}

function normalizeBaseY(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

/** 单元格宽度：0 表示双宽字符的续格，异常值按 1 处理。 */
function widthOf(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 1
  return Math.floor(value)
}
