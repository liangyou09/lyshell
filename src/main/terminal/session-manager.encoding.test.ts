/**
 * setSessionEncoding 集成测试 —— 运行时编码切换的三条核心语义:
 *   1. 配置与连接器漂移时照常落位修复(短路只认「两边都同值」,漂移不吞)
 *   2. 同值幂等短路(不重设连接器、不推事件)
 *   3. 重连保持运行时编码(connectSessionAttempt 经 withRuntimeEncoding 从
 *      session.config.terminal.encoding 派生 connector 编码)
 * 另兜 local 拒绝与未知 id 两个防御分支。
 *
 * mock 边界:connectors 换成记录型桩(ssh2/serialport/node-pty 是原生模块,
 * vitest Node 环境加载即炸);electron/electron-log/@main/file/@main/mcp/auth
 * 对齐既有测试的 mock 手法。桩的 setEncoding 不做同值短路 —— 本文件测的是
 * session-manager 是否调它,connector 内部的守卫由 base.test.ts 覆盖。
 * vi.mock 工厂被提升到 import 之前,不能引用模块体的类:桩类定义在工厂内
 * (async import 拿 EventEmitter),测试体经 mock 导出拿回引用。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConnectionType } from '@shared/types'
import type { SessionConfig, TerminalEncoding } from '@shared/types'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
}))
vi.mock('@main/file', () => ({
  fileManager: { removeConnector: async () => {} },
  cancelDownloadsBySession: () => {},
  cancelUploadsBySession: () => {}
}))
vi.mock('@main/mcp/auth', () => ({
  bindSessionToken: () => 'test-token',
  revokeSessionToken: () => {}
}))

// session-manager 从 '../connectors' 导入四个连接器与两个枚举 —— 整体换成桩。
// 枚举用同值字符串字面量(base.ts 与 @shared/types 是两份同值定义,重导真枚举会
// 连带加载 serialport/node-pty 原生模块)
vi.mock('../connectors', async () => {
  const { EventEmitter } = await import('events')

  /** 记录型连接器桩:构造入参(config.encoding 即 withRuntimeEncoding 的派生结果)与
   *  setEncoding 调用都留痕,供重连保持 / 漂移修复断言 */
  class FakeConnector extends EventEmitter {
    static instances: Array<{
      encoding: TerminalEncoding
      setEncodingCalls: TerminalEncoding[]
      connected: boolean
      getEncoding(): TerminalEncoding
      setEncoding(encoding: TerminalEncoding): void
    }> = []
    encoding: TerminalEncoding
    setEncodingCalls: TerminalEncoding[] = []
    connected = false
    constructor(_sessionId: string, config: { encoding?: TerminalEncoding } = {}) {
      super()
      this.encoding = config.encoding ?? 'utf-8'
      FakeConnector.instances.push(this)
    }
    async connect(): Promise<void> { this.connected = true }
    async disconnect(): Promise<void> { this.connected = false }
    write(_data: string | Buffer): void {}
    resize(_cols: number, _rows: number): void {}
    setEncoding(encoding: TerminalEncoding): void {
      this.setEncodingCalls.push(encoding)
      this.encoding = encoding
    }
    getEncoding(): TerminalEncoding { return this.encoding }
    // local 桩补齐:四个连接器名共用一个桩类,session-manager 的 LOCAL 分支对
    // instanceof LocalConnector 的桩(telnet 会话也命中)会调它取 spawn 种子
    getSpawnCwd(): string | null { return null }
    isConnected(): boolean { return this.connected }
  }

  return {
    SSHConnector: FakeConnector,
    TelnetConnector: FakeConnector,
    SerialConnector: FakeConnector,
    LocalConnector: FakeConnector,
    ConnectionStatus: {
      DISCONNECTED: 'disconnected', CONNECTING: 'connecting', CONNECTED: 'connected',
      RECONNECTING: 'reconnecting', ERROR: 'error'
    },
    ConnectionType: { SSH: 'ssh', TELNET: 'telnet', SERIAL: 'serial', LOCAL: 'local' }
  }
})

import { sessionManager } from './session-manager'
// 四个名字导出的是同一个桩类 —— 取任一拿静态 instances 表
import { TelnetConnector } from '../connectors'

/** 桩类在 mock 工厂内定义,测试体里以结构化类型拿静态表 */
const fakeInstances = (): Array<{
  encoding: TerminalEncoding
  setEncodingCalls: TerminalEncoding[]
  getEncoding(): TerminalEncoding
}> => (TelnetConnector as unknown as { instances: Array<never> }).instances as never

