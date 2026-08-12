import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// Manager 依赖真实 Worker bundle / Electron BrowserWindow，难以在 Node 单测直接运行。
// 这里锁定串行链取消的配线：单任务取消能移除 queued task，会话断开能按 sessionId
// 批量取消 queued task，应用退出能清空全部队列。

const UPLOAD = fs.readFileSync(path.join(process.cwd(), 'src/main/file/upload-worker-manager.ts'), 'utf-8')
const DOWNLOAD = fs.readFileSync(path.join(process.cwd(), 'src/main/file/download-worker-manager.ts'), 'utf-8')
const SESSION_MANAGER = fs.readFileSync(path.join(process.cwd(), 'src/main/terminal/session-manager.ts'), 'utf-8')

describe('worker manager 串行队列取消配线', () => {
  for (const [name, src, chain] of [
    ['upload', UPLOAD, 'uploadChain'],
    ['download', DOWNLOAD, 'downloadChain']
  ] as const) {
    it(`${name}: 入队任务附带 taskId + sessionId`, () => {
      expect(src).toContain('id: task.taskId')
      expect(src).toContain('group: task.sessionId')
    })

    it(`${name}: 单任务取消覆盖尚未启动的 queued task`, () => {
      expect(src).toContain(`${chain}.cancelId(taskId)`)
    })

    it(`${name}: 会话断开按 sessionId 取消 queued task`, () => {
      expect(src).toContain(`${chain}.cancelGroup(sessionId)`)
      expect(src).toContain('sendProgressToRenderer({ taskId, cancelled: true })')
    })

    it(`${name}: 应用退出清空 queued task`, () => {
      expect(src).toContain(`${chain}.cancelAll()`)
    })
  }

  it('删除会话复用完整断开清理后移除运行时 Map、输出缓冲并发送事件', () => {
    const deleteBody = SESSION_MANAGER.slice(
      SESSION_MANAGER.indexOf('async deleteSession('),
      SESSION_MANAGER.indexOf('/**\n   * 连接会话')
    )
    expect(deleteBody).toContain('await this.disconnectSession(id)')
    expect(deleteBody).toContain('outputBuffer?.clear()')
    expect(deleteBody).toContain('this.sessions.delete(id)')
    expect(deleteBody).toContain("this.emit('session:deleted', id)")
  })

  it('同 ID 会话不可覆盖，连接调用按实例复用 Promise', () => {
    const createBody = SESSION_MANAGER.slice(
      SESSION_MANAGER.indexOf('async createSession('),
      SESSION_MANAGER.indexOf('/**\n   * 获取会话')
    )
    const connectBody = SESSION_MANAGER.slice(
      SESSION_MANAGER.indexOf('async connectSession('),
      SESSION_MANAGER.indexOf('private async connectSessionAttempt(')
    )
    expect(createBody).toContain('if (this.sessions.has(id))')
    expect(createBody).toContain('throw new Error(`Session already exists: ${id}`)')
    expect(connectBody).toContain('if (!session.disconnectCleanup) return session.connectPromise')
    expect(connectBody).toContain('await session.connectPromise')
  })

  it('connector generation 在 LOCAL 动态 import 前切换，成功与错误更新受 attempt 身份保护', () => {
    const attemptBody = SESSION_MANAGER.slice(
      SESSION_MANAGER.indexOf('private async connectSessionAttempt('),
      SESSION_MANAGER.indexOf('/**\n   * 自然 close')
    )
    const generationAt = attemptBody.indexOf('session.connectorGeneration = generation')
    const importAt = attemptBody.indexOf("await import('@main/mcp/auth')")
    expect(generationAt).toBeGreaterThan(-1)
    expect(importAt).toBeGreaterThan(generationAt)
    expect(attemptBody).toContain('this.sessions.get(id) === session')
    expect(attemptBody).toContain('if (isCurrentAttempt()) {')
    expect(attemptBody).toContain('if (!isCurrentAttempt()) throw new Error(`Connection superseded: ${id}`)')
  })

  it('自然 close 与显式断开共用幂等清理，并在首个 await 前取消传输', () => {
    const cleanupBody = SESSION_MANAGER.slice(
      SESSION_MANAGER.indexOf('private cleanupDisconnectedSession('),
      SESSION_MANAGER.indexOf('/**\n   * 断开会话')
    )
    const closeHandler = SESSION_MANAGER.slice(
      SESSION_MANAGER.indexOf("connector.on('close'"),
      SESSION_MANAGER.indexOf("connector.on('error'")
    )
    expect(closeHandler).toContain('if (!isCurrentAttempt()) return')
    expect(closeHandler).toContain('this.cleanupDisconnectedSession(id, generation, connector)')
    expect(SESSION_MANAGER).toContain('if (session.disconnectCleanup) await session.disconnectCleanup')
    expect(cleanupBody).toContain('if (session.disconnectCleanup) return session.disconnectCleanup')
    const cancelDownloadAt = cleanupBody.indexOf('cancelDownloadsBySession(id)')
    const cancelUploadAt = cleanupBody.indexOf('cancelUploadsBySession(id)')
    const firstAwaitAt = cleanupBody.search(/^\s+await\s/m)
    expect(cancelDownloadAt).toBeGreaterThan(-1)
    expect(cancelUploadAt).toBeGreaterThan(cancelDownloadAt)
    expect(firstAwaitAt).toBeGreaterThan(cancelUploadAt)
  })
})
