/**
 * view-dialogs 单元测试 -- 一次性 dialogId 生命周期：签发、attach 闸单次消费、
 * 结果/取消推送、各清理路径（发起者销毁/弹窗销毁/插件清理/视图注销/窗口关闭/到期）。
 * 纯状态 + 注入 hooks（对齐 view-registry.test.ts 的无 electron 风格）。
 */
import { describe, it, expect } from 'vitest'
import { PluginDialogManager, MAX_DIALOGS_PER_PLUGIN, type DialogHostHooks, type AttachedPluginDialog } from './view-dialogs'

/** 记录型 hooks：sendToGuest / closeGuest 全量留痕供断言 */
function makeHooks(): DialogHostHooks & {
  sent: Array<{ to: number; payload: Record<string, unknown> }>
  closed: number[]
} {
  const sent: Array<{ to: number; payload: Record<string, unknown> }> = []
  const closed: number[] = []
  return {
    sent,
    closed,
    sendToGuest: (id, payload) => sent.push({ to: id, payload: payload as Record<string, unknown> }),
    closeGuest: (id) => closed.push(id)
  }
}

/** 标准创建参数：发起 guest=11（窗口 7），目标视图 p1/panel，入口 panel.html */
function createOpts(over: Partial<Parameters<PluginDialogManager['create']>[0]> = {}) {
  return {
    invokerContentsId: 11,
    pluginId: 'p1',
    viewId: 'panel',
    entryPath: 'panel.html',
    ownerWindowId: 7,
    ...over
  }
}

/** 走完 create → consume → completeAttach 全链（dialog guest = 99），返回 attached 记录 */
function attachDialog(mgr: PluginDialogManager, over: Partial<Parameters<PluginDialogManager['create']>[0]> = {}): AttachedPluginDialog {
  const rec = mgr.create(createOpts(over))
  const consumed = mgr.consumeForAttach(rec.dialogId, {
    pluginId: rec.pluginId,
    viewId: rec.viewId,
    entryPath: rec.entryPath,
    ownerWindowId: rec.ownerWindowId
  })
  expect(consumed).not.toBeNull()
  const attached = mgr.completeAttach(rec.dialogId, 99)
  expect(attached).not.toBeNull()
  return attached!
}

describe('签发与 attach 闸', () => {
  it('create 登记待挂载记录；两次签发 dialogId 不同', () => {
    const mgr = new PluginDialogManager(makeHooks())
    const a = mgr.create(createOpts())
    const b = mgr.create(createOpts())
    expect(a.dialogId).toBeTruthy()
    expect(b.dialogId).not.toBe(a.dialogId)
    expect(mgr.getPending(a.dialogId)?.viewId).toBe('panel')
    expect(mgr.getPending(b.dialogId)?.invokerContentsId).toBe(11)
  })

  it('consumeForAttach 逐项匹配后单次消费（第二个 webview 复用同一 id 被拒）', () => {
    const mgr = new PluginDialogManager(makeHooks())
    const rec = mgr.create(createOpts())
    const expectArg = { pluginId: 'p1', viewId: 'panel', entryPath: 'panel.html', ownerWindowId: 7 }
    expect(mgr.consumeForAttach(rec.dialogId, expectArg)).not.toBeNull()
    // 单次消费：pending 已移除，重放 attach 一律拒绝
    expect(mgr.getPending(rec.dialogId)).toBeNull()
    expect(mgr.consumeForAttach(rec.dialogId, expectArg)).toBeNull()
  })

  it('consumeForAttach 字段不匹配拒绝（且已被消费，不得重试挂载）', () => {
    const mgr = new PluginDialogManager(makeHooks())
    const rec = mgr.create(createOpts())
    const expectArg = { pluginId: 'p1', viewId: 'panel', entryPath: 'panel.html', ownerWindowId: 7 }
    expect(mgr.consumeForAttach(rec.dialogId, { ...expectArg, viewId: 'other' })).toBeNull()
    // 消费即移除：换回正确参数也不能再挂（attach 失败需重新发起）
    expect(mgr.consumeForAttach(rec.dialogId, expectArg)).toBeNull()
  })

  it('completeAttach 把 pending 转为 attached 并可按 dialog guest 反查', () => {
    const mgr = new PluginDialogManager(makeHooks())
    const rec = mgr.create(createOpts())
    mgr.consumeForAttach(rec.dialogId, {
      pluginId: 'p1', viewId: 'panel', entryPath: 'panel.html', ownerWindowId: 7
    })
    const attached = mgr.completeAttach(rec.dialogId, 99)
    expect(attached).toMatchObject({ dialogId: rec.dialogId, dialogContentsId: 99, invokerContentsId: 11 })
    expect(mgr.getAttached(rec.dialogId)?.dialogContentsId).toBe(99)
    expect(mgr.getByDialogContentsId(99)?.dialogId).toBe(rec.dialogId)
    // 未 complete 的 pending 不能经 complete 再挂（已被 consume）
    expect(mgr.completeAttach(rec.dialogId, 100)).toBeNull()
  })

  it('每插件在册弹窗（全阶段合计）达上限时 create 拒绝；其他插件与释放后的容量不受影响', () => {
    const hooks = makeHooks()
    const mgr = new PluginDialogManager(hooks)
    // 8 个容量横跨 pending / staged / attached 三阶段
    mgr.create(createOpts({ viewId: 'v-pending' })) // pending
    const staged = mgr.create(createOpts({ viewId: 'v-staged', entryPath: 'v-staged.html' }))
    expect(mgr.consumeForAttach(staged.dialogId, {
      pluginId: 'p1', viewId: 'v-staged', entryPath: 'v-staged.html', ownerWindowId: 7
    })).not.toBeNull()
    for (let i = 0; i < MAX_DIALOGS_PER_PLUGIN - 2; i++) {
      attachDialog(mgr, { viewId: `v-live${i}` })
    }
    expect(() => mgr.create(createOpts({ viewId: 'overflow' }))).toThrow(/too many open dialogs/)
    // 其他插件不受该插件容量挤占
    expect(mgr.create(createOpts({ pluginId: 'p2' })).pluginId).toBe('p2')
    // 清理释放容量后可再创建
    mgr.cancelByPlugin('p1')
    expect(mgr.create(createOpts({ viewId: 'again' })).viewId).toBe('again')
  })
})

