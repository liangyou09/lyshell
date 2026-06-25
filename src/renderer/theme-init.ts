/**
 * 早期主题预设 — 在 React 挂载前同步还原用户上次选中的主题
 * 必须放在外部脚本：renderer 的 CSP `script-src 'self'` 会拦截 inline <script>
 * （无 nonce/unsafe-inline），inline 版本曾导致 FOUC 防护失效。
 *
 * 这里硬编码主题白名单——故意不 import theme-store：那样会把 zustand + 整套 store 同步拉进
 * 早期路径，违背"最轻"原则。代价是新增/重命名主题需要在两处同步：
 *   1. src/renderer/stores/theme-store.ts → AVAILABLE_THEMES
 *   2. 这里的 VALID_THEMES
 */
const VALID_THEMES = ['rack-graphite', 'rack-slate', 'rack-carbon']

try {
  const saved = localStorage.getItem('lyshell.theme')
  if (saved && VALID_THEMES.includes(saved)) {
    document.documentElement.dataset.theme = saved
  }
  // 脏数据（旧版主题名 / 手改） — 保留 HTML 上的默认 data-theme，
  // theme-store.initFromStorage 会在挂载后纠正回 DEFAULT_THEME_ID
} catch {
  // localStorage 不可用（隐私模式/磁盘问题）— 保留默认
}
