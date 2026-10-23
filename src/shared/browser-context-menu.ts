/**
 * 内置浏览器右键菜单的纯数据模型（shared，不依赖 Electron）。
 *
 * 菜单由主进程收集右键现场后交给独立菜单窗口渲染，渲染层只消费本文件描述的
 * BrowserMenuData：顶部是常驻历史工具栏，下面按「链接 → 图片 → 编辑 → 选中文本
 * → 页面 → 检查元素」分组。所有可见文案在这里一次性按 locale 固化，菜单窗口
 * 不需要再读 i18n 资源。
 *
 * 安全边界（与主进程动作实现保持一致）：
 * - 链接只对 http/https 提供「打开 / 另存为」，其它协议（file:、javascript: 等）
 *   只能复制链接本身。
 * - 图片只对 http/https/blob/data 出组，file: 等本地协议整组不出现；「打开图片」
 *   仅限 http/https。
 * - 密码字段绝不提供剪切/复制（不出现，而不是置灰），任何展示字段都不含
 *   selectionText；页面 URL 含用户名/密码时只展示 hostname(+port)+pathname，
 *   userinfo、query、hash 一律不进入菜单数据。
 * - 不提供新窗口/无痕窗口/扩展/翻译等本应用没有实现的动作，避免点了没反应。
 */

export const BROWSER_MENU_CHANNEL = 'browser-menu:request'

/** 菜单动作全量白名单：preload / 主进程可据此校验不可信的 IPC 入参。 */
export const BROWSER_MENU_ACTIONS = [
  'back',
  'forward',
  'reload',
  'open-link',
  'copy-link',
  'copy-link-text',
  'save-link',
  'open-image',
  'copy-image',
  'copy-image-url',
  'save-image',
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'select-all',
  'search-selection',
  'copy-page-url',
  'save-page',
  'inspect'
] as const

export type BrowserMenuAction = (typeof BROWSER_MENU_ACTIONS)[number]
export type BrowserMenuLocale = 'zh' | 'en'
export type BrowserMenuTheme = 'dark' | 'light'

export interface BrowserMenuItem {
  id: BrowserMenuAction
  label: string
  enabled: boolean
  shortcut?: string
}

export interface BrowserMenuData {
  locale: BrowserMenuLocale
  theme: BrowserMenuTheme
  title: string
  detail: string
  toolbar: BrowserMenuItem[]
  groups: BrowserMenuItem[][]
}

export interface BrowserMenuEditFlags {
  canUndo: boolean
  canRedo: boolean
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
  canSelectAll: boolean
}

/** 主进程从 ContextMenuParams 映射出的纯数据现场（字段均可安全跨进程传递）。 */
export interface BrowserMenuContext {
  locale: BrowserMenuLocale
  theme: BrowserMenuTheme
  pageUrl: string
  canGoBack: boolean
  canGoForward: boolean
  /** 右键落点在链接上时的地址；空串表示不是链接。 */
  linkUrl: string
  linkText: string
  /** 右键落点在图片上时的地址；非图片为空串。 */
  srcUrl: string
  /** ContextMenuParams.mediaType（'image' / 'none' / …）。 */
  mediaType: string
  hasImageContents: boolean
  isEditable: boolean
  isPassword: boolean
  selectionText: string
  editFlags: BrowserMenuEditFlags
  canSearch: boolean
}

export type BrowserMenuRequest =
  | { kind: 'get' }
  | { kind: 'ready' }
  | { kind: 'dismiss' }
  | { kind: 'action'; id: BrowserMenuAction }

export interface BrowserMenuAPI {
  request: (request: BrowserMenuRequest) => Promise<BrowserMenuData | boolean | null>
}

const ACTION_SET: ReadonlySet<string> = new Set(BROWSER_MENU_ACTIONS)

/** IPC 边界到达的 action 不可信：白名单收窄后才允许转发到主进程动作。 */
export function isBrowserMenuAction(value: unknown): value is BrowserMenuAction {
  return typeof value === 'string' && ACTION_SET.has(value)
}

