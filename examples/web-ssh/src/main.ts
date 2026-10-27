import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startWebSshServer, type WebSshServerHandle } from '../server'

interface Api {
  grantedCapabilities: readonly string[]
  registerView(view: {id:string;title:string;entry:string;icon:string}): Promise<void>
  unregisterView(id: string): Promise<void>
}
let handle: WebSshServerHandle | undefined
let activation: Promise<void> | undefined
let epoch = 0
let api: Api | undefined
const runtime = (port: number | null): Promise<void> => writeFile(join(__dirname, 'views/runtime.json'), JSON.stringify({port}), 'utf8')

export function activate(next: Api): Promise<void> {
  if (activation) return activation
  const version = ++epoch
  api = next
  activation = (async () => {
    if (!next.grantedCapabilities.includes('uiControl')) throw new Error('Web SSH 需要 uiControl 权限')
    const service = await startWebSshServer({assetsDir:join(__dirname,'web')})
    if (version !== epoch) { await service.close(); return }
    handle = service
    try {
      await runtime(service.port)
      if (version !== epoch) return
      await next.registerView({id:'launcher',title:'Web SSH',entry:'views/launcher.html',icon:'icon.svg'})
    } catch (error) {
      await service.close()
      handle = undefined
      await runtime(null).catch(() => {})
      throw error
    }
  })()
  return activation
}

export async function deactivate(): Promise<void> {
  epoch++
  await activation?.catch(() => {})
  const service = handle
  handle = undefined
  await service?.close()
  await runtime(null)
  await api?.unregisterView('launcher').catch(() => {})
  activation = undefined
  api = undefined
}
