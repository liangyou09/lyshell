import { create } from 'zustand'
import { isLightColor } from '@shared/color-utils'

/**
 * 主题系统
 *
 * 每个主题在 globals.css 里通过 [data-theme="..."] 定义完整 CSS 变量集合。
 * 此 store 负责：
 *   - 切换 document.documentElement.dataset.theme
 *   - 通过 localStorage 持久化（早期同步加载在 index.html 里完成，避免 FOUC）
 *
 * Custom 主题特殊：CSS 中只有 fallback，真值由本 store 的 applyCustomColors() 通过
 * documentElement.style.setProperty() 注入 inline，从 base + accent 两个用户值
 * 按 HSL lightness 阶梯派生 5 阶 chrome + 5 阶文字 + amber 三态。
 *
 * 添加新预设主题：
 *   1. globals.css 里加 [data-theme="rack-xxx"] 块
 *   2. 在下方 AVAILABLE_THEMES 里加一项
 *   3. 同步更新 src/renderer/theme-init.ts 的 VALID_THEMES 数组
 *      （早期 FOUC 防护脚本——故意不 import 本文件以保持最轻）
 */

export interface ThemeMeta {
  id: string
  name: string
  description: string
  /** 浅色主题标记 —— applyTheme 据此在 <html> 打 data-theme-mode="light",
      供 CSS 做明暗分叉(如暗色 favicon 不反转)。Custom 主题不设此值,
      运行时按 base 底色亮度派生。 */
  isLight?: boolean
  /**
   * 主题在选择器里的"自我预览"——直接渲染该主题的真实色，不依赖当前文档主题。
   * 3 阶 chrome（base → rack → slot）+ 行字色，足够在 30px 行里让差异肉眼可辨。
   */
  preview: {
    bgBase: string
    bgRack: string
    bgSlot: string
    text: string
  }
}

export interface CustomThemeColors {
  base: string    // 底色 hex (#RRGGBB)
  accent: string  // 焦点色 hex (#RRGGBB)
}

export const DEFAULT_CUSTOM_COLORS: CustomThemeColors = {
  base: '#11151A',
  accent: '#E8A33D'
}

export const AVAILABLE_THEMES: ThemeMeta[] = [
  {
    id: 'rack-graphite',
    name: 'Graphite',
    description: '深石墨 + 钨丝琥珀（默认）',
    preview: { bgBase: '#11151A', bgRack: '#161B20', bgSlot: '#1C2228', text: '#E4E7EA' }
  },
  {
    id: 'rack-slate',
    name: 'Slate',
    description: '偏蓝石板，焦点同琥珀',
    preview: { bgBase: '#0E141B', bgRack: '#131A23', bgSlot: '#18212C', text: '#E2E6EC' }
  },
  {
    id: 'rack-carbon',
    name: 'Carbon',
    description: '中性炭灰，无蓝调',
    preview: { bgBase: '#131313', bgRack: '#181818', bgSlot: '#1E1E1E', text: '#E6E6E6' }
  },
  {
    id: 'rack-paper',
    name: 'Paper',
    description: '自然浅纸 · 石墨墨 + 铜铅笔',
    isLight: true,
    preview: { bgBase: '#ECEAE4', bgRack: '#E4E2DB', bgSlot: '#DBD9D1', text: '#1F1E1A' }
  },
  {
    id: 'rack-ember',
    name: 'Ember',
    description: '暖色暗主题，胡桃木褐 + 暖琥珀',
    preview: { bgBase: '#1A140E', bgRack: '#221A12', bgSlot: '#2A2018', text: '#EFE7DA' }
  },
  {
    id: 'rack-custom',
    name: 'Custom',
    description: 'RGB 自定义底色与焦点色',
    preview: { bgBase: '#11151A', bgRack: '#161B20', bgSlot: '#1C2228', text: '#E4E7EA' }
  }
]

export const DEFAULT_THEME_ID = 'rack-graphite'
export const CUSTOM_THEME_ID = 'rack-custom'
const STORAGE_KEY = 'lyshell.theme'
const CUSTOM_STORAGE_KEY = 'lyshell.theme.custom'

interface ThemeStore {
  themeId: string
  customColors: CustomThemeColors
  setTheme: (id: string) => void
  setCustomColors: (colors: Partial<CustomThemeColors>) => void
  initFromStorage: () => void
}

// ─────────────── 色彩工具 ───────────────

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '').match(/^([0-9a-f]{6})$/i)
  if (!m) return [0, 0, 0]
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break
      case g: h = (b - r) / d + 2; break
      case b: h = (r - g) / d + 4; break
    }
    h /= 6
  }
  return [h * 360, s * 100, l * 100]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h /= 360; s /= 100; l /= 100
  if (s === 0) {
    const v = l * 255
    return [v, v, v]
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1/6) return p + (q - p) * 6 * t
    if (t < 1/2) return q
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    hue2rgb(p, q, h + 1/3) * 255,
    hue2rgb(p, q, h) * 255,
    hue2rgb(p, q, h - 1/3) * 255
  ]
}

function shiftLightness(hex: string, deltaL: number): string {
  const [r, g, b] = hexToRgb(hex)
  const [h, s, l] = rgbToHsl(r, g, b)
  const newL = Math.max(0, Math.min(100, l + deltaL))
  const [nr, ng, nb] = hslToRgb(h, s, newL)
  return rgbToHex(nr, ng, nb)
}

