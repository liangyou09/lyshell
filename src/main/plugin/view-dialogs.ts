/**
 * 插件视图弹窗生命周期（main 侧持有，纯状态 + 注入宿主回调，可测）
 *
 * 契约（docs/plugin-ui-views-plan.md §四「openDialog」）：
 *   - openDialog 只能打开本插件已注册的视图；main 生成一次性 dialogId，先记录
 *     「dialogId → 发起 guest、目标插件/视图、所属窗口、到期时间」，attach 成功后
 *     补记目标 guest（did-attach）。
 *   - dialogId 单次消费：will-attach 闸按「窗口/pluginId/viewId/入口」逐项匹配后
 *     即消费，第二个 webview 再用同一 dialogId 一律拒绝。
 *   - 只有目标 dialog guest 可 closeDialog；结果只发送给发起 guest，多个同插件
 *     视图或并发弹窗互不串扰。
 *   - 每插件在册弹窗（pending/staged/attached 全阶段合计）上限 MAX_DIALOGS_PER_PLUGIN，
 *     create 时强制核对 —— renderer 把弹窗加入列表时即回执动作，在途动作闸
 *     （view-actions MAX_PENDING_PER_PLUGIN）管不到已挂弹窗，不设上限时 guest 连续
 *     openDialog 可刷出无上限的 webview。
 *   - 挂载失败、超时、发起者/弹窗销毁、注销视图或禁用插件时清理并通知取消。
 *   - 超时由 create 时的到期定时器驱动（挂载中断无需等下一次 create 的惰性清扫
 *     才收口）；sweepExpired 保留为生成新弹窗时的兜底。
 */
import { randomBytes } from 'crypto'

/** 待挂载弹窗记录（create 后、did-attach 前） */
export interface PendingPluginDialog {
  dialogId: string
  /** 发起 guest webContents id（结果只回给它） */
  invokerContentsId: number
  pluginId: string
  viewId: string
  /** 目标视图入口在 URL 上的形态（剥 views/ 前缀），attach 闸逐项比对 */
  entryPath: string
  ownerWindowId: number
  expiresAt: number
}

/** 已 attach 的弹窗（did-attach 后） */
export interface AttachedPluginDialog extends PendingPluginDialog {
  dialogContentsId: number
}

export type DialogCloseReason = 'result' | 'timeout' | 'attach-failed' | 'invoker-destroyed' | 'dialog-destroyed' | 'plugin-removed' | 'view-unregistered' | 'window-closed'

/** 宿主侧回调：guest 事件推送 / guest 关闭由 electron 接线层实现（view-bridge/index.ts） */
export interface DialogHostHooks {
  /** 结果/取消只发给发起 guest（PLUGIN_VIEW_EVENT: dialogResult / dialogCancelled） */
  sendToGuest(webContentsId: number, payload: unknown): void
  /** 关闭弹窗 guest webContents（main 强制销毁，renderer 靠 webview destroyed 事件卸载） */
  closeGuest(webContentsId: number): void
}

const DEFAULT_TTL_MS = 30_000

/** 每插件同时在册弹窗上限（pending/staged/attached 全阶段合计）。create 时强制
 *  核对；关闭/超时/注销/放弃路径释放容量。与 view-actions 的在途动作闸
 *  （MAX_PENDING_PER_PLUGIN）互补 —— 那个只覆盖等待 renderer 回执的请求 */
export const MAX_DIALOGS_PER_PLUGIN = 8