/** 构造最小 telnet 会话配置(connectSessionAttempt 的 telnet 分支无外部依赖) */
const telnetConfig = (encoding: TerminalEncoding): SessionConfig => ({
  id: '',
  name: 'encoding-test',
  type: ConnectionType.TELNET,
  telnet: { host: '127.0.0.1', port: 23 },
  terminal: {
    fontFamily: 'Consolas', fontSize: 12, theme: {} as SessionConfig['terminal']['theme'],
    cursorStyle: 'bar', cursorBlink: false, scrollback: 10, encoding
  },
  tags: [], createdAt: new Date(), updatedAt: new Date()
})

const encodingEvents: Array<{ sessionId: string; encoding: TerminalEncoding }> = []

function onEncodingChanged(payload: { sessionId: string; encoding: TerminalEncoding }): void {
  encodingEvents.push(payload)
}

beforeEach(() => {
  fakeInstances().length = 0
  sessionManager.on('session:encoding-changed', onEncodingChanged)
})

afterEach(async () => {
  sessionManager.off('session:encoding-changed', onEncodingChanged)
  encodingEvents.length = 0
  // 单例 Map 是跨用例共享的:逐个走完整删除流程(断开/清缓冲)清场
  for (const s of sessionManager.getAllSessions()) {
    try { await sessionManager.deleteSession(s.id) } catch { /* 已清则过 */ }
  }
  fakeInstances().length = 0
})

describe('setSessionEncoding 漂移修复', () => {
  it('config 与 connector 漂移(config=gbk, connector 被拉回 utf-8)时照常落位修复', async () => {
    const session = await sessionManager.createSession(telnetConfig('utf-8'))
    await sessionManager.connectSession(session.id)
    const conn = fakeInstances()[0]
    expect(conn.getEncoding()).toBe('utf-8')

    // 运行时切到 gbk(config 与 connector 同步落位)
    expect(sessionManager.setSessionEncoding(session.id, 'gbk')).toBe(true)
    expect(conn.getEncoding()).toBe('gbk')

    // 模拟漂移:connector 被外部路径拉回 utf-8 而 config 仍是 gbk
    // —— 若短路只认 config 同值,这次调用会被吞、漂移永不修复
    conn.encoding = 'utf-8'
    encodingEvents.length = 0
    conn.setEncodingCalls.length = 0

    expect(sessionManager.setSessionEncoding(session.id, 'gbk')).toBe(true)
    expect(conn.setEncodingCalls).toEqual(['gbk'])
    expect(conn.getEncoding()).toBe('gbk')
    expect(encodingEvents).toEqual([{ sessionId: session.id, encoding: 'gbk' }])
  })
})

describe('setSessionEncoding 同值短路', () => {
  it('config 与 connector 都是当前值时不重设连接器、不推事件', async () => {
    const session = await sessionManager.createSession(telnetConfig('utf-8'))
    await sessionManager.connectSession(session.id)

    const conn = fakeInstances()[0]
    conn.setEncodingCalls.length = 0
    encodingEvents.length = 0

    // 返回 true:调用方语义是「该会话当前即此编码」
    expect(sessionManager.setSessionEncoding(session.id, 'utf-8')).toBe(true)
    expect(conn.setEncodingCalls).toEqual([])
    expect(encodingEvents).toEqual([])
  })
})

describe('setSessionEncoding 重连保持', () => {
  it('运行时切换后断开重连,新连接器按切换后的编码构造', async () => {
    const session = await sessionManager.createSession(telnetConfig('utf-8'))
    await sessionManager.connectSession(session.id)
    // 首连按保存值 utf-8 构造
    expect(fakeInstances()[0].encoding).toBe('utf-8')

    expect(sessionManager.setSessionEncoding(session.id, 'gbk')).toBe(true)

    await sessionManager.disconnectSession(session.id)
    await sessionManager.connectSession(session.id)

    // 重连未新建 Session、config 保留运行时切换值 —— withRuntimeEncoding 派生 gbk
    expect(fakeInstances()).toHaveLength(2)
    expect(fakeInstances()[1].encoding).toBe('gbk')
    expect(fakeInstances()[1].getEncoding()).toBe('gbk')
    expect(sessionManager.getSession(session.id)!.config.terminal.encoding).toBe('gbk')
  })
})

describe('setSessionEncoding 防御分支', () => {
  it('local 会话恒拒绝(ConPTY 无编码层)', async () => {
    const config = telnetConfig('utf-8')
    config.type = ConnectionType.LOCAL
    const session = await sessionManager.createSession(config)
    expect(sessionManager.setSessionEncoding(session.id, 'gbk')).toBe(false)
  })

  it('未知会话 id 返回 false', () => {
    expect(sessionManager.setSessionEncoding('no-such-session', 'gbk')).toBe(false)
  })
})
