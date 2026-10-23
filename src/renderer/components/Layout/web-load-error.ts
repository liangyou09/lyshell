export interface WebLoadFailure {
  url: string
  code?: number
  description: string
}

/** Electron 参数在事件自身；同时兼容测试与旧封装的 detail 形状。 */
export function webLoadFailureFromEvent(event: Event, fallbackUrl: string): WebLoadFailure | null {
  type FailureEvent = { errorCode?: number; errorDescription?: string; isMainFrame?: boolean; validatedURL?: string }
  const evt = event as Event & FailureEvent & { detail?: FailureEvent }
  const value: FailureEvent = {
    errorCode: evt.errorCode ?? evt.detail?.errorCode,
    errorDescription: evt.errorDescription ?? evt.detail?.errorDescription,
    isMainFrame: evt.isMainFrame ?? evt.detail?.isMainFrame,
    validatedURL: evt.validatedURL ?? evt.detail?.validatedURL
  }
  if (value.isMainFrame === false || value.errorCode === -3) return null
  return {
    url: value.validatedURL || fallbackUrl,
    code: value.errorCode,
    description: value.errorDescription || (value.errorCode !== undefined ? `ERR_${value.errorCode}` : 'ERROR')
  }
}

export function webLoadFailureReason({ code, description }: WebLoadFailure): string {
  if (description === 'ERR_RENDER_PROCESS_GONE') return 'render'
  if (code === -106 || description === 'ERR_INTERNET_DISCONNECTED') return 'offline'
  if (code === -105 || code === -137 || description === 'ERR_NAME_NOT_RESOLVED') return 'dns'
  if (code === -102 || description === 'ERR_CONNECTION_REFUSED') return 'refused'
  if (code === -7 || code === -118 || description.includes('TIMED_OUT')) return 'timeout'
  if ((code !== undefined && code <= -200 && code > -300) || description.startsWith('ERR_CERT_')) return 'certificate'
  return 'generic'
}
