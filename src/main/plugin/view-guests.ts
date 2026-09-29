/**
 * 插件视图 guest 身份登记表（main 侧）
 *
 * did-attach-webview 时登记 webContents.id → {pluginId, viewId, kind, ownerWindowId,
 * dialogId?}，销毁时清理（index.ts 的 attach 闸调用）。guest IPC（view-bridge.ts）
 * 每次调用凭此核对 event.sender 的登记身份 —— 不信任 renderer 自报 guest ID。
 *
 * 身份只能由 main 的 webview attach 闸（will-attach/did-attach）写入；插件的
 * panel/dialog 身份由此派生，页面自报无效。纯状态模块（无 electron 依赖），可测。
 */

/** guest 种类：常挂面板 / 一次性弹窗 */
export type PluginGuestKind = 'panel' | 'dialog'

export interface PluginGuestRecord {
  webContentsId: number
  pluginId: string
  viewId: string
  kind: PluginGuestKind
  /** 所属主窗口 id（动作请求路由回该窗口） */
  ownerWindowId: number
  /** kind === 'dialog' 时的一次性弹窗 id */
  dialogId?: string
}

class PluginGuestRegistry {
  private guests = new Map<number, PluginGuestRecord>()

  /** attach 闸写入（同 webContentsId 重复登记以最后一次为准） */
  attach(record: PluginGuestRecord): void {
    this.guests.set(record.webContentsId, record)
  }

  /** destroyed 清理；返回被清的记录（供弹窗联动取消） */
  detach(webContentsId: number): PluginGuestRecord | null {
    const rec = this.guests.get(webContentsId) ?? null
    if (rec) this.guests.delete(webContentsId)
    return rec
  }

  /** 精确取登记（guest IPC 核对用；未登记 = 非 guest 或伪造） */
  get(webContentsId: number): PluginGuestRecord | null {
    return this.guests.get(webContentsId) ?? null
  }

  /** 该插件的全部 guest（注销视图/禁用插件时关闭面板与弹窗） */
  listByPlugin(pluginId: string): PluginGuestRecord[] {
    return [...this.guests.values()].filter((g) => g.pluginId === pluginId)
  }

  /** 某视图的 panel guest（注销视图时定向关闭） */
  listByView(pluginId: string, viewId: string): PluginGuestRecord[] {
    return this.listByPlugin(pluginId).filter((g) => g.viewId === viewId)
  }

  /** 某主窗口的全部 guest（窗口关闭时清理） */
  listByWindow(ownerWindowId: number): PluginGuestRecord[] {
    return [...this.guests.values()].filter((g) => g.ownerWindowId === ownerWindowId)
  }

  /** 全部在册 guest（主题变化等全局广播用） */
  listAll(): PluginGuestRecord[] {
    return [...this.guests.values()]
  }

  clear(): void {
    this.guests.clear()
  }
}

export const pluginGuestRegistry = new PluginGuestRegistry()
