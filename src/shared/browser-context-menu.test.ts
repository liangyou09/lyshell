import { describe, expect, it } from 'vitest'
import {
  BROWSER_MENU_ACTIONS,
  BROWSER_MENU_CHANNEL,
  buildBrowserMenu,
  isBrowserMenuAction
} from './browser-context-menu'
import type {
  BrowserMenuAction,
  BrowserMenuContext,
  BrowserMenuData,
  BrowserMenuItem
} from './browser-context-menu'

function context(
  patch: Partial<BrowserMenuContext> = {},
  flags: Partial<BrowserMenuContext['editFlags']> = {}
): BrowserMenuContext {
  return {
    locale: 'zh',
    theme: 'dark',
    pageUrl: 'https://example.com/docs/page?q=1#top',
    canGoBack: true,
    canGoForward: false,
    linkUrl: '',
    linkText: '',
    srcUrl: '',
    mediaType: 'none',
    hasImageContents: false,
    isEditable: false,
    isPassword: false,
    selectionText: '',
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false,
      ...flags
    },
    canSearch: true,
    ...patch
  }
}

function ids(items: BrowserMenuItem[]): BrowserMenuAction[] {
  return items.map(item => item.id)
}

function groupIds(menu: BrowserMenuData): BrowserMenuAction[][] {
  return menu.groups.map(ids)
}

function itemOf(menu: BrowserMenuData, id: BrowserMenuAction): BrowserMenuItem | undefined {
  return [...menu.toolbar, ...menu.groups.flat()].find(item => item.id === id)
}

function allIds(menu: BrowserMenuData): BrowserMenuAction[] {
  return ids([...menu.toolbar, ...menu.groups.flat()])
}

function serialized(menu: BrowserMenuData): string {
  return JSON.stringify(menu)
}

const ALL_ACTIONS: BrowserMenuAction[] = [...BROWSER_MENU_ACTIONS]

const ZH_LABELS: Record<BrowserMenuAction, string> = {
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
}

