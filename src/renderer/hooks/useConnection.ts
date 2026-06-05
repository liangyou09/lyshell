import { useEffect, useCallback } from 'react'
import { useSessionStore } from '../stores/session-store'
import type { SessionConfig } from '@shared/types'

/**
 * 连接 Hook
 */
export function useConnection(sessionId: string | null) {
  const { sessions, connectSession, disconnectSession, reconnectSession, updateSessionStatus } = useSessionStore()
  const session = sessions.find(s => s.id === sessionId)

  // 连接
  const connect = useCallback(async () => {
    if (!sessionId) return
    await connectSession(sessionId)
  }, [sessionId, connectSession])

  // 断开
  const disconnect = useCallback(async () => {
    if (!sessionId) return
    await disconnectSession(sessionId)
  }, [sessionId, disconnectSession])

  // 重连
  const reconnect = useCallback(async () => {
    if (!sessionId) return
    await reconnectSession(sessionId)
  }, [sessionId, reconnectSession])

  // 监听状态变化
  useEffect(() => {
    if (!window.electronAPI) return

    const cleanup = window.electronAPI.onConnectionStatus((_event, data) => {
      if (data.id === sessionId) {
        updateSessionStatus(data.id, data.status, data.error)
      }
    })

    return cleanup
  }, [sessionId, updateSessionStatus])

  return {
    session,
    status: session?.status,
    error: session?.lastError,
    connect,
    disconnect,
    reconnect,
    isConnected: session?.status === 'connected',
    isConnecting: session?.status === 'connecting'
  }
}

/**
 * 终端数据 Hook
 */
export function useTerminalData(sessionId: string) {
  // Terminal store doesn't have receiveData/sendData/dataBuffers methods
  // Data is handled directly through electronAPI

  // 监听终端数据
  useEffect(() => {
    if (!window.electronAPI || !sessionId) return

    const cleanup = window.electronAPI.onTerminalData((_event, id, _data) => {
      if (id === sessionId) {
        // Data handling is done directly in TerminalView component
      }
    })

    return cleanup
  }, [sessionId])

  // 发送数据
  const write = useCallback((data: string) => {
    window.electronAPI?.terminalWrite(sessionId, data)
  }, [sessionId])

  return {
    write
  }
}

/**
 * 快速连接 Hook
 */
export function useQuickConnect() {
  const { createSession, connectSession, setActiveSession } = useSessionStore()

  const quickConnect = useCallback(async (config: SessionConfig) => {
    try {
      // 创建会话
      const session = await createSession(config)

      // 连接
      await connectSession(session.id)

      // 设为活动
      setActiveSession(session.id)

      return session
    } catch (error) {
      console.error('Quick connect failed:', error)
      throw error
    }
  }, [createSession, connectSession, setActiveSession])

  return { quickConnect }
}