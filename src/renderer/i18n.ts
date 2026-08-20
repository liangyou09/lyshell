import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import zh from './locales/zh.json'

/**
 * i18next 初始化（副作用模块）
 *
 * 镜像 theme-init 的自包含读法：直接读 localStorage['lyshell.locale']，
 * 故意不 import locale-store —— 否则 locale-store 又 import 本模块驱动 changeLanguage，
 * 形成循环。locale-store 单向依赖本模块。
 *
 * 关键：用 saved 而非硬编码 'en' 初始化 lng，保证首帧 React paint 就是用户上次的语言，
 * 不会闪一帧英文。lang-init.ts 更早设 <html lang> 供 a11y。
 */

const VALID_LOCALES = ['en', 'zh']
const STORAGE_KEY = 'lyshell.locale'

function readSavedLocale(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && VALID_LOCALES.includes(saved)) return saved
  } catch { /* localStorage 不可用，回退默认 */ }
  return 'en'
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh }
    },
    lng: readSavedLocale(),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },  // React 自带转义
    keySeparator: '.',
    // 开发期安全网：缺失 key 打 console，迁移完成前任何漏网都会暴露
    saveMissing: true,
    missingKeyHandler: (lngs, _ns, key) => {
      console.warn(`[i18n] missing key: ${key} (${lngs.join(',')})`)
    }
  })

export default i18n
