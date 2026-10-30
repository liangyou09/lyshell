import type { RetryDisposition } from '@shared/operation'

/** HTTP 与 stdio MCP 共用失败事实，不通过 message 反推重试策略。 */
export class LyShellApiError extends Error {
  readonly code?: string
  readonly retryDisposition?: RetryDisposition
  readonly requestId?: string
  readonly reason?: string

  constructor(body: { error?: unknown; code?: unknown; retryDisposition?: unknown; requestId?: unknown; reason?: unknown }) {
    super(typeof body.error === 'string' ? body.error.slice(0, 1024) : 'LyShell request failed')
    this.name = 'LyShellApiError'
    this.code = boundedIdentifier(body.code)
    this.requestId = boundedIdentifier(body.requestId)
    this.reason = boundedIdentifier(body.reason)
    if (body.retryDisposition === 'safe' || body.retryDisposition === 'never' || body.retryDisposition === 'reconcile-first') {
      this.retryDisposition = body.retryDisposition
    }
  }

  details(): Record<string, string> {
    return Object.fromEntries(Object.entries({ code: this.code, retryDisposition: this.retryDisposition,
      requestId: this.requestId, reason: this.reason }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  }
}

function boundedIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 128 && /^[\w:/.-]+$/.test(value) ? value : undefined
}