const EN_LABELS: Record<BrowserMenuAction, string> = {
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

describe('浏览器右键菜单模型：通道与动作白名单', () => {
  it('导出固定 IPC 通道', () => {
    expect(BROWSER_MENU_CHANNEL).toBe('browser-menu:request')
  })

  it('动作白名单完整且无重复，不含未实现的新窗口/无痕/扩展/翻译', () => {
    expect(ALL_ACTIONS).toHaveLength(21)
    expect(new Set(ALL_ACTIONS).size).toBe(21)
    expect(ALL_ACTIONS).toEqual(
      expect.arrayContaining([
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
      ])
    )
    for (const unexpected of ['new-window', 'incognito', 'extensions', 'translate', 'print']) {
      expect(ALL_ACTIONS).not.toContain(unexpected)
    }
  })

  it('isBrowserMenuAction 只接受白名单内的字符串', () => {
    expect(isBrowserMenuAction('back')).toBe(true)
    expect(isBrowserMenuAction('copy-page-url')).toBe(true)
    expect(isBrowserMenuAction('new-window')).toBe(false)
    expect(isBrowserMenuAction('')).toBe(false)
    expect(isBrowserMenuAction(null)).toBe(false)
    expect(isBrowserMenuAction(42)).toBe(false)
    expect(isBrowserMenuAction({ id: 'back' })).toBe(false)
  })
})

describe('浏览器右键菜单模型：页面基础菜单', () => {
  it('顶部工具栏常驻 back/forward/reload，禁用态跟随历史', () => {
    const menu = buildBrowserMenu(context({ canGoBack: false, canGoForward: true }))

    expect(ids(menu.toolbar)).toEqual(['back', 'forward', 'reload'])
    expect(menu.toolbar.map(item => item.label)).toEqual(['后退', '前进', '刷新'])
    expect(menu.toolbar.map(item => item.enabled)).toEqual([false, true, true])
  })

  it('页面组与检查元素组按固定顺序收尾', () => {
    const menu = buildBrowserMenu(context())

    expect(groupIds(menu)).toEqual([
      ['copy-page-url', 'save-page'],
      ['inspect']
    ])
    expect(itemOf(menu, 'copy-page-url')?.enabled).toBe(true)
    expect(itemOf(menu, 'save-page')?.enabled).toBe(true)
    expect(itemOf(menu, 'inspect')).toMatchObject({ enabled: true, shortcut: 'F12' })
    expect(menu.title).toBe('页面')
    expect(menu.detail).toBe('example.com/docs/page')
    expect(menu.locale).toBe('zh')
    expect(menu.theme).toBe('dark')
  })

  it('所有 id 都来自动作白名单', () => {
    const menu = buildBrowserMenu(context())
    for (const id of allIds(menu)) expect(ALL_ACTIONS).toContain(id)
  })

  it('权限字段按入参透传主题并支持英文', () => {
    const menu = buildBrowserMenu(context({ locale: 'en', theme: 'light' }))

    expect(menu.locale).toBe('en')
    expect(menu.theme).toBe('light')
    expect(menu.title).toBe('Page')
    expect(menu.toolbar.map(item => item.label)).toEqual(['Back', 'Forward', 'Reload'])
    expect(groupIds(menu)).toEqual([
      ['copy-page-url', 'save-page'],
      ['inspect']
    ])
  })
})

describe('浏览器右键菜单模型：完整分组', () => {
  const full = context(
    {
      pageUrl: 'https://example.com/docs/page?q=1#top',
      canGoForward: true,
      linkUrl: 'https://user:pass@shop.example.com:8443/a/b?token=secret#frag',
      linkText: '示例链接',
      srcUrl: 'https://cdn.example.com/img/pic.png?token=secret',
      mediaType: 'image',
      hasImageContents: true
    },
    { canCopy: true }
  )

  it('链接 + 图片 + 页面 + 检查元素按顺序成组', () => {
    const menu = buildBrowserMenu(full)

    expect(groupIds(menu)).toEqual([
      ['open-link', 'copy-link', 'copy-link-text', 'save-link'],
      ['open-image', 'copy-image', 'copy-image-url', 'save-image'],
      ['copy-page-url', 'save-page'],
      ['inspect']
    ])
    expect(menu.title).toBe('链接')
    expect(menu.toolbar.map(item => item.enabled)).toEqual([true, true, true])
  })

  it('链接选中时展示字段只含 host+path，凭据与 query 不外泄', () => {
    const menu = buildBrowserMenu(full)

    expect(menu.detail).toBe('shop.example.com:8443/a/b')
    const json = serialized(menu)
    expect(json).not.toContain('user:pass')
    expect(json).not.toContain('token=secret')
    expect(json).not.toContain('shop.example.com:8443/a/b?')
  })

  it('链接 + 图片语境覆盖工具栏与 11 个上下文动作', () => {
    const menu = buildBrowserMenu(full)
    const covered = new Set(allIds(menu))

    expect(covered.has('open-link')).toBe(true)
    expect(covered.has('copy-link-text')).toBe(true)
    expect(covered.has('open-image')).toBe(true)
    expect(covered.has('save-image')).toBe(true)
    expect(covered.size).toBe(14)
  })
})

describe('浏览器右键菜单模型：链接上下文', () => {
  it('http 链接缺少文字时不显示复制链接文字', () => {
    const menu = buildBrowserMenu(context({ linkUrl: 'https://example.com/a' }))

    expect(groupIds(menu)[0]).toEqual(['open-link', 'copy-link', 'save-link'])
    expect(menu.title).toBe('链接')
    expect(menu.detail).toBe('example.com/a')
  })

  it('非 http/https 链接只保留复制链接，展示字段回退到页面', () => {
    for (const linkUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@example.com']) {
      const menu = buildBrowserMenu(context({ linkUrl, linkText: '文字' }))

      expect(groupIds(menu)[0]).toEqual(['copy-link'])
      expect(menu.title).toBe('链接')
      expect(menu.detail).toBe('example.com/docs/page')
      expect(itemOf(menu, 'open-link')).toBeUndefined()
      expect(itemOf(menu, 'save-link')).toBeUndefined()
    }
  })

  it('链接地址自身带端口时保留端口但去掉用户名密码', () => {
    const menu = buildBrowserMenu(
      context({ linkUrl: 'https://alice:hunter2@example.com:9443/x/y?sid=1#h' })
    )

    expect(menu.detail).toBe('example.com:9443/x/y')
    expect(serialized(menu)).not.toContain('hunter2')
    expect(serialized(menu)).not.toContain('alice:')
  })
})

describe('浏览器右键菜单模型：图片上下文', () => {
  it('http 图片提供打开/复制/复制地址/保存', () => {
    const menu = buildBrowserMenu(
      context({
        srcUrl: 'https://cdn.example.com/img/pic.png?token=secret',
        mediaType: 'image',
        hasImageContents: true
      })
    )

    expect(groupIds(menu)[0]).toEqual(['open-image', 'copy-image', 'copy-image-url', 'save-image'])
    expect(menu.title).toBe('图片')
    expect(menu.detail).toBe('cdn.example.com/img/pic.png')
  })

  it('blob/data 图片不提供打开项，且不把地址内容放进展示字段', () => {
    const blob = buildBrowserMenu(
      context({
        srcUrl: 'blob:https://example.com/2f7b-uuid',
        mediaType: 'image',
        hasImageContents: true
      })
    )
    expect(groupIds(blob)[0]).toEqual(['copy-image', 'copy-image-url', 'save-image'])
    expect(blob.detail).toBe('example.com/docs/page')
    expect(serialized(blob)).not.toContain('blob:')

    const data = buildBrowserMenu(
      context({
        srcUrl: 'data:image/png;base64,AAAA',
        mediaType: 'image',
        hasImageContents: true
      })
    )
    expect(groupIds(data)[0]).toEqual(['copy-image', 'copy-image-url', 'save-image'])
    expect(serialized(data)).not.toContain('base64')
    expect(serialized(data)).not.toContain('data:image')
  })

  it('本地文件、缺少图片内容或 mediaType 不匹配时整组不出现', () => {
    const fileImage = buildBrowserMenu(
      context({ srcUrl: 'file:///tmp/a.png', mediaType: 'image', hasImageContents: true })
    )
    expect(groupIds(fileImage)).toEqual([
      ['copy-page-url', 'save-page'],
      ['inspect']
    ])

    const noContents = buildBrowserMenu(
      context({ srcUrl: 'https://cdn.example.com/a.png', mediaType: 'image', hasImageContents: false })
    )
    expect(noContents.groups.flat().some(item => item.id === 'copy-image')).toBe(false)

    const notImage = buildBrowserMenu(
      context({ srcUrl: 'https://cdn.example.com/a.png', mediaType: 'video', hasImageContents: true })
    )
    expect(notImage.groups.flat().some(item => item.id === 'copy-image')).toBe(false)
  })
})

describe('浏览器右键菜单模型：输入框与密码', () => {
  it('普通输入框按 editFlags 严格禁用并分两组', () => {
    const menu = buildBrowserMenu(
      context({ isEditable: true }, { canUndo: true, canCut: true, canPaste: true })
    )

    expect(groupIds(menu)).toEqual([
      ['undo', 'redo'],
      ['cut', 'copy', 'paste', 'select-all'],
      ['copy-page-url', 'save-page'],
      ['inspect']
    ])
    expect(itemOf(menu, 'undo')?.enabled).toBe(true)
    expect(itemOf(menu, 'redo')?.enabled).toBe(false)
    expect(itemOf(menu, 'cut')?.enabled).toBe(true)
    expect(itemOf(menu, 'copy')?.enabled).toBe(false)
    expect(itemOf(menu, 'paste')?.enabled).toBe(true)
    expect(itemOf(menu, 'select-all')?.enabled).toBe(false)
    expect(menu.title).toBe('输入框')
  })

  it('所有编辑 flag 为假时仍保留全部项但一律置灰', () => {
    const menu = buildBrowserMenu(context({ isEditable: true }))
    const editItems = [...menu.groups[0], ...menu.groups[1]]

    expect(ids(editItems)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'select-all'])
    expect(editItems.every(item => item.enabled === false)).toBe(true)
  })

  it('编辑框内有选中文本时不再重复出选区组', () => {
    const menu = buildBrowserMenu(
      context({ isEditable: true, selectionText: 'hello world', canSearch: true })
    )

    expect(menu.groups.flat().filter(item => item.id === 'copy')).toHaveLength(1)
    expect(menu.groups.flat().some(item => item.id === 'search-selection')).toBe(false)
  })

  it('密码字段不提供剪切/复制，内容绝不出现在菜单数据里', () => {
    const pageUrl = 'https://alice:hunter2@mail.example.com/inbox?sid=abc#top'
    const menu = buildBrowserMenu(
      context(
        {
          pageUrl,
          isEditable: true,
          isPassword: true,
          selectionText: 'my-secret-password',
          canSearch: true
        },
        { canUndo: true, canPaste: true }
      )
    )

    expect(groupIds(menu)).toEqual([
      ['undo', 'redo'],
      ['paste', 'select-all'],
      ['copy-page-url', 'save-page'],
      ['inspect']
    ])
    expect(allIds(menu)).not.toContain('cut')
    expect(allIds(menu)).not.toContain('copy')
    expect(menu.title).toBe('输入框')
    expect(menu.detail).toBe('mail.example.com/inbox')

    const json = serialized(menu)
    expect(json).not.toContain('my-secret-password')
    expect(json).not.toContain('hunter2')
    expect(json).not.toContain('alice:')
    expect(json).not.toContain('sid=abc')
  })

  it('密码标记缺少 isEditable 时也不出选区组、不展示选区内容', () => {
    const menu = buildBrowserMenu(
      context({ isPassword: true, isEditable: false, selectionText: 'leaked-secret' })
    )

    expect(allIds(menu)).not.toContain('copy')
    expect(allIds(menu)).not.toContain('search-selection')
    expect(menu.title).toBe('输入框')
    expect(serialized(menu)).not.toContain('leaked-secret')
  })
})

