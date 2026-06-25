import { create } from 'zustand'

/**
 * 主题系统
 *
 * 每个主题在 globals.css 里通过 [data-theme="..."] 定义完整 CSS 变量集合。
 * 此 store 负责：
 *   - 切换 document.documentElement.dataset.theme
 *   - 通过 localStorage 持久化（早期同步加载在 index.html 里完成，避免 FOUC）
 *
 * 添加新主题：
 *   1. globals.css 里加 [data-theme="rack-xxx"] 块
 *   2. 在下方 AVAILABLE_THEMES 里加一项
 *   3. 同步更新 src/renderer/theme-init.ts 的 VALID_THEMES 数组
 *      （早期 FOUC 防护脚本——故意不 import 本文件以保持最轻）
 */

export interface ThemeMeta {
  id: string
  name: string
  description: string
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
  }
]

export const DEFAULT_THEME_ID = 'rack-graphite'
const STORAGE_KEY = 'lyshell.theme'

interface ThemeStore {
  themeId: string
  setTheme: (id: string) => void
  initFromStorage: () => void
}

function applyTheme(id: string) {
  if (typeof document === 'undefined') return
  const valid = AVAILABLE_THEMES.some(t => t.id === id) ? id : DEFAULT_THEME_ID
  document.documentElement.dataset.theme = valid
}

export const useThemeStore = create<ThemeStore>((set) => ({
  themeId: DEFAULT_THEME_ID,

  setTheme: (id) => {
    const valid = AVAILABLE_THEMES.some(t => t.id === id) ? id : DEFAULT_THEME_ID
    applyTheme(valid)
    try {
      localStorage.setItem(STORAGE_KEY, valid)
    } catch {
      // localStorage 不可用就算了，下次启动回默认
    }
    set({ themeId: valid })
  },

  initFromStorage: () => {
    let saved: string | null = null
    try {
      saved = localStorage.getItem(STORAGE_KEY)
    } catch {
      // 静默退化
    }
    const valid = saved && AVAILABLE_THEMES.some(t => t.id === saved) ? saved : DEFAULT_THEME_ID
    applyTheme(valid)
    set({ themeId: valid })
  }
}))