export class PluginDialogManager {
  private pending = new Map<string, PendingPluginDialog>()
  /** 已过 will-attach 闸、待 did-attach 补记（consume 与 complete 之间的握手台） */
  private staged = new Map<string, PendingPluginDialog>()
  private attached = new Map<string, AttachedPluginDialog>()
  /** dialogId → 到期定时器（pending/staged 的超时收口；complete/cancel/放弃时撤） */
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private hooks: DialogHostHooks, private ttlMs = DEFAULT_TTL_MS) {}

  /**
   * 生成一次性 dialogId 并登记待挂载记录（renderer 随后用带 dialogId 的入口 URL 挂载）。
   * @throws 该插件在册弹窗（pending/staged/attached 合计）达到 MAX_DIALOGS_PER_PLUGIN
   *   时抛错 —— 调用方（view-bridge）转为 openDialog 的确定失败回执
   */
  create(opts: {
    invokerContentsId: number
    pluginId: string
    viewId: string
    entryPath: string
    ownerWindowId: number
  }): PendingPluginDialog {
    // 到期清扫顺带做：过期记录在生成新弹窗时统一回收（到期定时器的兜底），同时
    // 释放容量 —— 超期未挂载的 pending/staged 不挡新弹窗
    this.sweepExpired()
    const live = this.idsMatching((p) => p.pluginId === opts.pluginId).length
    if (live >= MAX_DIALOGS_PER_PLUGIN) {
      throw new Error(`too many open dialogs for plugin ${opts.pluginId} (max ${MAX_DIALOGS_PER_PLUGIN})`)
    }
    const record: PendingPluginDialog = {
      dialogId: randomBytes(24).toString('base64url'),
      invokerContentsId: opts.invokerContentsId,
      pluginId: opts.pluginId,
      viewId: opts.viewId,
      entryPath: opts.entryPath,
      ownerWindowId: opts.ownerWindowId,
      expiresAt: Date.now() + this.ttlMs
    }
    this.pending.set(record.dialogId, record)
    this.armExpiry(record.dialogId)
    return record
  }

  /** 取待挂载记录（attach 闸预检；不消费） */
  getPending(dialogId: string): PendingPluginDialog | null {
    return this.pending.get(dialogId) ?? null
  }

  /**
   * attach 闸消费：dialogId 必须存在、未过期，且窗口/pluginId/viewId/入口逐项匹配。
   * 单次消费 —— 命中即从 pending 移入 staged（attach 失败也已被消费，需重新发起），
   * staged 记录由 completeAttach 补记为 attached；did-attach 不来时由到期清扫回收。
   * @returns null 表示不匹配/过期/已消费（调用方拒 attach）
   */
  consumeForAttach(dialogId: string, expect: { pluginId: string; viewId: string; entryPath: string; ownerWindowId: number }): PendingPluginDialog | null {
    const rec = this.pending.get(dialogId)
    if (!rec) return null
    this.pending.delete(dialogId)
    if (rec.expiresAt < Date.now()) {
      this.clearExpiry(dialogId)
      return null
    }
    if (
      rec.pluginId !== expect.pluginId ||
      rec.viewId !== expect.viewId ||
      rec.entryPath !== expect.entryPath ||
      rec.ownerWindowId !== expect.ownerWindowId
    ) {
      this.clearExpiry(dialogId)
      return null
    }
    // 移入 staged 但不撤定时器：did-attach 未到仍受同一到期约束（挂载中断按期收口）
    this.staged.set(dialogId, rec)
    return rec
  }

  /** did-attach 补记目标 guest（此后 dialog guest 的 closeDialog 才有效）。
   *  只接受过了 attach 闸的 staged 记录 —— 未经闸的 dialogId 不能凭空转正 */
  completeAttach(dialogId: string, dialogContentsId: number): AttachedPluginDialog | null {
    const rec = this.staged.get(dialogId)
    if (!rec) return null
    this.staged.delete(dialogId)
    // 已挂弹窗不受 TTL 限制（用户交互中，由关闭路径管理）：到期定时器即撤
    this.clearExpiry(dialogId)
    const attached: AttachedPluginDialog = { ...rec, dialogContentsId }
    this.attached.set(dialogId, attached)
    return attached
  }

  getAttached(dialogId: string): AttachedPluginDialog | null {
    return this.attached.get(dialogId) ?? null
  }

  /** 由弹窗 guest webContents id 反查（closeDialog 核对「只有目标 guest 可关」） */
  getByDialogContentsId(dialogContentsId: number): AttachedPluginDialog | null {
    for (const d of this.attached.values()) {
      if (d.dialogContentsId === dialogContentsId) return d
    }
    return null
  }

  /**
   * 弹窗完成：结果发回发起 guest（dialogResult），关闭弹窗 guest。
   * @returns 是否确实关闭了一个弹窗
   */
  closeWithResult(dialogId: string, result: unknown): boolean {
    const attached = this.attached.get(dialogId)
    if (!attached) return false
    this.attached.delete(dialogId)
    this.hooks.sendToGuest(attached.invokerContentsId, {
      type: 'dialogResult',
      dialogId,
      result
    })
    this.hooks.closeGuest(attached.dialogContentsId)
    return true
  }

  /** 弹窗取消（超时/销毁/注销/禁用/窗口关闭）：取消事件发发起 guest，关弹窗 guest */
  cancel(dialogId: string, reason: DialogCloseReason): boolean {
    if (this.attached.has(dialogId)) {
      return this.closeWithCancelled(dialogId, reason)
    }
    // staged：闸已过、did-attach 未到/未成功 —— 无 dialog guest id 可关（webview 可能
    // 尚未真正建出），只向发起 guest 推取消
    const staged = this.staged.get(dialogId)
    if (staged) {
      this.staged.delete(dialogId)
      this.clearExpiry(dialogId)
      this.hooks.sendToGuest(staged.invokerContentsId, {
        type: 'dialogCancelled',
        dialogId,
        reason
      })
      return true
    }
    const pending = this.pending.get(dialogId)
    if (pending) {
      this.pending.delete(dialogId)
      this.clearExpiry(dialogId)
      this.hooks.sendToGuest(pending.invokerContentsId, {
        type: 'dialogCancelled',
        dialogId,
        reason
      })
      return true
    }
    return false
  }

  private closeWithCancelled(dialogId: string, reason: DialogCloseReason): boolean {
    const attached = this.attached.get(dialogId)
    if (!attached) return false
    this.attached.delete(dialogId)
    // 发起 guest 是另一个 webview 里的页面，观察不到弹窗 webview 的 destroyed，
    // 任何取消路径（含弹窗页被 renderer 关闭/崩溃）都必须显式推送。closeWithResult
    // 的正常关闭不会走到这里 —— attached 记录在 closeGuest 之前已删除，destroyed
    // 事件触发的 cancelByDialogDestroyed 找不到记录，天然无重复推送。
    this.hooks.sendToGuest(attached.invokerContentsId, {
      type: 'dialogCancelled',
      dialogId,
      reason
    })
    this.hooks.closeGuest(attached.dialogContentsId)
    return true
  }

  /** 按谓词收集三个阶段（pending/staged/attached）命中的 dialogId */
  private idsMatching(match: (r: PendingPluginDialog) => boolean): string[] {
    return [
      ...[...this.pending.values()].filter(match).map((p) => p.dialogId),
      ...[...this.staged.values()].filter(match).map((p) => p.dialogId),
      ...[...this.attached.values()].filter(match).map((p) => p.dialogId)
    ]
  }

  /** 发起 guest 销毁：其发起的全部弹窗（挂载中 + 过闸中 + 已挂）取消并关闭 */
  cancelByInvokerDestroyed(invokerContentsId: number): string[] {
    const ids = this.idsMatching((p) => p.invokerContentsId === invokerContentsId)
    for (const id of ids) this.cancel(id, 'invoker-destroyed')
    return ids
  }

  /** 弹窗 guest 自身销毁（renderer 关了 webview / 崩溃）：通知发起 guest 取消 */
  cancelByDialogDestroyed(dialogContentsId: number): string[] {
    const ids = [...this.attached.values()].filter((a) => a.dialogContentsId === dialogContentsId).map((a) => a.dialogId)
    for (const id of ids) this.cancel(id, 'dialog-destroyed')
    return ids
  }

  // ---------- 到期定时器 ----------

  /** create 时的到期定时器：pending/staged 超时未消费/未 complete 即按 timeout
   *  取消并通知发起者 —— 挂载中断（用户提前关掉弹窗 UI、did-attach 永不到来）也有
   *  确定收口，不依赖「下一次 create 才惰性清扫」 */
  private armExpiry(dialogId: string): void {
    const t = setTimeout(() => {
      this.timers.delete(dialogId)
      if (this.pending.has(dialogId) || this.staged.has(dialogId)) {
        this.cancel(dialogId, 'timeout')
      }
    }, this.ttlMs)
    // 在途弹窗记录不拖住 main 事件循环退出
    t.unref?.()
    this.timers.set(dialogId, t)
  }

  /** 记录离开 pending/staged（已挂/已取消/已放弃）后撤掉到期定时器 */
  private clearExpiry(dialogId: string): void {
    const t = this.timers.get(dialogId)
    if (t !== undefined) {
      this.timers.delete(dialogId)
      clearTimeout(t)
    }
  }

  /**
   * 分发失败后的放弃（openDialog 回执错误等，view-actions 经 bridge 调用）：只移除
   * 未完成挂载（pending/staged）的记录，不关已挂弹窗、不向发起者推事件 —— 调用方
   * 已收到确定的 ok:false 且从未拿到 dialogId，再推 dialogCancelled 只是噪音；
   * 已挂弹窗可能是回执超时后仍在交互的真弹窗，其生命周期归关闭/取消路径。
   * @returns 是否确实移除了一条记录
   */
  dropUnattached(dialogId: string): boolean {
    this.clearExpiry(dialogId)
    if (this.staged.delete(dialogId)) return true
    return this.pending.delete(dialogId)
  }

  /**
   * guest webContents 销毁的统一清理（view-bridge destroyed 回调调用）。guest 在
   * 弹窗链路里有两个角色，都要清：
   *   - 作为目标（dialog guest）：通知其发起者取消（cancelByDialogDestroyed）；
   *   - 作为发起者（panel / dialog 均可 openDialog 嵌套弹窗）：取消其发起的全部弹窗。
   * 两角色按不同字段匹配、互不重叠 —— panel 传入时 dialog 侧天然空转，无需按 kind 分支。
   */
  cancelByGuestDestroyed(webContentsId: number): string[] {
    return [
      ...this.cancelByDialogDestroyed(webContentsId),
      ...this.cancelByInvokerDestroyed(webContentsId)
    ]
  }

  /** 注销视图/禁用插件：该插件全部弹窗取消并关闭（声明式视图不受影响） */
  cancelByPlugin(pluginId: string): string[] {
    const ids = this.idsMatching((p) => p.pluginId === pluginId)
    for (const id of ids) this.cancel(id, 'plugin-removed')
    return ids
  }

  /** 注销单个视图：只关打开该视图的弹窗 */
  cancelByView(pluginId: string, viewId: string): string[] {
    const ids = this.idsMatching((p) => p.pluginId === pluginId && p.viewId === viewId)
    for (const id of ids) this.cancel(id, 'view-unregistered')
    return ids
  }

  /** 主窗口关闭：该窗口的全部弹窗清理 */
  cancelByWindow(ownerWindowId: number): string[] {
    const ids = this.idsMatching((p) => p.ownerWindowId === ownerWindowId)
    for (const id of ids) this.cancel(id, 'window-closed')
    return ids
  }

  /** 到期清扫：pending/staged 超时取消；已挂弹窗不受 TTL 限制（用户交互中，由关闭路径管理）。
   *  正常超时由 armExpiry 定时器收口，这里是生成新弹窗时的兜底 */
  sweepExpired(): string[] {
    const now = Date.now()
    const ids = [
      ...[...this.pending.values()].filter((p) => p.expiresAt < now).map((p) => p.dialogId),
      ...[...this.staged.values()].filter((p) => p.expiresAt < now).map((p) => p.dialogId)
    ]
    for (const id of ids) this.cancel(id, 'timeout')
    return ids
  }

  /** 全部清空（app 退出）：连同到期定时器一并撤掉 */
  clearAll(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const id of [...this.pending.keys(), ...this.staged.keys(), ...this.attached.keys()]) {
      this.cancel(id, 'plugin-removed')
    }
  }
}
