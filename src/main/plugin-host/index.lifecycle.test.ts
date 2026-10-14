import { fork, type ChildProcess } from 'child_process'
import { createServer, type Server } from 'http'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { buildSync } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PluginSpec } from '@shared/plugin-types'

let directory: string
let server: Server
let child: ChildProcess | undefined
let messages: Array<{ type?: string; pluginId?: string; requestId?: string }>

async function waitForMessage(type: string, id: string, timeout = 1500): Promise<void> {
  const deadline = Date.now() + timeout
  while (!messages.some(message => message.type === type && (message.requestId === id || message.pluginId === id))) {
    if (Date.now() > deadline) throw new Error(`Missing ${type} for ${id}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'lyshell-host-lifecycle-'))
  messages = []
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ success: true, data: { status: 'ok' } }))
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  buildSync({
    entryPoints: [resolve('src/main/plugin-host/index.ts')], outfile: join(directory, 'host.cjs'),
    bundle: true, platform: 'node', format: 'cjs', tsconfig: resolve('tsconfig.node.json'), logLevel: 'silent'
  })
})

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(resolveExit => child!.once('exit', () => resolveExit()))
    child.kill()
    await exited
  }
  child = undefined
  await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  // 仅清理由 mkdtemp 创建的本测试目录。
  if (!resolve(directory).startsWith(resolve(tmpdir(), 'lyshell-host-lifecycle-'))) throw new Error('Invalid test directory')
  rmSync(directory, { recursive: true, force: true })
})

function launch(ids: string[], delay = 150): void {
  const specs: PluginSpec[] = ids.map(pluginId => {
    const main = `${pluginId}.cjs`
    const manifestPath = join(directory, `${pluginId}.json`)
    writeFileSync(manifestPath, JSON.stringify({
      id: pluginId, name: pluginId, version: '1.0.0', engines: { lyshell: '^2.0' }, runtime: 'node',
      lifecycle: 'persistent', main, activationEvents: ['onStartup'], capabilities: []
    }))
    writeFileSync(join(directory, main), `
      exports.activate = async () => {
        process.send({type:'activating', pluginId:${JSON.stringify(pluginId)}});
        await new Promise(resolve => setTimeout(resolve, ${delay}));
        process.send({type:'activated', pluginId:${JSON.stringify(pluginId)}});
      };
      exports.deactivate = async () => process.send({type:'cleanup', pluginId:${JSON.stringify(pluginId)}});
    `)
    return { pluginId, token: 'test-token', grantedCapabilities: [], manifestPath, pluginDir: directory, main, runtime: 'node', lifecycle: 'persistent' }
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test HTTP port')
  child = fork(join(directory, 'host.cjs'), [], { env: { ...process.env, LYSHELL_MCP_PORT: String(address.port) }, silent: true })
  child.on('message', message => messages.push(message as typeof messages[number]))
  child.send({ type: 'specs', specs })
}

describe('插件 host 启动期间停机', () => {
  it('activate 尚未完成时接收停机，等待激活落定后清理且只执行一次', async () => {
    launch(['slow-plugin'])
    await waitForMessage('activating', 'slow-plugin')
    child!.send({ type: 'deactivate', pluginId: 'slow-plugin', requestId: 'first' })
    child!.send({ type: 'deactivate', pluginId: 'slow-plugin', requestId: 'second' })
    await waitForMessage('deactivated', 'first')
    await waitForMessage('deactivated', 'second')
    const activatedIndex = messages.findIndex(message => message.type === 'activated')
    const cleanupIndex = messages.findIndex(message => message.type === 'cleanup')
    expect(cleanupIndex).toBeGreaterThan(activatedIndex)
    expect(messages.filter(message => message.type === 'cleanup')).toHaveLength(1)
  })

  it('尚未开始激活的插件收到停机后不再启动', async () => {
    launch(['slow-plugin', 'pending-plugin'])
    await waitForMessage('activating', 'slow-plugin')
    child!.send({ type: 'deactivate', pluginId: 'pending-plugin', requestId: 'pending' })
    await waitForMessage('deactivated', 'pending')
    await waitForMessage('activated', 'slow-plugin')
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
    expect(messages.some(message => message.pluginId === 'pending-plugin' && message.type === 'activating')).toBe(false)
  })

  it('health 回连期间的停机请求被保留，已取消的插件不会启动', async () => {
    server.removeAllListeners('request')
    server.on('request', (_request, response) => {
      child!.send({ type: 'deactivate', pluginId: 'early-plugin', requestId: 'early' })
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ success: true, data: { status: 'ok' } }))
      }, 100)
    })
    launch(['early-plugin'])
    await waitForMessage('deactivated', 'early')
    expect(messages.some(message => message.type === 'activating')).toBe(false)
  })

  it('activate 挂住时停机仍在 7s 预算内结束，不提前并发调用清理', async () => {
    launch(['hung-plugin'], 15000)
    await waitForMessage('activating', 'hung-plugin')
    const began = Date.now()
    child!.send({ type: 'deactivate', pluginId: 'hung-plugin', requestId: 'bounded' })
    await waitForMessage('deactivated', 'bounded', 10000)
    expect(Date.now() - began).toBeLessThan(9500)
    expect(messages.some(message => message.type === 'cleanup')).toBe(false)
  }, 12000)
})
