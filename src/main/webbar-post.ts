import type { LoadURLOptions, PostBody, Referrer } from 'electron'

export interface PendingWebbarPost {
  url: string
  body: PostBody
  referrer: Referrer
}

/**
 * 未认领的正文按真实时钟主动释放；认领即销毁（take 一次性）。
 *
 * 曾试过「认领者销毁后放行重放」来兜 POST 加载中拖动重挂 —— 已否决回退：原请求
 * 可能已到达服务端、只是响应未及回传，重放会让付款/创建类动作二次执行。且网页
 * 页签现已挂常驻层（WebTabLayer，渲染层侧），跨分屏拖动不再销毁 webview，正常
 * 流程不存在需要重放的场景；此处保持最朴素的取走即毁。
 */
export class PendingWebbarPostStore {
  private readonly entries = new Map<string, {
    request: PendingWebbarPost
    expiresAt: number
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(private readonly maxPending: number, private readonly ttlMs: number) {}

  enqueue(token: string, request: PendingWebbarPost): boolean {
    const now = Date.now()
    // 主进程定时器被长任务推迟时仍按截止时间裁决容量。
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key)
    }
    if (this.entries.size >= this.maxPending) return false
    const timer = setTimeout(() => this.remove(token), this.ttlMs)
    timer.unref()
    this.entries.set(token, { request, expiresAt: now + this.ttlMs, timer })
    return true
  }

  take(token: string): PendingWebbarPost | null {
    const entry = this.entries.get(token)
    if (!entry) return null
    this.remove(token)
    return entry.expiresAt > Date.now() ? entry.request : null
  }

  private remove(token: string): void {
    const entry = this.entries.get(token)
    if (!entry) return
    clearTimeout(entry.timer)
    this.entries.delete(token)
  }
}

/** 文件段按路径交给网络栈，原始字节段留在主进程队列时须限制占用。 */
export function webbarPostRawBytesWithinLimit(body: PostBody, maxBytes: number): boolean {
  let total = 0
  for (const part of body.data) {
    if (part.type === 'rawData') total += part.bytes.byteLength
    if (total > maxBytes) return false
  }
  return true
}

/** 把开窗表单的原始请求交给 loadURL，保留文件段、编码方式和 multipart 边界。 */
export function webbarPostLoadOptions(body: PostBody, referrer: Referrer): LoadURLOptions {
  const contentType = body.boundary
    ? `${body.contentType}; boundary=${body.boundary}`
    : body.contentType
  return {
    postData: body.data,
    extraHeaders: `Content-Type: ${contentType}\n`,
    httpReferrer: referrer
  }
}
