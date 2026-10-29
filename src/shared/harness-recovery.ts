export const HARNESS_RECOVERED_CHANNEL = 'dsh:web:recovered'
export const HARNESS_RECOVERY_GET_CHANNEL = 'dsh:web:connection'
export interface HarnessRecoveredEvent {
  identity: { instanceId: string; instanceEpoch: number }
  url: string
  cwd: string
}

/** 恢复通知只允许无凭据的回环工作台 origin。 */
export function readHarnessRecoveredEvent(value: unknown): HarnessRecoveredEvent | null {
  if (!value || typeof value !== 'object') return null
  const event = value as Partial<HarnessRecoveredEvent>
  if (!event.identity || typeof event.identity.instanceId !== 'string' || !event.identity.instanceId ||
    event.identity.instanceId.length > 128 || !Number.isSafeInteger(event.identity.instanceEpoch) || event.identity.instanceEpoch <= 0 ||
    typeof event.cwd !== 'string' || event.cwd.length > 2048 || typeof event.url !== 'string') return null
  try {
    const url = new URL(event.url)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
  } catch { return null }
  return { identity: { instanceId: event.identity.instanceId, instanceEpoch: event.identity.instanceEpoch }, url: event.url, cwd: event.cwd }
}
