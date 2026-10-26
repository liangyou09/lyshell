import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { ActivityNavigationRequest, ActivityNavigationResult, ActivityBackendIdentity } from '@shared/activity-navigation'
import { BRIDGE_KEY_HEADER } from './bridge'
import { dshWebManager } from './web'
import { acquireWorkbenchDetail } from './exclusive-runtime'
import { readWorkbenchActivity } from './activity'
import { readHarnessWebActivity } from './web-activity'

const sameIdentity = (a: ActivityBackendIdentity | null, b: ActivityBackendIdentity) => a?.instanceId === b.instanceId && a?.instanceEpoch === b.instanceEpoch
async function bridge(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const endpoint = dshWebManager.bridgeControlEndpoint
  if (!endpoint) throw new Error('Harness backend unavailable')
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const request = http.request({ hostname: '127.0.0.1', port: endpoint.port, method: 'POST', path: '/', timeout: 5000,
      headers: { [BRIDGE_KEY_HEADER]: endpoint.key, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1024 * 1024) { request.destroy(); reject(new Error('Harness navigation response too large')); return }
        chunks.push(chunk)
      })
      response.on('error', () => reject(new Error('Harness navigation connection interrupted')))
      response.on('aborted', () => reject(new Error('Harness navigation connection interrupted')))
      response.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          if (response.statusCode !== 200 || result.ok !== true) throw new Error('Harness navigation unavailable or superseded')
          resolve(result)
        } catch { reject(new Error('Harness navigation unavailable or superseded')) }
      })
    })
    request.on('error', () => reject(new Error('Harness navigation connection interrupted')))
    request.on('timeout', () => { request.destroy(); reject(new Error('Harness navigation timed out; no task was resubmitted')) })
    request.end(body)
  })
}

/** 显式用户导航仅更改查看位置；不获取任务控制权、不提交模型任务。 */
export async function navigateWorkbenchActivity(request: ActivityNavigationRequest): Promise<ActivityNavigationResult> {
  try {
    if (!sameIdentity(dshWebManager.instanceIdentity, request.identity)) throw new Error('Harness backend changed; refresh sessions')
    if (request.kind === 'open') {
      const [snapshot, web] = await Promise.all([readWorkbenchActivity(), readHarnessWebActivity()])
      const session = snapshot.sessions.find(row => row.sessionId === request.sessionId && !row.stale)
      const webSession = web.connection === 'connected' && sameIdentity(web.identity, request.identity) ? web.sessions.find(row => row.sessionId === request.sessionId) : undefined
      if ((!session || snapshot.connection !== 'connected' || !sameIdentity(snapshot.identity, request.identity)) && !webSession) throw new Error('Session state is stale; refresh sessions')
      const detail = await acquireWorkbenchDetail()
      if (!detail.ok || !sameIdentity(detail, request.identity)) throw new Error('Harness workbench unavailable or backend changed')
      const requestId = randomUUID()
      await bridge({ cmd: 'native-viewer-nav', identity: request.identity, sessionId: request.sessionId, requestId })
      return { success: true, requestId, navigation: 'pending', url: detail.url, cwd: webSession?.workspace || session?.workspace || undefined }
    }
    const result = await bridge({ cmd: 'snapshot' })
    if (!sameIdentity(result.identity as ActivityBackendIdentity | null, request.identity)) throw new Error('Harness backend changed')
    const viewer = result.viewer as { request?: { requestId: string }; lastAck?: { requestId: string; sessionId: string; currentSessionId: string; status: string }; currentSessionId?: string }
    if (viewer.lastAck?.requestId === request.requestId && viewer.lastAck.sessionId === request.sessionId) {
      return { success: true, requestId: request.requestId, navigation: viewer.lastAck.status === 'navigated' && viewer.lastAck.currentSessionId === request.sessionId && viewer.currentSessionId === request.sessionId ? 'navigated' : 'failed' }
    }
    return { success: true, requestId: request.requestId, navigation: viewer.request?.requestId === request.requestId ? 'pending' : 'failed' }
  } catch (error) { return { success: false, error: (error as Error).message } }
}
