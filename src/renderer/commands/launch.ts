import { useSessionStore } from '../stores/session-store'
import type { SessionConfig } from '@shared/types'

/**
 * 会话启动的共用本体 —— 原先长在 MainWindow.handleConnect 里,SessionsPanel
 * 会话卡片点击、/ls 清点文档的行链接(open-session)都要走同一条链,抽出防漂移:
 *
 * touch 访问时间(仍用原 saved id)→ 刷新 saved 列表 → 以 runtime 克隆连接。
 * 每次点击 saved session 都创建新的 runtime 会话:把 id 置空让后端生成新 UUID,
 * 避免同一 saved id 只能对应一个终端页签;通过 originSavedSessionId 保留与原
 * 保存项的关联,供 MCP list_sessions 同步状态。连上后由 MainWindow 的
 * onConnectionStatus 自动挂到活动分屏(与 /local 命令同一条挂载路径)。
 */
export async function connectSession(config: SessionConfig): Promise<void> {
  try {
    // 更新访问时间（仍用原 saved id）
    await window.electronAPI?.updateSession({
      ...config,
      updatedAt: new Date()
    })
    await useSessionStore.getState().refreshSavedSessions()

    const runtimeConfig: SessionConfig = { ...config, id: '', originSavedSessionId: config.id }

    // 调用后端连接（后端会立即返回 sessionId，前端显示终端）
    await window.electronAPI?.connect(runtimeConfig)
  } catch (error) {
    console.error('Connect failed:', error)
  }
}