describe('浏览器右键菜单模型：普通选中文本', () => {
  it('选中文本时复制可用，可搜索时追加固定标签的搜索项', () => {
    const menu = buildBrowserMenu(context({ selectionText: '  hello\n  world  ', canSearch: true }))

    expect(groupIds(menu)).toEqual([
      ['copy', 'search-selection'],
      ['copy-page-url', 'save-page'],
      ['inspect']
    ])
    expect(menu.title).toBe('文本')
    expect(menu.detail).toBe('hello world')

    const search = itemOf(menu, 'search-selection')
    expect(search?.label).toBe('搜索所选文字')
    expect(search?.label).not.toContain('hello')
    expect(search?.enabled).toBe(true)
  })

  it('canSearch 为假时只保留复制', () => {
    const menu = buildBrowserMenu(context({ selectionText: 'hello', canSearch: false }))

    expect(groupIds(menu)[0]).toEqual(['copy'])
  })

  it('纯空白选区不算选区，标题回到页面', () => {
    const menu = buildBrowserMenu(context({ selectionText: ' \n\t ' }))

    expect(groupIds(menu)).toEqual([
      ['copy-page-url', 'save-page'],
      ['inspect']
    ])
    expect(menu.title).toBe('页面')
    expect(menu.detail).toBe('example.com/docs/page')
  })

  it('超长选区截断到 60 字符并补省略号，不切断代理对', () => {
    const long = 'a'.repeat(200)
    const menu = buildBrowserMenu(context({ selectionText: long }))
    expect(Array.from(menu.detail)).toHaveLength(60)
    expect(menu.detail.endsWith('…')).toBe(true)

    const emoji = buildBrowserMenu(context({ selectionText: '😀'.repeat(100) }))
    const points = Array.from(emoji.detail)
    expect(points).toHaveLength(60)
    expect(points.at(-1)).toBe('…')
    expect(emoji.detail).toBe('😀'.repeat(59) + '…')
  })
})

