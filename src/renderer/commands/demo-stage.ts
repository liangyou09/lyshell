import { COMMANDS } from './command-registry'
import { dispatchNavigate } from './navigate'
import { usePaneStore } from '../stores/pane-store'
import { useSessionStore } from '../stores/session-store'
import { openBuiltinHelpDoc } from '../components/DocPanel/readDoc'
import { isInventoryDocPath, openInventoryDoc } from './inventory'
import { ConnectionType } from '@shared/types'

declare global { interface Window { lyshellDemoScene(index: number): Promise<number> } }

// 供主进程固定演示场景使用；沿用真实命令和页面，绝不启动 AI 或插件任务。
window.lyshellDemoScene = async (index: number): Promise<number> => {
  if (!Number.isInteger(index) || index < 0 || index > 6) throw new Error('场景无效')
  const pane = usePaneStore.getState()
  let docId: string | undefined
  let localId: string | undefined
  const wait = async (ready: () => boolean): Promise<void> => {
    const deadline = Date.now() + 10000
    while (!ready()) {
      if (Date.now() > deadline) throw new Error('演示页面未就绪')
      await new Promise<void>(resolve => setTimeout(resolve, 50))
    }
  }
  pane.closeMcpAudit()
  if (index === 0 || index === 1) {
    dispatchNavigate('sessions')
    docId = openBuiltinHelpDoc(undefined, 'zh')
  } else if (index === 2) {
    dispatchNavigate('sessions')
    const before = new Set(useSessionStore.getState().sessions.map(session => session.id))
    const existing = useSessionStore.getState().sessions.find(session => session.config.type === ConnectionType.LOCAL && session.status === 'connected')
    if (existing) localId = existing.id
    else {
      COMMANDS.find(command => command.name === 'local')!.run()
      await wait(() => useSessionStore.getState().sessions.some(session => !before.has(session.id) && session.config.type === ConnectionType.LOCAL && session.status === 'connected'))
      localId = useSessionStore.getState().sessions.find(session => !before.has(session.id) && session.config.type === ConnectionType.LOCAL && session.status === 'connected')!.id
    }
    const currentPane = usePaneStore.getState()
    const paneId = currentPane.layout.activePaneId
    const target = currentPane.getPaneById(paneId)
    if (target?.type !== 'leaf') throw new Error('演示分屏不存在')
    if (!target.sessions.includes(localId)) currentPane.addSessionToPane(paneId, localId)
    currentPane.toggleLiveSessionTabs([localId], false)
    currentPane.deactivateOverlaysInPane(paneId)
    currentPane.setActiveSessionInPane(paneId, localId)
  } else if (index === 3) {
    dispatchNavigate('sessions')
    docId = openBuiltinHelpDoc(undefined, 'zh')
  } else if (index === 4) {
    dispatchNavigate('agents')
    docId = openInventoryDoc(undefined, 'agents')
  }
  else if (index === 5) {
    dispatchNavigate('settings')
    pane.openMcpAuditInPane(pane.layout.activePaneId)
  } else {
    dispatchNavigate('plugins')
    docId = openInventoryDoc(undefined, 'plugins')
  }
  if (docId) await wait(() => {
    const payload = usePaneStore.getState().getOverlayPayload(docId!)
    return !!payload && payload.kind === 'doc' && (
      isInventoryDocPath(payload.path) ? payload.size > 0 : payload.content.length > 500
    )
  })
  // 等待 React 布局及文档异步加载，不在页面刚切换时开始讲话。
  await new Promise<void>(resolve => setTimeout(resolve, 1200))
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  document.body.dataset.demoScene = String(index)
  return index
}
