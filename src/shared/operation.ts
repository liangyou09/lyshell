/** 跨入口的业务错误；响应只携带固定说明和关联 ID，不回传底层异常对象。 */
export type OperationErrorCode =
  | 'INVALID_ARGUMENT' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'RESOURCE_NOT_FOUND'
  | 'UNSUPPORTED_CAPABILITY' | 'CONTROL_CONFLICT' | 'STALE_GENERATION'
  | 'OUTCOME_UNKNOWN' | 'RESOURCE_LIMIT' | 'INCOMPATIBLE_VERSION'

export type RetryDisposition = 'safe' | 'reconcile-first' | 'never'

export interface CallContext {
  requestId: string
  principalId: string
  source: 'gui' | 'http' | 'plugin' | 'internal'
  receivedAt: number
}

export class OperationError extends Error {
  constructor(
    readonly code: OperationErrorCode,
    message: string,
    readonly retryDisposition: RetryDisposition = 'never'
  ) {
    super(message)
    this.name = 'OperationError'
  }
}