describe('浏览器右键菜单模型：页面协议与展示字段', () => {
  it('非 http/https 页面仍保留页面组但置灰、无展示地址', () => {
    for (const pageUrl of ['about:blank', 'file:///C:/a.html', 'data:text/html,hi', '']) {
      const menu = buildBrowserMenu(context({ pageUrl }))

      expect(groupIds(menu)).toEqual([
        ['copy-page-url', 'save-page'],
        ['inspect']
      ])
      expect(itemOf(menu, 'copy-page-url')?.enabled).toBe(false)
      expect(itemOf(menu, 'save-page')?.enabled).toBe(false)
      expect(menu.detail).toBe('')
      expect(menu.title).toBe('页面')
    }
  })

  it('页面地址含用户名密码时展示字段只保留 host+path', () => {
    const menu = buildBrowserMenu(
      context({ pageUrl: 'https://bob:pa55word@internal.example.com:8443/console?token=abc' })
    )

    expect(menu.detail).toBe('internal.example.com:8443/console')
    const json = serialized(menu)
    expect(json).not.toContain('bob:')
    expect(json).not.toContain('pa55word')
    expect(json).not.toContain('token=abc')
  })

  it('无地址场景的工具栏与检查元素不受影响', () => {
    const menu = buildBrowserMenu(context({ pageUrl: '', canGoBack: false, canGoForward: false }))

    expect(menu.toolbar.map(item => item.enabled)).toEqual([false, false, true])
    expect(itemOf(menu, 'inspect')?.enabled).toBe(true)
  })
})

