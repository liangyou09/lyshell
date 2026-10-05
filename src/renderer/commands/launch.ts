import { useSessionStore } from '../stores/session-store'
import { ConnectionStatus } from '@shared/types'
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
 *
 * 返回可判定结果:connection:connect 同步落位失败(校验/建会话失败,ERROR 状态)
 * 如实回 ok:false;ok:true 表示会话已创建并开始异步连接,不保证 SSH 最终连通
 * (最终连通由后续 connection:status 事件呈现)。插件视图 openTerminal 动作依赖
 * 该结果回执,不能无条件 ok:true。
 */
export interface ConnectSessionResult {
  ok: boolean
  /** 新建 runtime 会话的 id(后端同步返回;落位失败时缺省) */
  sessionId?: string
  error?: string
}

export async function connectSession(config: SessionConfig, pluginActionRequestId?: string): Promise<ConnectSessionResult> {
  try {
    // 临时会话没有 saved id，直接连接；更新接口只接受已保存会话。
    // 插件动作的 touch 由 main 在授权后执行，撤销后不能先写回再拒绝连接。
    if (!pluginActionRequestId && config.id.trim()) {
      const updated = await window.electronAPI?.updateSession({
        ...config,
        updatedAt: new Date()
      })
      if (updated && typeof updated === 'object' && 'success' in updated && updated.success === false) {
        return {
          ok: false,
          error: 'error' in updated && typeof updated.error === 'string' ? updated.error : 'session update failed'
        }
      }
      await useSessionStore.getState().refreshSavedSessions()
    }

    const runtimeConfig: SessionConfig = { ...config, id: '', originSavedSessionId: config.id.trim() ? config.id : undefined }

    // 调用后端连接（后端会立即返回 sessionId，前端显示终端）
    const res = await window.electronAPI?.connect(runtimeConfig, pluginActionRequestId)
    if (res && typeof res === 'object' && 'status' in res) {
      const status = (res as { status?: unknown }).status
      if (status === ConnectionStatus.ERROR) {
        const err = (res as { error?: unknown }).error
        return { ok: false, error: typeof err === 'string' && err ? err : 'connect failed' }
      }
      return { ok: true, sessionId: (res as { id?: string }).id }
    }
    return { ok: true }
  } catch (error) {
    console.error('Connect failed:', error)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
