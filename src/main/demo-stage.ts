import { app, type BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** 仅显式演示启动启用；只接受七个固定场景，不能执行任意代码或终端输入。 */
export function startDemoStage(window: BrowserWindow): void {
  if (!process.argv.includes('--demo-stage')) return
  window.webContents.setBackgroundThrottling(false)
  window.webContents.on('did-finish-load', () => {
    window.setTitle('LyShell · 自动演示')
    window.webContents.setZoomFactor(1)
  })
  const token = randomBytes(32).toString('hex')
  const file = join(app.getPath('userData'), 'demo-stage.json')
  let busy = false
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method !== 'POST' || req.url !== '/scene' || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end('{}'); return
    }
    if (busy || window.isDestroyed()) { res.writeHead(409).end('{}'); return }
    busy = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let execution: Promise<unknown> | undefined
    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk.toString()
        if (body.length > 100) throw new Error('请求过长')
      }
      const { index } = JSON.parse(body) as { index: unknown }
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 6) throw new Error('场景无效')
      if (window.isMinimized()) window.restore()
      if (window.isMaximized()) window.unmaximize()
      window.setContentSize(1920, 1080)
      window.center()
      window.showInactive()
      execution = window.webContents.executeJavaScript(`window.lyshellDemoScene(${index})`)
      const result = await Promise.race([
        execution,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('画面切换超时')), 15000) })
      ])
      res.end(JSON.stringify({ ready: result === index, index }))
    } catch (error) {
      res.writeHead(500).end(JSON.stringify({ error: error instanceof Error ? error.message : '场景失败' }))
    } finally {
      clearTimeout(timer)
      // 超时只结束 HTTP 等待，不会取消渲染器执行；旧场景结束前不能放行下一场。
      // 同时消费迟到的失败，避免超时后的拒绝成为未处理异常。
      if (execution) await execution.catch(() => {})
      busy = false
    }
  })
  server.requestTimeout = 20000
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address && typeof address !== 'string') writeFileSync(file, JSON.stringify({ port: address.port, token, pid: process.pid }), { mode: 0o600 })
    window.setTitle('LyShell · 自动演示')
  })
  server.on('error', (error) => console.error('[demo-stage]', error.message))
  window.once('closed', () => { server.close(); try { unlinkSync(file) } catch { /* 已清理 */ } })
}