describe('浏览器右键菜单模型：i18n 标签齐全', () => {
  function zhLabels(): Record<string, string> {
    const link = buildBrowserMenu(
      context({
        linkUrl: 'https://example.com/a',
        linkText: '文字',
        srcUrl: 'https://cdn.example.com/a.png',
        mediaType: 'image',
        hasImageContents: true,
        selectionText: '选中'
      })
    )
    const edit = buildBrowserMenu(context({ isEditable: true }))
    const labels: Record<string, string> = {}
    for (const item of [...link.toolbar, ...link.groups.flat(), ...edit.toolbar, ...edit.groups.flat()]) {
      labels[item.id] = item.label
    }
    return labels
  }

  function enLabels(): Record<string, string> {
    const link = buildBrowserMenu(
      context({
        locale: 'en',
        linkUrl: 'https://example.com/a',
        linkText: 'text',
        srcUrl: 'https://cdn.example.com/a.png',
        mediaType: 'image',
        hasImageContents: true,
        selectionText: 'selected'
      })
    )
    const edit = buildBrowserMenu(context({ locale: 'en', isEditable: true }))
    const labels: Record<string, string> = {}
    for (const item of [...link.toolbar, ...link.groups.flat(), ...edit.toolbar, ...edit.groups.flat()]) {
      labels[item.id] = item.label
    }
    return labels
  }

  it('中文标签覆盖全部 21 个动作且与约定文案一致', () => {
    expect(zhLabels()).toEqual(ZH_LABELS)
  })

  it('英文标签覆盖全部 21 个动作且与约定文案一致', () => {
    expect(enLabels()).toEqual(EN_LABELS)
  })

  it('英文语境下标题与编辑项同样本地化', () => {
    const menu = buildBrowserMenu(
      context(
        {
          locale: 'en',
          isEditable: true,
          pageUrl: 'https://example.com/form'
        },
        { canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canUndo: true, canRedo: true }
      )
    )

    expect(menu.title).toBe('Input')
    expect(menu.detail).toBe('example.com/form')
    expect(menu.groups[0].map(item => item.label)).toEqual(['Undo', 'Redo'])
    expect(menu.groups[1].map(item => item.label)).toEqual(['Cut', 'Copy', 'Paste', 'Select all'])
    expect(menu.groups[2].map(item => item.label)).toEqual(['Copy page address', 'Save page as'])
    expect(menu.groups[3].map(item => item.label)).toEqual(['Inspect element'])
  })

  it('英文选中文本语境标题为 Text 并使用英文搜索项', () => {
    const menu = buildBrowserMenu(context({ locale: 'en', selectionText: 'needle' }))

    expect(menu.title).toBe('Text')
    expect(menu.groups[0].map(item => item.label)).toEqual(['Copy', 'Search for selected text'])
  })
})
