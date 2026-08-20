import { create } from 'zustand'
import i18n from '../i18n'

/**
 * 语言 store —— 镜像 theme-store.ts 的形态
 *
 *   - plain create()（不用 persist 中间件）
 *   - 手动 localStorage get/set
 *   - 副作用（<html lang> + i18n.changeLanguage）直接在 setLocale 里
 *   - initFromStorage() 供 MainWindow 挂载时同步 store 状态
 *
 * setLocale 调 i18n.changeLanguage(id) 是 Zustand→i18next 的单向响应桥——
 * 触发所有 useTranslation() 消费者重渲染，无需手动 forceUpdate。
 *
 * LocaleMeta.name 用目标语言自身书写（English / 中文），不随当前语言变——
 * 这样语言选择器里每项永远可辨。
 */

export interface LocaleMeta {
  id: string
  /** 用目标语言自身书写，不随当前语言变（English 永远叫 English） */
  name: string
  /** BCP-47，用于 <html lang> */
  htmlLang: string
}

export const AVAILABLE_LOCALES: LocaleMeta[] = [
  { id: 'en', name: 'English', htmlLang: 'en' },
  { id: 'zh', name: '中文', htmlLang: 'zh-CN' }
]

export const DEFAULT_LOCALE_ID = 'en'
const STORAGE_KEY = 'lyshell.locale'

interface LocaleStore {
  localeId: string
  setLocale: (id: string) => void
  initFromStorage: () => void
}

function applyLocale(id: string): void {
  const valid = AVAILABLE_LOCALES.some(l => l.id === id) ? id : DEFAULT_LOCALE_ID
  const meta = AVAILABLE_LOCALES.find(l => l.id === valid)
  if (typeof document !== 'undefined') {
    document.documentElement.lang = meta?.htmlLang ?? DEFAULT_LOCALE_ID
  }
  // i18n.ts 已在 init 时用 saved 设过 lng;这里若已是同一语言就跳过,
  // 避免挂载时 initFromStorage 多播一次 languageChanged(无副作用但多余)。
  if (i18n.language !== valid) {
    void i18n.changeLanguage(valid)
  }
}

export const useLocaleStore = create<LocaleStore>((set) => ({
  localeId: DEFAULT_LOCALE_ID,

  setLocale: (id) => {
    const valid = AVAILABLE_LOCALES.some(l => l.id === id) ? id : DEFAULT_LOCALE_ID
    applyLocale(valid)
    try { localStorage.setItem(STORAGE_KEY, valid) } catch { /* localStorage 不可用就静默 */ }
    // 同步到 preferences，供主进程（MCP 确认弹窗等）读取当前 UI 语言
    try { window.electronAPI?.setConfig('locale', valid) } catch { /* 静默 */ }
    set({ localeId: valid })
  },

  // i18n.ts 已用 saved 初始化过 lng；这里只同步 store 状态 + <html lang>，
  // 供 Settings 选择器显示当前值。镜像 theme-store.initFromStorage。
  initFromStorage: () => {
    let saved: string | null = null
    try { saved = localStorage.getItem(STORAGE_KEY) } catch { /* 静默 */ }
    const valid = saved && AVAILABLE_LOCALES.some(l => l.id === saved) ? saved : DEFAULT_LOCALE_ID
    applyLocale(valid)
    set({ localeId: valid })
  }
}))