const LABELS: Record<BrowserMenuLocale, Record<BrowserMenuAction, string>> = {
  zh: {
    back: '后退',
    forward: '前进',
    reload: '刷新',
    'open-link': '在新标签页中打开链接',
    'copy-link': '复制链接',
    'copy-link-text': '复制链接文字',
    'save-link': '链接另存为',
    'open-image': '在新标签页打开图片',
    'copy-image': '复制图片',
    'copy-image-url': '复制图片地址',
    'save-image': '保存图片',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    'select-all': '全选',
    'search-selection': '搜索所选文字',
    'copy-page-url': '复制页面地址',
    'save-page': '网页另存为',
    inspect: '检查元素'
  },
  en: {
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    'open-link': 'Open link in new tab',
    'copy-link': 'Copy link',
    'copy-link-text': 'Copy link text',
    'save-link': 'Save link as',
    'open-image': 'Open image in new tab',
    'copy-image': 'Copy image',
    'copy-image-url': 'Copy image address',
    'save-image': 'Save image',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    'select-all': 'Select all',
    'search-selection': 'Search for selected text',
    'copy-page-url': 'Copy page address',
    'save-page': 'Save page as',
    inspect: 'Inspect element'
  }
}

type BrowserMenuTitleKey = 'link' | 'image' | 'text' | 'input' | 'page'

/** 无字母 kicker 的小标题：只描述右键语境。 */
const TITLES: Record<BrowserMenuLocale, Record<BrowserMenuTitleKey, string>> = {
  zh: { link: '链接', image: '图片', text: '文本', input: '输入框', page: '页面' },
  en: { link: 'Link', image: 'Image', text: 'Text', input: 'Input', page: 'Page' }
}

/** 选区预览上限（按 Unicode 码点计，避免截断代理对）。 */
const SELECTION_PREVIEW_LIMIT = 60

const IMAGE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'blob:', 'data:'])

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseWebUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** 链接的打开/另存为只认 http/https。 */
function isHttpUrl(raw: string): boolean {
  return parseWebUrl(raw) !== null
}

/** 图片的复制/下载只认 http/https/blob/data；file: 等本地协议整组不出现。 */
function isImageSource(raw: string): boolean {
  try {
    return IMAGE_PROTOCOLS.has(new URL(raw).protocol)
  } catch {
    return false
  }
}

/**
 * 展示用的可读目标：只拼 host（含端口）+ pathname。
 * URL.host 天然不含 userinfo，query/hash 也不参与拼接，因此不会把凭据带进菜单。
 */
function readableTarget(raw: string): string {
  const url = parseWebUrl(raw)
  if (!url || !url.hostname) return ''
  return `${url.host}${url.pathname}`
}

/** 空白折叠 + 码点级截断到 60 字符，超出补省略号（总长仍为 60）。 */
function selectionPreview(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim()
  const chars = Array.from(text)
  if (chars.length <= SELECTION_PREVIEW_LIMIT) return text
  return `${chars.slice(0, SELECTION_PREVIEW_LIMIT - 1).join('')}…`
}

/**
 * 根据右键现场生成独立菜单窗口需要的完整数据。
 * 纯函数：同样的 BrowserMenuContext 永远得到同样的 BrowserMenuData。
 */
