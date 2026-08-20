/**
 * 早期语言预设 — 在 React 挂载前同步设置 <html lang>，供 a11y / 屏幕阅读器。
 *
 * 镜像 theme-init.ts：故意不 import locale-store（会把 zustand 拉进早期路径，违背"最轻"原则）。
 * i18n.ts 会在 main.tsx 里用同一个 localStorage key 初始化 i18next 的 lng —— 那才是真正的语言初始化。
 * 这里只管 <html lang>，保证首帧 a11y 属性正确。
 *
 * CSP `script-src 'self'` 允许外部模块脚本（同 theme-init），故放在独立文件。
 */
const VALID_LOCALES = ['en', 'zh']
const LOCALE_TO_HTML: Record<string, string> = { en: 'en', zh: 'zh-CN' }

try {
  const saved = localStorage.getItem('lyshell.locale')
  const lng = saved && VALID_LOCALES.includes(saved) ? saved : 'en'
  document.documentElement.lang = LOCALE_TO_HTML[lng] ?? 'en'
} catch {
  document.documentElement.lang = 'en'
}