/**
 * 从 base + accent 派生完整 13 阶 CSS 变量字典。
 * - 亮底（luminance > .55）：chrome 阶向暗推（负 delta），文字阶向亮推
 * - 暗底：反之
 * - amber-soft / glow 用 8-bit alpha 后缀
 */
function deriveCustomVars(base: string, accent: string): Record<string, string> {
  const isLight = isLightColor(base)
  const dir = isLight ? -1 : 1  // chrome 移动方向

  // chrome 5 阶 —— elev > slot > rack > strip > base 的明亮序列
  const bgBase  = base
  const bgStrip = shiftLightness(base, dir * 1.5)
  const bgRack  = shiftLightness(base, dir * 3)
  const bgSlot  = shiftLightness(base, dir * 6)
  const bgElev  = shiftLightness(base, dir * 9)

  // rule 阶
  const rule     = shiftLightness(base, dir * 12)
  const ruleSoft = shiftLightness(base, dir * 6)

  // 文字 5 阶 —— rack(最亮/最暗) → faint(最贴近底)
  const textRack      = isLight ? '#1A1F24' : '#E4E7EA'
  const textRackData  = isLight ? '#2D353D' : '#9AA3AB'
  const textRackMute  = isLight ? '#5C6770' : '#6E767D'
  const textRackDim   = isLight ? '#7A8590' : '#4A5159'
  const textRackFaint = isLight ? '#A8B0B7' : '#353C42'

  return {
    '--bg-base':         bgBase,
    '--bg-rack':         bgRack,
    '--bg-slot':         bgSlot,
    '--bg-elev':         bgElev,
    '--bg-strip':        bgStrip,
    '--terminal-bg':     isLight ? base : '#0C0C0C',  // 终端画布:亮底对齐 base,暗底近黑(与预设主题约定一致)
    '--rule':            rule,
    '--rule-soft':       ruleSoft,
    '--text-rack':       textRack,
    '--text-rack-mute':  textRackMute,
    '--text-rack-data':  textRackData,
    '--text-rack-dim':   textRackDim,
    '--text-rack-faint': textRackFaint,
    '--amber':           accent,
    '--amber-soft':      `${accent}22`,
    '--amber-glow':      `${accent}33`
  }
}

function loadCustomColors(): CustomThemeColors {
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (
        typeof parsed?.base === 'string' && /^#[0-9a-f]{6}$/i.test(parsed.base) &&
        typeof parsed?.accent === 'string' && /^#[0-9a-f]{6}$/i.test(parsed.accent)
      ) {
        return { base: parsed.base, accent: parsed.accent }
      }
    }
  } catch {
    // 静默退化
  }
  return DEFAULT_CUSTOM_COLORS
}

function saveCustomColors(colors: CustomThemeColors): void {
  try {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(colors))
  } catch {
    // 静默
  }
}

function applyCustomColors(colors: CustomThemeColors): void {
  if (typeof document === 'undefined') return
  const vars = deriveCustomVars(colors.base, colors.accent)
  const root = document.documentElement
  Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v))
}

function clearCustomColors(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const keys = [
    '--bg-base', '--bg-rack', '--bg-slot', '--bg-elev', '--bg-strip',
    '--terminal-bg',
    '--rule', '--rule-soft',
    '--text-rack', '--text-rack-mute', '--text-rack-data', '--text-rack-dim', '--text-rack-faint',
    '--amber', '--amber-soft', '--amber-glow'
  ]
  keys.forEach(k => root.style.removeProperty(k))
}

function applyTheme(id: string, customColors: CustomThemeColors) {
  if (typeof document === 'undefined') return
  const valid = AVAILABLE_THEMES.some(t => t.id === id) ? id : DEFAULT_THEME_ID
  document.documentElement.dataset.theme = valid
  // 明暗标记:预设取元数据,Custom 按 base 底色亮度派生(浅底 Custom 同样算浅色主题)。
  // CSS 侧明暗分叉(如 .webtab-favicon-dark 豁免反转)看 data-theme-mode,不再枚举主题名。
  const isLight = valid === CUSTOM_THEME_ID
    ? isLightColor(customColors.base)
    : !!AVAILABLE_THEMES.find(t => t.id === valid)?.isLight
  document.documentElement.dataset.themeMode = isLight ? 'light' : 'dark'
  if (valid === CUSTOM_THEME_ID) {
    applyCustomColors(customColors)
  } else {
    clearCustomColors()
  }
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  themeId: DEFAULT_THEME_ID,
  customColors: DEFAULT_CUSTOM_COLORS,

  setTheme: (id) => {
    const valid = AVAILABLE_THEMES.some(t => t.id === id) ? id : DEFAULT_THEME_ID
    applyTheme(valid, get().customColors)
    try {
      localStorage.setItem(STORAGE_KEY, valid)
    } catch {
      // localStorage 不可用就算了，下次启动回默认
    }
    set({ themeId: valid })
  },

  setCustomColors: (patch) => {
    const next = { ...get().customColors, ...patch }
    saveCustomColors(next)
    // 如果当前正用 Custom 主题，立即重新注入
    if (get().themeId === CUSTOM_THEME_ID) {
      applyCustomColors(next)
    }
    set({ customColors: next })
  },

  initFromStorage: () => {
    let saved: string | null = null
    try {
      saved = localStorage.getItem(STORAGE_KEY)
    } catch {
      // 静默退化
    }
    const valid = saved && AVAILABLE_THEMES.some(t => t.id === saved) ? saved : DEFAULT_THEME_ID
    const customColors = loadCustomColors()
    applyTheme(valid, customColors)
    set({ themeId: valid, customColors })
  }
}))
