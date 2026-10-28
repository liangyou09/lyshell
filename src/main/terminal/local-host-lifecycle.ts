import { readdir } from 'node:fs/promises'
import { hostStorageDir, isHostId } from './local-host-protocol'
import { LocalHostClient } from './local-host-client'

type HostClient = Pick<LocalHostClient, 'retain' | 'terminate' | 'detach'>

/** 只清理本用户档案登记且通过管道鉴权的宿主，不按裸 PID 杀进程。 */
export async function stopRecordedLocalHosts(
  userDataDir: string,
  onError: (id: string | undefined, error: unknown) => void,
  attach: (directory: string, id: string) => Promise<HostClient> = LocalHostClient.attach
): Promise<void> {
  let ids: string[]
  try {
    const files = await readdir(hostStorageDir(userDataDir), { withFileTypes: true })
    ids = files.filter(file => file.isFile() && file.name.endsWith('.json') && isHostId(file.name.slice(0, -5))).map(file => file.name.slice(0, -5))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError(undefined, error)
    return
  }

  // 历史记录较多时限制并发，避免启动/退出时同时打开大量管道。
  let next = 0
  await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++]
      let client: HostClient | undefined
      try {
        client = await attach(userDataDir, id)
        // 即使终止确认失败，也先撤销旧版本跨退出保活；不删除状态未知的描述文件。
        const released = client.retain(false).catch(error => onError(id, error))
        // 两个请求按管道顺序发出；旧宿主迟迟不确认撤销保活时，也要在退出预算内发出终止。
        await Promise.all([released, client.terminate()])
      } catch (error) {
        onError(id, error)
      } finally {
        if (client) await client.detach().catch(error => onError(id, error))
      }
    }
  }))
}
