import type { WebviewTag } from 'electron'

interface WebFrame { image?: string; width: number; height: number }
const frames = new WeakMap<WebviewTag, { at: number; pending: boolean; promise: Promise<WebFrame> }>()

/** 顶部缩影和下方内容区共用同一帧；不对同一 guest 叠加截图请求。 */
export function captureShelfWebFrame(page: WebviewTag): Promise<WebFrame> {
  const previous = frames.get(page)
  if (previous && (previous.pending || Date.now() - previous.at < 400)) return previous.promise
  const record = { at: Date.now(), pending: true, promise: Promise.resolve().then(async () => {
    const capture = await page.capturePage()
    const { width, height } = capture.getSize()
    if (capture.isEmpty() || !width || !height) return { width, height }
    const scale = Math.min(1, 960 / width, 600 / height)
    return { width, height, image: capture.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }).toDataURL() }
  }) }
  frames.set(page, record)
  void record.promise.then(() => { record.pending = false }, () => {
    record.pending = false
    if (frames.get(page) === record) frames.delete(page)
  })
  return record.promise
}