describe('结果与取消推送', () => {
  it('closeWithResult 只把结果发回发起 guest 并关闭弹窗 guest', () => {
    const hooks = makeHooks()
    const mgr = new PluginDialogManager(hooks)
    const attached = attachDialog(mgr)
    expect(mgr.closeWithResult(attached.dialogId, { picked: 'a.txt' })).toBe(true)
    expect(hooks.sent).toHaveLength(1)
    expect(hooks.sent[0]).toMatchObject({ to: 11, payload: { type: 'dialogResult', dialogId: attached.dialogId, result: { picked: 'a.txt' } } })
    expect(hooks.closed).toEqual([99])
    expect(mgr.closeWithResult(attached.dialogId, {})).toBe(false) // 已删除，重复关闭无效
  })

  it('attached 弹窗取消（dialog-destroyed）：显式推送取消事件并关 guest（回归：发起方不能悬挂）', () => {
    const hooks = makeHooks()
    const mgr = new PluginDialogManager(hooks)
    const attached = attachDialog(mgr)
    expect(mgr.cancel(attached.dialogId, 'dialog-destroyed')).toBe(true)
    expect(hooks.sent).toHaveLength(1)
    expect(hooks.sent[0].payload).toMatchObject({ type: 'dialogCancelled', dialogId: attached.dialogId, reason: 'dialog-destroyed' })
    expect(hooks.closed).toEqual([99])
  })

  it('pending 弹窗取消（timeout）：只发取消事件，无 guest 可关', () => {
    const hooks = makeHooks()
    const mgr = new PluginDialogManager(hooks)
    const rec = mgr.create(createOpts())
    expect(mgr.cancel(rec.dialogId, 'timeout')).toBe(true)
    expect(hooks.sent).toHaveLength(1)
    expect(hooks.sent[0].payload).toMatchObject({ type: 'dialogCancelled', dialogId: rec.dialogId, reason: 'timeout' })
    expect(hooks.closed).toEqual([])
  })

  it('closeWithResult 后 destroyed 事件不再触发重复推送（attached 记录已删）', () => {
    const hooks = makeHooks()
    const mgr = new PluginDialogManager(hooks)
    const attached = attachDialog(mgr)
    mgr.closeWithResult(attached.dialogId, 'done')
    expect(mgr.cancelByDialogDestroyed(99)).toEqual([])
    expect(hooks.sent.filter((s) => s.payload.type === 'dialogResult')).toHaveLength(1)
    expect(hooks.sent.filter((s) => s.payload.type === 'dialogCancelled')).toHaveLength(0)
  })
})

