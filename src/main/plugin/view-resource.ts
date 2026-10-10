import { open } from 'fs/promises'
import { MAX_RESOURCE_BYTES, ViewProtocolError } from './view-protocol-core'

/**
 * 读取已验证路径的页面资源：先检查已打开文件，再以有限块读取。
 * 即使 stat 后文件继续增长，也最多读取限额 + 1 字节，避免无界分配。
 */
export async function readPluginViewResource(absPath: string): Promise<Buffer<ArrayBuffer>> {
  const file = await open(absPath, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new ViewProtocolError(404, 'resource not found')
    if (stat.size > MAX_RESOURCE_BYTES) throw new ViewProtocolError(404, 'resource too large')

    const chunks: Buffer[] = []
    let total = 0
    while (total <= MAX_RESOURCE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_RESOURCE_BYTES + 1 - total))
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > MAX_RESOURCE_BYTES) throw new ViewProtocolError(404, 'resource too large')
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, total)
  } finally {
    await file.close()
  }
}
