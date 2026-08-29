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
const VALID_THEMES = ['rack-graphite', 'rack-slate', 'rack-carbon', 'rack-paper', 'rack-ember', 'rack-custom']

try {
  const saved = localStorage.getItem('lyshell.theme')
  if (saved && VALID_THEMES.includes(saved)) {
    document.documentElement.dataset.theme = saved
    // 明暗标记(浅色主题不反转暗色 favicon 等 CSS 据此分叉)—— 须与 theme-store
    // 的 isLight 判定保持一致:预设硬编码 rack-paper,Custom 下方按 base 亮度算
    document.documentElement.dataset.themeMode = saved === 'rack-paper' ? 'light' : 'dark'
    // Custom 主题需要早期注入 inline 颜色 —— 否则会闪一帧 fallback(graphite)。
    // 这里走最轻路径:解析 JSON + setProperty,不引入 HSL 派生(那部分代码在 theme-store)。
    // 若 customColors 缺失或脏数据,store 挂载后会补一次完整 applyTheme。
    if (saved === 'rack-custom') {
      try {
        const raw = localStorage.getItem('lyshell.theme.custom')
        if (raw) {
          const c = JSON.parse(raw)
          if (
            typeof c?.base === 'string' && /^#[0-9a-f]{6}$/i.test(c.base) &&
            typeof c?.accent === 'string' && /^#[0-9a-f]{6}$/i.test(c.accent)
          ) {
            // 只设最显眼的几个变量做首帧防闪 —— 完整 13 阶在 store 挂载后注入
            document.documentElement.style.setProperty('--bg-base', c.base)
            document.documentElement.style.setProperty('--amber', c.accent)
            // 终端画布底色:亮底用 base,暗底近黑(#0C0C0C) -- 防 FOUC,完整派生在 store 挂载后注入
            const tbHex = c.base.slice(1)
            const tbV = parseInt(tbHex, 16) || 0
            const tbLum = (0.299 * ((tbV >> 16) & 0xff) + 0.587 * ((tbV >> 8) & 0xff) + 0.114 * (tbV & 0xff)) / 255
            // 阈值 0.55 须与 @shared/color-utils 的 LIGHT_LUMINANCE_THRESHOLD 保持一致
            // (早期 FOUC 脚本须自包含,不能 import;改阈值时两处同步)
            document.documentElement.style.setProperty('--terminal-bg', tbLum > 0.55 ? c.base : '#0C0C0C')
            // Custom 的明暗随 base 底色 —— 与 theme-store 的 isLightColor 派生同规则
            document.documentElement.dataset.themeMode = tbLum > 0.55 ? 'light' : 'dark'
          }
        }
      } catch {
        // 自定义色脏数据 —— 留给 store 修正
      }
    }
  }
  // 脏数据（旧版主题名 / 手改） — 保留 HTML 上的默认 data-theme，
  // theme-store.initFromStorage 会在挂载后纠正回 DEFAULT_THEME_ID
} catch {
  // localStorage 不可用（隐私模式/磁盘问题）— 保留默认
}