describe('批量清理路径', () => {
  it('cancelByInvokerDestroyed 清该发起者的 pending + attached，不动其他发起者', () => {
    const hooks = makeHooks()
    const mgr = new PluginDialogManager(hooks)
    attachDialog(mgr) // 发起者 11 的 attached
    attachDialog(mgr, { invokerContentsId: 22 }) // 发起者 22 的 attached
    mgr.create(createOpts({ invokerContentsId: 11 })) // 发起者 11 的 pending
    const ids = mgr.cancelByInvokerDestroyed(11)
    expect(ids).toHaveLength(2)
    expect(hooks.sent.every((s) => s.to === 11 || s.to === 22)).toBe(true)
    const cancel22 = hooks.sent.filter((s) => s.to === 22)
    expect(cancel22).toHaveLength(0) // 22 的弹窗不受影响
    // 22 的 attached 仍存活
    expect(mgr.getByDialogContentsId(99)).not.toBeNull()
  })

  it('cancelByGuestDestroyed 弹窗 guest 双角色：外层通知发起者，嵌套按发起者清', () => {
    const hooks = makeHooks()
    const mgr = new PluginDialogManager(hooks)
    const outer = attachDialog(mgr) // 发起者 11 → 弹窗 guest 99
    // 弹窗 guest 99 发起嵌套弹窗（目标 guest 挂在 100）
    const nested = mgr.create(createOpts({ invokerContentsId: 99, viewId: 'picker', entryPath: 'picker.html' }))
    expect(mgr.consumeForAttach(nested.dialogId, {
      pluginId: 'p1', viewId: 'picker', entryPath: 'picker.html', ownerWindowId: 7
    })).not.toBeNull()
    expect(mgr.completeAttach(nested.dialogId, 100)).not.toBeNull()
    const ids = mgr.cancelByGuestDestroyed(99)
    expect(ids).toEqual([outer.dialogId, nested.dialogId])
    // 外层取消事件回发起者 11；嵌套取消事件回已销毁的 99（发送侧对销毁 wc 幂等无害）
    expect(hooks.sent).toEqual([
      expect.objectContaining({ to: 11, payload: expect.objectContaining({ type: 'dialogCancelled', dialogId: outer.dialogId }) }),
      expect.objectContaining({ to: 99, payload: expect.objectContaining({ type: 'dialogCancelled', dialogId: nested.dialogId }) })
    ])
    expect(hooks.closed).toEqual([99, 100])
  })

  it('cancelByGuestDestroyed panel guest：只有发起者角色（dialog 侧空转）', () => {
    const hooks = makeHooks()
    const mgr = new PluginDialogManager(hooks)
    const rec = mgr.create(createOpts()) // pending，发起者 11（panel）
    expect(mgr.cancelByGuestDestroyed(11)).toEqual([rec.dialogId])
    expect(hooks.sent).toHaveLength(1)
    expect(hooks.sent[0]).toMatchObject({ to: 11, payload: { type: 'dialogCancelled', reason: 'invoker-destroyed' } })
    expect(hooks.closed).toEqual([])
  })

  it('cancelByPlugin / cancelByView / cancelByWindow 按各自维度清理', () => {
    const hooks = makeHooks()
    const mgr = new PluginDialogManager(hooks)
    attachDialog(mgr) // p1/panel, window 7
    attachDialog(mgr, { viewId: 'picker' }) // p1/picker
    attachDialog(mgr, { pluginId: 'p2', entryPath: 'other.html' }) // p2
    expect(mgr.cancelByView('p1', 'picker')).toHaveLength(1)
    expect(mgr.getByDialogContentsId(99)).not.toBeNull() // panel 仍挂
    expect(mgr.cancelByPlugin('p2')).toHaveLength(1)
    expect(mgr.cancelByWindow(7)).toHaveLength(1)
    expect(mgr.getByDialogContentsId(99)).toBeNull()
    expect(hooks.closed.filter((c) => c === 99)).toHaveLength(3) // 三条路径各关一次
  })

  it('到期定时器：pending 超时自动取消并通知发起者；attached 不受 TTL 限制', async () => {
    const hooks = makeHooks()
    const mgr = new PluginDialogManager(hooks, 15)
    const rec = mgr.create(createOpts())
    attachDialog(mgr, { viewId: 'picker' }) // completeAttach 即撤定时器
    await new Promise((r) => setTimeout(r, 40))
    expect(mgr.getPending(rec.dialogId)).toBeNull()
    expect(hooks.sent.filter((s) => s.payload.type === 'dialogCancelled' && s.payload.dialogId === rec.dialogId)).toHaveLength(1)
    expect(mgr.getByDialogContentsId(99)).not.toBeNull() // 已挂弹窗仍在交互中
    expect(hooks.closed).toEqual([])
    expect(mgr.sweepExpired()).toEqual([]) // 定时器已收口，惰性兜底无残留
  })

  it('clearAll 清空 pending 与 attached', () => {
    const hooks = makeHooks()
    const mgr = new PluginDialogManager(hooks)
    attachDialog(mgr)
    mgr.create(createOpts({ viewId: 'picker' }))
    mgr.clearAll()
    expect(mgr.getByDialogContentsId(99)).toBeNull()
    mgr.sweepExpired()
    expect(hooks.sent.filter((s) => s.payload.type === 'dialogCancelled')).toHaveLength(2)
  })
})

