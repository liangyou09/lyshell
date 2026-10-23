import { BrowserWindow, clipboard, dialog, session } from 'electron'
import type { ContextMenuParams, Event, WebContents } from 'electron'
import { IPC_CHANNELS, WEBBAR_PARTITION } from '@shared/constants'
import { buildBrowserMenu, type BrowserMenuAction } from '@shared/browser-context-menu'
import type { BrowserMenuPalette } from '@shared/browser-menu-style'
import { preferencesRepository } from '../storage/repository'
import { getRendererThemeMode } from '../ui-theme'
import { getBrowserSettings } from './service'
import { showBrowserContextMenu } from './context-menu-window'

const installed = new WeakSet<WebContents>()
const isHttp = (raw: string): boolean => { try { return /^https?:$/.test(new URL(raw).protocol) } catch { return false } }

/** 固定脚本只读取可信宿主的界面语言/色值，不进入网站 guest。 */
async function hostAppearance(host: WebContents): Promise<{ locale?: string; palette?: BrowserMenuPalette }> {
  try {
    return await host.executeJavaScript(`(() => {
      const style = getComputedStyle(document.documentElement);
      const color = key => style.getPropertyValue(key).trim();
      return {locale: document.documentElement.lang, palette: {
        surface:color('--bg-rack'),hover:color('--bg-slot'),text:color('--text-rack'),
        muted:color('--text-rack-data'),rule:color('--rule'),accent:color('--amber')
      }};
    })()`)
  } catch { return {} }
}

/** 菜单模型与动作留在 main；浮层只能提交当前菜单已启用的动作 ID。 */
export function setupBrowserContextMenu(guest: WebContents, inspect?: (x: number, y: number) => void): void {
  if (guest.isDestroyed() || guest.getType() !== 'webview' || guest.session !== session.fromPartition(WEBBAR_PARTITION) || installed.has(guest)) return
  installed.add(guest)
  let generation = 0
  let sequence = 0
  let active: (() => void) | undefined
  const close = (): void => { active?.(); active = undefined }
  const onContextMenu = (event: Event, params: ContextMenuParams): void => {
    event.preventDefault()
    close()
    const owner = guest.hostWebContents
    const parent = owner && BrowserWindow.fromWebContents(owner)
    if (!owner || owner.isDestroyed() || !parent || parent.isDestroyed()) return
    const openedAt = generation
    const request = ++sequence
    const current = (): boolean => openedAt === generation && request === sequence && !guest.isDestroyed() &&
      !owner.isDestroyed() && !parent.isDestroyed() && guest.hostWebContents === owner
    const pageUrl = guest.getURL()
    void hostAppearance(owner).then(appearance => {
      if (!current()) return
      const locale = String(appearance?.locale || preferencesRepository.get('locale')).startsWith('zh') ? 'zh' : 'en'
      const engine = getBrowserSettings().searchEngine
      const data = buildBrowserMenu({
        locale, theme: getRendererThemeMode(), pageUrl,
        canGoBack: guest.navigationHistory.canGoBack(), canGoForward: guest.navigationHistory.canGoForward(),
        linkUrl: params.linkURL, linkText: params.linkText, srcUrl: params.srcURL,
        mediaType: params.mediaType, hasImageContents: params.hasImageContents,
        isEditable: params.isEditable, isPassword: params.formControlType === 'input-password',
        selectionText: params.selectionText, editFlags: params.editFlags, canSearch: engine !== 'none'
      })
      const open = (url: string): void => {
        if (isHttp(url)) owner.send(IPC_CHANNELS.WEB_TAB_POPUP, { url, sourceWebContentsId: guest.id, sourceUrl: pageUrl, background: true })
      }
      const savePage = async (): Promise<void> => {
        // eslint-disable-next-line no-control-regex -- 网页标题不能成为含控制字符的文件名。
        const name = guest.getTitle().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || 'page'
        const result = await dialog.showSaveDialog(parent, { title: locale === 'zh' ? '网页另存为' : 'Save page as', defaultPath: `${name}.html`, filters: [{ name: 'HTML', extensions: ['html'] }] })
        if (!result.canceled && result.filePath && current()) await guest.savePage(result.filePath, 'HTMLComplete')
      }
      const actions = new Map<BrowserMenuAction, () => void>()
      const raw: Record<BrowserMenuAction, () => void | Promise<void>> = {
        back: () => { if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack() },
        forward: () => { if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward() },
        reload: () => guest.reload(),
        'open-link': () => open(params.linkURL), 'copy-link': () => clipboard.writeText(params.linkURL),
        'copy-link-text': () => clipboard.writeText(params.linkText),
        'save-link': () => { if (isHttp(params.linkURL)) guest.downloadURL(params.linkURL) },
        'open-image': () => open(params.srcURL), 'copy-image': () => guest.copyImageAt(params.x, params.y),
        'copy-image-url': () => clipboard.writeText(params.srcURL), 'save-image': () => guest.downloadURL(params.srcURL),
        undo: () => guest.undo(), redo: () => guest.redo(), cut: () => guest.cut(), copy: () => guest.copy(),
        paste: () => guest.paste(), 'select-all': () => guest.selectAll(),
        'search-selection': () => {
          if (engine === 'none') return
          const bases = { bing: 'https://www.bing.com/search?q=', google: 'https://www.google.com/search?q=', baidu: 'https://www.baidu.com/s?wd=', duckduckgo: 'https://duckduckgo.com/?q=' }
          open(bases[engine] + encodeURIComponent(params.selectionText.trim()))
        },
        'copy-page-url': () => clipboard.writeText(pageUrl), 'save-page': savePage,
        inspect: () => { if (inspect) inspect(params.x, params.y); else guest.inspectElement(params.x, params.y) }
      }
      for (const item of [...data.toolbar, ...data.groups.flat()]) {
        if (!item.enabled) continue
        actions.set(item.id, () => {
          if (!current()) return
          try {
            guest.focus()
            void Promise.resolve(raw[item.id]()).catch(() => {
              if (current()) void dialog.showMessageBox(parent, { type: 'error', message: locale === 'zh' ? '操作失败，请重试。' : 'The operation failed. Please try again.' })
            })
          } catch { /* 来源销毁时不再展示错误。 */ }
        })
      }
      active = showBrowserContextMenu(parent, { ...data, palette: appearance?.palette }, actions, current)
    }).catch(() => undefined)
  }
  const navigated = (_event: Event, _url: string, inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame && !inPlace) { generation++; close() }
  }
  const crashed = (): void => { generation++; close() }
  const host = guest.hostWebContents
  const dispose = (): void => {
    generation++; close()
    guest.removeListener('context-menu', onContextMenu)
    guest.removeListener('did-start-navigation', navigated)
    guest.removeListener('render-process-gone', crashed)
    guest.removeListener('destroyed', dispose)
    host?.removeListener('destroyed', dispose)
    installed.delete(guest)
  }
  guest.on('context-menu', onContextMenu)
  guest.on('did-start-navigation', navigated)
  guest.on('render-process-gone', crashed)
  guest.once('destroyed', dispose)
  host?.once('destroyed', dispose)
}
