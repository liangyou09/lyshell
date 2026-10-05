import { spawn } from 'child_process'
import { once } from 'events'
import { expect, it } from 'vitest'
import { terminatePluginProcess } from './process-cleanup'

/** 真实 POSIX 进程组：根提前退出，忽略 SIGTERM 的 HTTP 服务仍必须被整组强杀。 */
it.skipIf(process.platform === 'win32')('回收根退出后仍存活的真实伴生服务', async () => {
  const worker = `
    process.on('SIGTERM', () => {});
    const server = require('http').createServer((_req, res) => res.end('alive'));
    server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));
  `
  const root = spawn(process.execPath, ['-e', `
    const worker = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: ['ignore', 'pipe', 'ignore'] });
    worker.stdout.on('data', chunk => process.stdout.write(chunk));
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    const [chunk] = await once(root.stdout!, 'data')
    const { port } = JSON.parse(String(chunk)) as { port: number }
    const url = `http://127.0.0.1:${port}`
    const response = await fetch(url)
    await response.text()
    let finished = false
    const exited = once(root, 'exit')
    const cleanup = terminatePluginProcess(root, { processGroup: true }).then(() => { finished = true })
    await exited
    expect(finished).toBe(false)
    await (await fetch(url)).text() // 根退出后服务仍活着，不能提前宣布回收完成。
    await cleanup
    await expect(fetch(url)).rejects.toThrow()
  } finally {
    try { if (root.pid) process.kill(-root.pid, 'SIGKILL') } catch { /* 已回收 */ }
  }
}, 10000)
