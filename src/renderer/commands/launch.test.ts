// @vitest-environment jsdom
/**
 * connectSession 单测 —— MainWindow.handleConnect 抽出的共用本体:
 * touch 访问时间 → 刷新 saved 列表 → 以 runtime 克隆连接(id 置空 + originSavedSessionId)。
 * SessionsPanel 点击会话卡片与 /ls 清点文档的 open-session 行链接走同一条链。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { connectSession } from './launch'
import { useSessionStore } from '../stores/session-store'
import { ConnectionStatus, ConnectionType } from '@shared/types'
import type { SessionConfig } from '@shared/types'

const updateSession = vi.fn()
const connect = vi.fn()
const listSessions = vi.fn()

/** 测试用终端配置占位(启动链不消费该字段) */
const terminal = {} as SessionConfig['terminal']

const savedSsh: SessionConfig = {
  id: 'saved-1',
  name: 'prod',
  type: ConnectionType.SSH,
  ssh: { host: '10.0.0.1', port: 22, username: 'root' },
  terminal,
  tags: [],
  createdAt: new Date(),
  updatedAt: new Date()
}

beforeEach(() => {
  updateSession.mockReset().mockResolvedValue(undefined)
  connect.mockReset().mockResolvedValue('session-x')
  listSessions.mockReset().mockResolvedValue([])
  // session-store 是模块级单例,测试间归零防串扰
  useSessionStore.setState({ savedSessions: [] })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { updateSession, connect, listSessions }
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('connectSession:启动链路', () => {
  it('插件动作直接交给 main 授权，拒绝后不留下任何保存副作用', async () => {
    connect.mockResolvedValue({ status: ConnectionStatus.ERROR, error: 'Plugin terminal action is no longer active' })
    const result = await connectSession(savedSsh, 'plugin-request')
    expect(result.ok).toBe(false)
    expect(updateSession).not.toHaveBeenCalled()
    expect(listSessions).not.toHaveBeenCalled()
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ id: '', originSavedSessionId: savedSsh.id }), 'plugin-request')
  })

  it('普通启动遇到已删除配置时停止，不创建新的运行时连接', async () => {
    updateSession.mockResolvedValue({ success: false, error: 'Session no longer exists' })
    await expect(connectSession(savedSsh)).resolves.toEqual({ ok: false, error: 'Session no longer exists' })
    expect(connect).not.toHaveBeenCalled()
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('touch 访问时间(仍用原 saved id)→ 刷新 saved 列表 → 以 runtime 克隆连接', async () => {
    await connectSession(savedSsh)

    expect(updateSession).toHaveBeenCalledTimes(1)
    const touched = updateSession.mock.calls[0][0] as SessionConfig
    expect(touched.id).toBe('saved-1')
    expect(touched.updatedAt).toBeInstanceOf(Date)
    expect(touched.updatedAt.getTime()).toBeGreaterThanOrEqual(savedSsh.updatedAt.getTime())

    // refreshSavedSessions(listSessions)
    expect(listSessions).toHaveBeenCalledTimes(1)

    expect(connect).toHaveBeenCalledTimes(1)
    const runtime = connect.mock.calls[0][0] as SessionConfig
    expect(runtime.id).toBe('')  // 置空让后端生成新 UUID,同一 saved 可对应多个终端页签
    expect(runtime.originSavedSessionId).toBe('saved-1')
    expect(runtime.name).toBe('prod')
    expect(runtime.ssh).toBe(savedSsh.ssh)  // 其余配置原样带过去
  })

  it('连接失败不外抛(原 handleConnect 同款:静默 + 控制台留痕),回 ok:false 结果', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    connect.mockRejectedValue(new Error('boom'))
    try {
      await expect(connectSession(savedSsh)).resolves.toEqual({ ok: false, error: 'boom' })
    } finally {
      errSpy.mockRestore()
    }
  })

  it('connection:connect 同步落位 ERROR 状态如实回 ok:false(不无条件 ok)', async () => {
    connect.mockResolvedValue({ id: 'temp-1', status: ConnectionStatus.ERROR, error: 'auth failed' })
    await expect(connectSession(savedSsh)).resolves.toEqual({ ok: false, error: 'auth failed' })
  })

  it('落位成功回 ok:true + 会话 id（不保证最终连通）', async () => {
    connect.mockResolvedValue({ id: 'session-x', status: ConnectionStatus.CONNECTING, config: savedSsh })
    await expect(connectSession(savedSsh)).resolves.toEqual({ ok: true, sessionId: 'session-x' })
  })
})
