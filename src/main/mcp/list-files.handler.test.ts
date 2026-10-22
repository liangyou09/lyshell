import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import type { FileInfo } from '@shared/types'
import { listFilesBounded } from './list-files'
import { GLOB_PATTERN_MAX_LENGTH, globPatternTooLongMessage } from './glob'

// 执行真实 handler 和遍历器，仅替换权限、文件连接器和响应 IO。
const source = ts.createSourceFile('http-server.ts', readFileSync(join(process.cwd(), 'src/main/mcp/http-server.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleListFiles')
if (!declaration) throw new Error('handleListFiles not found')
const script = ts.transpileModule(`(${declaration.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function fixture(listDir: (id: string, path: string) => Promise<FileInfo[]>) {
  const sendJson = vi.fn()
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false })
  const handler = runInNewContext(script, {
    AbortController, listFilesBounded, sendJson,
    GLOB_PATTERN_MAX_LENGTH, globPatternTooLongMessage,
    resolveRuntimeSessionId: (id: string) => id,
    authorizeMcpOperation: async () => ({ allowed: true }),
    clampNumber: (value: number | undefined, min: number, max: number, fallback: number) => value === undefined ? fallback : Math.min(max, Math.max(min, value)),
    fileManager: { listDir }
  }) as (data: { sessionId: string; path: string; recursive: boolean; glob?: string }, res: EventEmitter, binding: unknown) => Promise<void>
  return { sendJson, response, call: (recursive = false, glob?: string) => handler({ sessionId: 'fixture', path: '/root', recursive, glob }, response, {}) }
}

it.each([false, true])('真实 handler 将根目录错误返回 HTTP 500，recursive=%s', async recursive => {
  for (const glob of [undefined, '*.txt']) {
    const f = fixture(async () => { throw new Error('Permission denied fixture') })
    await f.call(recursive, glob)
    expect(f.sendJson).toHaveBeenCalledWith(f.response, 500, { success: false, error: 'Permission denied fixture' })
    expect(f.response.listenerCount('close')).toBe(0)
  }
})

it('真实 handler 对 4097 与 100 万字符的 glob 返回 400，且不进入 listDir', async () => {
  for (const length of [GLOB_PATTERN_MAX_LENGTH + 1, 1_000_000]) {
    const listDir = vi.fn(async () => [])
    const f = fixture(listDir)
    await f.call(false, 'a'.repeat(length))
    expect(listDir).not.toHaveBeenCalled()
    expect(f.sendJson).toHaveBeenCalledTimes(1)
    const [res, status, body] = f.sendJson.mock.calls[0]
    expect(res).toBe(f.response)
    expect(status).toBe(400)
    expect(body).toEqual({ success: false, error: globPatternTooLongMessage(length) })
    // 错误只带长度：不回显模式片段，且消息长度有界。
    expect(body.error.length).toBeLessThan(200)
    expect(body.error).not.toContain('a'.repeat(64))
    expect(f.response.listenerCount('close')).toBe(0)
  }
})

it('真实 handler 接受恰好 4096 字符的 glob 并正常返回 200', async () => {
  const listDir = vi.fn(async () => [])
  const f = fixture(listDir)
  await f.call(false, 'a'.repeat(GLOB_PATTERN_MAX_LENGTH))
  expect(listDir).toHaveBeenCalledTimes(1)
  expect(f.sendJson).toHaveBeenCalledWith(f.response, 200, {
    success: true, data: { entries: [], truncated: false, scannedEntries: 0, visitedDirectories: 1 }
  })
  expect(f.response.listenerCount('close')).toBe(0)
})

it('真实空目录仍返回成功且不误报截断', async () => {
  const f = fixture(async () => [])
  await f.call()
  expect(f.sendJson).toHaveBeenCalledWith(f.response, 200, {
    success: true, data: { entries: [], truncated: false, scannedEntries: 0, visitedDirectories: 1 }
  })
})

it('响应关闭取消在途遍历且不发送迟到响应', async () => {
  let finish!: (files: FileInfo[]) => void
  let notifyStarted!: () => void
  const started = new Promise<void>(resolve => { notifyStarted = resolve })
  const f = fixture(() => new Promise(resolve => { finish = resolve; notifyStarted() }))
  const pending = f.call()
  await started
  f.response.emit('close')
  await pending
  finish([])
  expect(f.sendJson).not.toHaveBeenCalled()
  expect(f.response.listenerCount('close')).toBe(0)
})
