import { app, type BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Explicit demo instances accept fixed scenes only; no arbitrary commands or URLs. */
export function startDemoStage(window: BrowserWindow): void {
  if (!process.argv.includes('--demo-stage')) return
  const captureBorderX = Number(process.env.LYSHELL_DEMO_CAPTURE_BORDER_X ?? 0)
  if (!Number.isInteger(captureBorderX) || captureBorderX < 0 || captureBorderX > 16) throw new Error('Invalid demo capture border correction')
  window.webContents.setBackgroundThrottling(false)
  window.webContents.on('did-finish-load', () => {
    window.setTitle('LyShell · 自动演示')
    window.webContents.setZoomFactor(1)
  })
  const token = randomBytes(32).toString('hex')
  const file = join(app.getPath('userData'), 'demo-stage.json')
  let busy = false
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && ['/web-demo/index.html', '/web-demo/guide.html'].includes(req.url ?? '')) {
      const guide = req.url === '/web-demo/guide.html'
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<!doctype html><meta charset="utf-8"><title>LyShell 本地演示${guide ? '指南' : '首页'}</title><style>body{font:20px/1.8 system-ui;margin:48px;color:#24352e;background:#faf8f0}h1{font-size:32px}a{color:#356957}input{font:inherit;padding:8px;max-width:85%}</style><h1>${guide ? '网页与终端，同一个工作区' : 'LyShell · 本地演示网页'}</h1><p>此页面由本机演示实例提供，用于验证网页导航与状态保留。</p><p><a href="${guide ? 'index' : 'guide'}.html">${guide ? '返回首页' : '打开使用指南'}</a></p><label>保活测试：<input id="keep-alive" placeholder="在此输入，再切换页签"></label>`)
      return
    }
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
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 45 || (index > 6 && index < 18)) throw new Error('场景无效')
      if (window.isMinimized()) window.restore()
      if (window.isMaximized()) window.unmaximize()
      // Window capture includes the frameless window's native border on Windows.
      // Size the captured window, keeping the application's original font scale.
      window.setBounds({ width: 1920 - captureBorderX, height: 1080 })
      window.center()
      window.showInactive()
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('演示服务未就绪')
      execution = window.webContents.executeJavaScript(`window.lyshellDemoOrigin='http://127.0.0.1:${address.port}';window.lyshellDemoScene(${index})`)
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