describe('到期定时器细节与 dropUnattached', () => {
  it('过闸未 complete（挂载中断）同样按期取消并通知', async () => {
    const hooks = makeHooks()
    const mgr = new PluginDialogManager(hooks, 15)
    const rec = mgr.create(createOpts())
    expect(mgr.consumeForAttach(rec.dialogId, {
      pluginId: 'p1', viewId: 'panel', entryPath: 'panel.html', ownerWindowId: 7
    })).not.toBeNull()
    await new Promise((r) => setTimeout(r, 40))
    expect(mgr.completeAttach(rec.dialogId, 99)).toBeNull() // 记录已被定时器取消
    expect(hooks.sent).toHaveLength(1)
    expect(hooks.sent[0].payload).toMatchObject({ type: 'dialogCancelled', dialogId: rec.dialogId, reason: 'timeout' })
    expect(hooks.closed).toEqual([])
  })

  it('取消路径撤掉到期定时器：不产生迟到的第二份 dialogCancelled', async () => {
    const hooks = makeHooks()
    const mgr = new PluginDialogManager(hooks, 15)
    const rec = mgr.create(createOpts())
    expect(mgr.cancelByInvokerDestroyed(11)).toEqual([rec.dialogId])
    await new Promise((r) => setTimeout(r, 40))
    expect(hooks.sent.filter((s) => s.payload.type === 'dialogCancelled')).toHaveLength(1)
  })

  it('dropUnattached 只清未挂载记录、不推送事件；已挂弹窗与定时器一并善后', async () => {
    const hooks = makeHooks()
    const mgr = new PluginDialogManager(hooks, 15)
    const pendingRec = mgr.create(createOpts())
    const stagedRec = mgr.create(createOpts({ viewId: 'picker', entryPath: 'picker.html' }))
    expect(mgr.consumeForAttach(stagedRec.dialogId, {
      pluginId: 'p1', viewId: 'picker', entryPath: 'picker.html', ownerWindowId: 7
    })).not.toBeNull()
    const attached = attachDialog(mgr, { viewId: 'other', entryPath: 'other.html' })
    expect(mgr.dropUnattached(pendingRec.dialogId)).toBe(true)
    expect(mgr.dropUnattached(stagedRec.dialogId)).toBe(true)
    expect(mgr.dropUnattached(pendingRec.dialogId)).toBe(false) // 幂等
    expect(mgr.dropUnattached(attached.dialogId)).toBe(false) // 已挂弹窗不动
    expect(mgr.getAttached(attached.dialogId)).not.toBeNull()
    expect(hooks.sent.filter((s) => s.payload.type === 'dialogCancelled')).toHaveLength(0)
    expect(hooks.closed).toEqual([])
    // 到期定时器已随放弃撤掉：等过期也不产生迟到事件
    await new Promise((r) => setTimeout(r, 40))
    expect(hooks.sent.filter((s) => s.payload.type === 'dialogCancelled')).toHaveLength(0)
  })
})
