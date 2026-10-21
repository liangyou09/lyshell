import { afterEach, describe, expect, it } from 'vitest'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { base64Transform, stdioCommand } from './src/stdio'
import { validateTask, startService, activate } from './src/main'
import type { LegacyTask } from './src/types'
import { downloadViaExecPython } from './src/download-tcp'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })
const fingerprint = 'SHA256:' + 'a'.repeat(43)
const credentials = { host: '127.0.0.1', username: 'fixture', password: 'fixture-only', fingerprint }

async function transform(chunks: Buffer[], encode: boolean): Promise<Buffer> {
  const result: Buffer[] = []
  const stream = base64Transform(encode)
  stream.on('data', data => result.push(Buffer.from(data)))
  await pipeline(Readable.from(chunks), stream)
  return Buffer.concat(result)
}

describe('传统传输插件', () => {
  it('TCP 下载在打开目标时仍拒绝覆盖已有文件', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-exclusive-'))
    cleanup = () => fs.rm(root, { recursive: true, force: true })
    const localPath = path.join(root, 'existing')
    await fs.writeFile(localPath, 'keep')
    const task = { localPath, remotePath: '/tmp/file', sshConfig: {}, fileSize: 0 } as LegacyTask
    expect(() => downloadViaExecPython({} as never, task, Date.now(), () => {}, () => {}, () => {}, () => {})).toThrow()
    expect(await fs.readFile(localPath, 'utf8')).toBe('keep')
  })
  it('逐字节编码/解码保留二进制与空文件，拒绝截断编码', async () => {
    const binary = Buffer.from(Array.from({ length: 1025 }, (_, i) => i % 256))
    const encoded = await transform([...binary].map(byte => Buffer.from([byte])), true)
    expect(encoded.toString()).toBe(binary.toString('base64'))
    const decoded = await transform([...encoded].map(byte => Buffer.from([byte])), false)
    expect(decoded).toEqual(binary)
    expect(await transform([], true)).toEqual(Buffer.alloc(0))
    expect(await transform([], false)).toEqual(Buffer.alloc(0))
    await expect(transform([Buffer.from('YW')], false)).rejects.toThrow('Truncated')
    await expect(transform([Buffer.from('!error!')], false)).rejects.toThrow('Invalid')
    for (const value of ['====', 'Y===', 'YQ==YQ==', 'YQ==x']) {
      await expect(transform([Buffer.from(value)], false)).rejects.toThrow('Invalid')
    }
    await expect(transform([Buffer.from('YQ=='), Buffer.from('YQ==')], false)).rejects.toThrow('Invalid')
    await expect(transform([Buffer.from([0xd9, 0x51, 0x3d, 0x3d])], false)).rejects.toThrow('Invalid')
  })

  it('远端路径按 shell 引用，Python 与 Base64 无自动回退', () => {
    const task = { direction: 'upload', method: 'python', remotePath: "/tmp/a';$(touch bad)" } as LegacyTask
    expect(stdioCommand(task)).toContain("'\\''")
    expect(stdioCommand(task)).not.toContain(' || ')
    task.method = 'base64'
    expect(stdioCommand(task)).toContain('base64 -d')
    expect(stdioCommand(task)).not.toContain('python')
  })

  it('拒绝越界下载、已有目标、无指纹、目录上传和模式错配', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-validation-'))
    cleanup = () => fs.rm(root, { recursive: true, force: true })
    const valid = { ...credentials, direction: 'download', method: 'tcp', localPath: path.join(root, 'new'), remotePath: '/tmp/a' }
    expect((await validateTask(valid, root)).sshConfig.fingerprint).toBe(fingerprint)
    await expect(validateTask({ ...valid, localPath: path.join(root, '..', 'escape') }, root)).rejects.toThrow('download directory')
    await fs.writeFile(valid.localPath, 'existing')
    await expect(validateTask(valid, root)).rejects.toThrow('已存在')
    await expect(validateTask({ ...valid, fingerprint: '' }, root)).rejects.toThrow('指纹')
    await expect(validateTask({ ...valid, direction: 'upload', localPath: root }, root)).rejects.toThrow('普通文件')
    await expect(validateTask({ ...valid, method: 'python', shellEnterCommands: 'enter' }, root)).rejects.toThrow('仅支持')
    await expect(validateTask({ ...valid, method: ['tcp'] }, root)).rejects.toThrow('传输方式')
    await expect(validateTask({ ...valid, direction: ['download'] }, root)).rejects.toThrow('上传或下载')
  })

  it('缺少清单权限时不启动服务', async () => {
    await expect(activate({ grantedCapabilities: ['read'] } as never)).rejects.toThrow('权限')
  })

  it('回环服务拒绝其他来源、缺少来源和无效凭据', async () => {
    const service = await startService('unused-worker.js')
    cleanup = service.stop
    const base = `http://127.0.0.1:${service.port}`
    expect((await fetch(`${base}/handshake`)).status).toBe(403)
    expect((await fetch(`${base}/handshake`, { headers: { Origin: 'https://example.com' } })).status).toBe(403)
    const headers = { Origin: 'lyshell-plugin://legacy-transfer' }
    const handshake = await fetch(`${base}/handshake`, { headers })
    expect(handshake.headers.get('access-control-allow-origin')).toBe(headers.Origin)
    const { token } = await handshake.json() as { token: string }
    expect(token).toHaveLength(64)
    expect((await fetch(`${base}/state`, { headers })).status).toBe(401)
    const state = await fetch(`${base}/state`, { headers: { ...headers, Authorization: `Bearer ${token}` } })
    expect(await state.json()).toEqual({ task: null })
  })
})