export function buildBrowserMenu(context: BrowserMenuContext): BrowserMenuData {
  const locale: BrowserMenuLocale = context.locale === 'en' ? 'en' : 'zh'
  const theme: BrowserMenuTheme = context.theme === 'light' ? 'light' : 'dark'
  const labels = LABELS[locale]

  const make = (id: BrowserMenuAction, enabled: boolean, shortcut?: string): BrowserMenuItem => {
    const menuItem: BrowserMenuItem = { id, label: labels[id], enabled }
    if (shortcut) menuItem.shortcut = shortcut
    return menuItem
  }

  const pageUrl = asText(context.pageUrl).trim()
  const linkUrl = asText(context.linkUrl).trim()
  const linkText = asText(context.linkText).trim()
  const srcUrl = asText(context.srcUrl).trim()
  const selectionText = asText(context.selectionText)
  const hasSelection = selectionText.trim().length > 0

  const onImage = context.hasImageContents === true && context.mediaType === 'image' && isImageSource(srcUrl)
  const flags = context.editFlags

  const toolbar: BrowserMenuItem[] = [
    make('back', context.canGoBack === true, 'Alt+←'),
    make('forward', context.canGoForward === true, 'Alt+→'),
    make('reload', true, 'F5')
  ]

  const groups: BrowserMenuItem[][] = []

  // 链接组：只有 http/https 才有打开/另存为，其它协议仅保留复制链接。
  if (linkUrl) {
    if (isHttpUrl(linkUrl)) {
      const linkGroup: BrowserMenuItem[] = [
        make('open-link', true),
        make('copy-link', true)
      ]
      if (linkText) linkGroup.push(make('copy-link-text', true))
      linkGroup.push(make('save-link', true))
      groups.push(linkGroup)
    } else {
      groups.push([make('copy-link', true)])
    }
  }

  // 图片组：协议白名单不通过时整组不出现。
  if (onImage) {
    const imageGroup: BrowserMenuItem[] = []
    if (isHttpUrl(srcUrl)) imageGroup.push(make('open-image', true))
    imageGroup.push(make('copy-image', true), make('copy-image-url', true), make('save-image', true))
    groups.push(imageGroup)
  }

  // 输入框：撤销/重做单独成组；剪切/复制/粘贴/全选一组。
  // 密码字段不提供剪切/复制（项都不出现），避免内容被送进剪贴板。
  if (context.isEditable) {
    groups.push([
      make('undo', flags.canUndo === true, 'Ctrl+Z'),
      make('redo', flags.canRedo === true, 'Ctrl+Y')
    ])

    const editGroup: BrowserMenuItem[] = []
    if (context.isPassword !== true) {
      editGroup.push(make('cut', flags.canCut === true, 'Ctrl+X'), make('copy', flags.canCopy === true, 'Ctrl+C'))
    }
    editGroup.push(make('paste', flags.canPaste === true, 'Ctrl+V'), make('select-all', flags.canSelectAll === true, 'Ctrl+A'))
    groups.push(editGroup)
  }

  // 普通选中文本：复制；可搜索且选区非空时追加「搜索所选文字」。
  // 标签固定，绝不把整段选区拼进 label。密码标记优先于 isEditable（防御异常现场）。
  if (!context.isEditable && context.isPassword !== true && hasSelection) {
    const selectionGroup: BrowserMenuItem[] = [make('copy', true, 'Ctrl+C')]
    if (context.canSearch === true) selectionGroup.push(make('search-selection', true))
    groups.push(selectionGroup)
  }

  // 页面组常驻；非 http/https 页面两项置灰而不是隐藏。
  const webPage = isHttpUrl(pageUrl)
  groups.push([make('copy-page-url', webPage), make('save-page', webPage)])
  groups.push([make('inspect', true, 'F12')])

  const titleKey: BrowserMenuTitleKey = linkUrl
    ? 'link'
    : onImage
      ? 'image'
      : context.isEditable || context.isPassword === true
        ? 'input'
        : hasSelection
          ? 'text'
          : 'page'
  const title = TITLES[locale][titleKey]

  // 展示字段优先级：链接目标 → 图片地址 → 选区预览（密码除外）→ 页面地址 → 空。
  const linkDetail = linkUrl ? readableTarget(linkUrl) : ''
  const imageDetail = onImage ? readableTarget(srcUrl) : ''
  const pageDetail = readableTarget(pageUrl)
  const preview = context.isPassword === true || !hasSelection ? '' : selectionPreview(selectionText)
  const detail = linkDetail || imageDetail || preview || pageDetail || ''

  return { locale, theme, title, detail, toolbar, groups }
}
