import { dispatchNavigate } from './navigate'
import { usePaneStore } from '../stores/pane-store'
import { useSessionStore } from '../stores/session-store'
import { useTerminalStore } from '../stores/terminal-store'
import { useThemeStore } from '../stores/theme-store'
import { usePluginStore } from '../stores/plugin-store'
import { makePluginViewKey } from '@shared/plugin-types'
import type { WebviewTag } from 'electron'
import releaseNotes from '../../../CHANGELOG.md?raw'

declare global { interface Window { lyshellDemoOrigin: string } }
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function wait(ready: () => boolean): Promise<void> {
  const end = Date.now() + 10000
  while (!ready()) { if (Date.now() > end) throw new Error('专题画面未就绪'); await delay(60) }
}
function notes(version: string): void {
  const panes = usePaneStore.getState().getAllLeafPanes()
  for (const pane of panes.slice(1).reverse()) usePaneStore.getState().closePane(pane.id)
  const marker = `## [${version}]`
  const from = releaseNotes.indexOf(marker)
  if (from < 0) throw new Error('发行记录不存在')
  const end = releaseNotes.indexOf('\n## [', from + marker.length)
  const content = releaseNotes.slice(from, end < 0 ? undefined : end)
  usePaneStore.getState().openDocTab(undefined, { source: 'builtin', docKind: 'markdown', path: `lyshell://demo-release-${version}.md`, title: `LyShell ${version} · 更新记录`, content, size: new TextEncoder().encode(content).byteLength, mtime: 0 })
}
async function localTerminal(): Promise<string> {
  await window.lyshellDemoScene(2)
  const session = useSessionStore.getState().sessions.find(item => item.config.type === 'local' && item.status === 'connected')
  if (!session) throw new Error('本地演示终端未连接')
  await wait(() => !!useTerminalStore.getState().getTerminal(session.id))
  return session.id
}
function setInput(input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
async function focusNote(term: string): Promise<void> {
  await wait(() => [...document.querySelectorAll('strong')].some(item => item.textContent?.includes(term) && item.getBoundingClientRect().width > 0))
  const text = [...document.querySelectorAll('strong')].find(item => item.textContent?.includes(term) && item.getBoundingClientRect().width > 0)!
  text.scrollIntoView({ block: 'center' })
}
function pluginView(entry: string): WebviewTag | undefined {
  const urlPath = entry.replace('/views/', '/')
  return [...document.querySelectorAll<WebviewTag>('webview')].find(view => view.getAttribute('src')?.includes(urlPath))
}
/** Fixed product-update shots. All content is the running application, never screenshots. */
export async function presentUpdateScene(index: number): Promise<number> {
  if (!Number.isInteger(index) || index < 18 || index > 45) throw new Error('专题场景无效')
  if (document.body.dataset.demoScene === String(index)) return index
  usePaneStore.getState().closeMcpAudit()
  if (index === 18) {
    dispatchNavigate('agents'); notes('1.0.9')
  } else if (index === 19) {
    dispatchNavigate('web')
    const opened = usePaneStore.getState().openWebTab(`${window.lyshellDemoOrigin}/web-demo/index.html`)
    if (!opened.ok) throw new Error(opened.error)
    await wait(() => [...document.querySelectorAll<WebviewTag>('webview')].some(view => {
      try { return view.getURL().endsWith('/web-demo/index.html') && !view.isLoading() } catch { return false }
    }))
  } else if (index === 20) {
    // The mini browser reads this preference on first mount; its real address bar submits it.
    dispatchNavigate('web')
    await delay(250)
    const inputs = [...document.querySelectorAll<HTMLInputElement>('input')]
    const address = inputs.find(input => /Mini|小窗/i.test(input.placeholder))
    if (!address) throw new Error('网页地址栏不存在')
    setInput(address, `${window.lyshellDemoOrigin}/web-demo/guide.html`)
    address.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    await wait(() => [...document.querySelectorAll<WebviewTag>('webview')].some(view => {
      try { return view.getURL().endsWith('/web-demo/guide.html') && !view.isLoading() } catch { return false }
    }))
  } else if (index === 21) {
    dispatchNavigate('plugins'); notes('2.0.0')
  } else if (index === 22) {
    dispatchNavigate('settings')
    await wait(() => !!document.querySelector('.settings-panel'))
  } else if (index === 23) {
    dispatchNavigate('sessions')
    const pane = usePaneStore.getState()
    // A null selection still leaves terminal instances mounted and does not render
    // the welcome component. Create a genuinely empty leaf in this demo profile.
    const previous = pane.getAllLeafPanes().map(leaf => leaf.id)
    pane.splitPane(pane.layout.activePaneId, 'horizontal')
    for (const id of previous) usePaneStore.getState().closePane(id)
    await wait(() => {
      const welcome = document.querySelector<HTMLElement>('.command-welcome')
      return !!welcome && welcome.getBoundingClientRect().width > 0
        && welcome.querySelectorAll('.command-welcome-action').length === 3
    })
  } else if (index === 24 || index === 25) {
    const id = await localTerminal()
    const instance = useTerminalStore.getState().getTerminal(id)!
    if (index === 24) {
      const command = "powershell.exe -NoLogo -NoProfile -Command \"Clear-Host; Write-Output 'LyShell 2.0.1 - terminal search demo'; Write-Output 'INFO project ready'; Write-Output 'WARN retry once'; Write-Output 'ERROR sample only'; Write-Output 'Search: demo Demo DEMO'; Write-Host 'Color output: yellow cyan white' -ForegroundColor Cyan\"\r"
      await window.electronAPI.terminalWrite(id, command)
      await wait(() => {
        const buffer = instance.terminal.buffer.active
        for (let line = Math.max(0, buffer.length - instance.terminal.rows - 50); line < buffer.length; line++) if (buffer.getLine(line)?.translateToString().trim() === 'Search: demo Demo DEMO') return true
        return false
      })
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true }))
      await wait(() => !!document.querySelector('[data-search-panel] textarea'))
      setInput(document.querySelector<HTMLTextAreaElement>('[data-search-panel] textarea')!, 'demo')
    } else {
      useThemeStore.getState().setTheme('rack-paper')
    }
  } else if (index === 26 || index === 27 || index === 28) {
    dispatchNavigate(index === 27 ? 'plugins' : 'settings'); notes(index === 28 ? '2.0.0' : '2.0.1')
  } else if (index >= 29 && index <= 32) {
    // 2.0.0 had four materials; 2.0.1 converged on jade. Show the historical
    // release document rather than inventing controls that the current build lacks.
    dispatchNavigate('settings'); notes('2.0.0')
  } else if (index === 33) {
    await usePluginStore.getState().load()
    const plugin = usePluginStore.getState().items.find(item => item.id === 'my-view-plugin')
    if (plugin && !plugin.enabled) await usePluginStore.getState().enable(plugin.id)
    await usePluginStore.getState().load()
    const view = usePluginStore.getState().items.flatMap(item => item.views).find(item => item.pluginId === 'my-view-plugin' && item.id === 'status')
    if (!view) throw new Error('声明式演示插件尚未安装')
    notes('2.0.0')
    dispatchNavigate(makePluginViewKey(view.pluginId, view.id))
    await wait(() => !!pluginView('/views/status.html'))
    await pluginView('/views/status.html')!.executeJavaScript("new Promise((resolve,reject)=>{const end=Date.now()+8000;const poll=()=>{const el=document.querySelector('#boot');if(el&&!el.textContent.includes('loading'))resolve(true);else if(Date.now()>end)reject(Error('bootstrap timeout'));else setTimeout(poll,50)};poll()})")
  } else if (index === 34) {
    dispatchNavigate('settings')
    await wait(() => !!document.querySelector('.settings-version'))
    document.querySelector<HTMLButtonElement>('.settings-version')!.click()
    await wait(() => Object.values(usePaneStore.getState().overlayPayloads).some(payload => payload?.kind === 'doc' && payload.path === 'lyshell://changelog.md'))
  } else if (index === 35) {
    dispatchNavigate('web'); await delay(250)
    const mini = pluginView('/web-demo/guide.html')
    if (!mini) throw new Error('小浏览器需要先导航指南')
    const guestId = mini.getWebContentsId()
    await mini.executeJavaScript("document.querySelector('#keep-alive').value='切换页签后仍保留';true")
    dispatchNavigate('agents'); await delay(400); dispatchNavigate('web'); await delay(400)
    if (mini.getWebContentsId() !== guestId || !await mini.executeJavaScript("document.querySelector('#keep-alive').value==='切换页签后仍保留'")) throw new Error('小浏览器保活验证失败')
    document.body.dataset.demoMiniPreserved = 'true'
  } else if (index === 36) {
    await localTerminal(); dispatchNavigate('web')
    const pane = usePaneStore.getState()
    if (pane.layout.root.type === 'leaf') pane.splitPane(pane.layout.activePaneId, 'horizontal')
    const opened = usePaneStore.getState().openWebTab(`${window.lyshellDemoOrigin}/web-demo/guide.html`)
    if (!opened.ok) throw new Error(opened.error)
    await wait(() => usePaneStore.getState().layout.root.type === 'split')
  } else if (index === 37) {
    await localTerminal()
    await presentUpdateScene(33)
    await pluginView('/views/status.html')!.executeJavaScript("document.querySelector('#open-dialog').click();true")
    await wait(() => !!pluginView('/views/picker.html'))
  } else if (index === 38) {
    const picker = pluginView('/views/picker.html')
    if (!picker) throw new Error('插件弹窗不存在')
    // Cancellation is a real dialog result, and needs no access to user sessions.
    // The guest is destroyed by closeDialog; do not wait on its disappearing JS context.
    void picker.executeJavaScript("document.querySelector('#cancel').click();true").catch(() => {})
    await wait(() => !pluginView('/views/picker.html'))
    await delay(100)
    const result = await pluginView('/views/status.html')!.executeJavaScript("document.querySelector('#dialog-result').textContent")
    if (String(result) !== 'null') throw new Error('插件弹窗结果未返回')
  } else if (index === 39) {
    await usePluginStore.getState().load()
    const view = usePluginStore.getState().items.flatMap(item => item.views).find(item => item.pluginId === 'my-view-runtime-plugin' && item.id === 'launcher')
    if (!view) throw new Error('运行时注册视图未就绪')
    dispatchNavigate(makePluginViewKey(view.pluginId, view.id))
    await wait(() => [...document.querySelectorAll<WebviewTag>('webview')].some(view => view.getAttribute('src')?.includes('my-view-runtime-plugin')))
  } else if (index === 40) {
    useThemeStore.getState().setTheme('rack-graphite'); dispatchNavigate('sessions')
  } else if (index >= 41 && index <= 44) {
    dispatchNavigate('settings'); notes('2.0.1')
    await focusNote({41:'SFTP 上传',42:'Windows 本地终端输入',43:'版本与构建日期',44:'终端截图'}[index]!)
  } else if (index === 45) {
    const disabled = await usePluginStore.getState().disable('my-view-plugin')
    if (!disabled) throw new Error('演示插件停用失败')
    dispatchNavigate('plugins'); notes('2.0.0'); await focusNote('插件退出与卸载')
    await wait(() => !pluginView('/views/status.html'))
  }
  await delay(600)
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  document.body.dataset.demoScene = String(index)
  return index
}
