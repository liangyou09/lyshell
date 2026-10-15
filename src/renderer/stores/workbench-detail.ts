/**
 * 共享工作台**详情面**的渲染侧状态机（S4）。
 *
 * 为什么单独一个模块：这一面有两个互不相邻的调用方 ——
 *   ① 主进程的详情面推送 / 低频兜底对账（挂在 MainWindow）；
 *   ② 无界面轮询 useWorkbenchSnapshot（挂在 PaneView 里的 dshWeb overlay，知道用户什么时候关掉了页签、相位何时变 free）。
 * 把「身份 / 在飞 / 已关闭 / 代际」这套记账放在这里，两边共用同一份，避免各记一半导致关闭后又被重开。
 *
 * 硬约束（对应 S4 验收）：
 *   - 同一身份重复下发 ⇒ 页签在就只刷新 payload，绝不重挂（重挂会 radio 激活，把用户拽回工作台）；
 *   - 用户**显式关掉**同身份页签 ⇒ 持久关闭：低频对账/补发推送都不再挂载，
 *     用户显式重新打开、新身份或新控制轮次才解除；
 *   - 同一身份的在飞请求**去重**（主进程会在返回前 force 广播，没有它就会递归重进）；
 *   - 旧 promise 落地前核对代际与目标：目标变了/释放了/用户关掉了 ⇒ 一律不落页签。
 */

/**
 * dsh Web 单例 overlay 的哨兵 id。
 * 这里刻意**不** import overlay-kinds —— 本模块被 overlay-kinds 的关闭副作用引用，
 * 反向 import 会成环（TDZ 期读常量会炸）。哨兵值由契约测试与 overlay-kinds 锁死一致。
 */
const DSH_WEB_OVERLAY_ID = '__dsh_web__'

/** 共享工作台页签的 payload（与 @shared/types 的 dshWeb 判别分支同形）。 */
export interface WorkbenchDetailPayload {
  kind: 'dshWeb'
  url: string
  name: string
  cwd?: string
  detail?: boolean
  readOnly?: boolean
  petSessionId?: string | null
  workbenchKey?: string | null
}

/** 主进程 `dsh:web:detail` 的回包（只取这里用到的字段）。 */
export interface WorkbenchDetailOpenResult {
  success?: boolean
  error?: string
  url?: string
  cwd?: string
  readOnly?: boolean
  petSessionId?: string | null
}

/** 渲染侧依赖面（生产由 pane-store + preload 满足；测试注入替身）。 */
export interface WorkbenchDetailDeps {
  /** 打开详情：主进程走 acquire 复用 + 冻结导航，返回同一后台的 URL 与只读态 */
  openDetail: (target: { sessionId?: string; name?: string }) => Promise<WorkbenchDetailOpenResult>
  /** 找现有 dshWeb 单例页签（用于「页签在就只刷新 payload」） */
  findTab: () => { id: string } | null
  activateTab?: (id: string) => void
  /**
   * 原位刷新 payload（**不动布局、不改激活态**）。
   * 含 `url`/`cwd`：后台换代（新端口）时现有 webview 必须跟着换地址，否则会一直指向旧实例；
   * url 不变时由 store 的同值短路保证不触发无谓重载。
   */
  patchTab: (
    id: string,
    patch: {
      url?: string
      cwd?: string
      readOnly?: boolean
      petSessionId?: string | null
      workbenchKey?: string | null
    }
  ) => void
  /** 挂载/复用页签（单例 id ⇒ 不会新增第二个；落点为当前活动 pane） */
  mountTab: (payload: WorkbenchDetailPayload) => void
}

export interface WorkbenchDetailTarget {
  key: string | null
  sessionId: string | null
  name?: string
  /** 用户显式打开；普通补发和轮询不得清除关闭记录。 */
  reopen?: boolean
}

export interface WorkbenchDetailController {
  /** 详情面推送 / 兜底对账的统一入口（幂等、去重、可作废）。 */
  ensure: (target: WorkbenchDetailTarget) => Promise<void>
  /** 无界面轮询回报的权威相位（held / releasing / free / acquiring）。 */
  notePhase: (phase: string | null) => void
  /** 无界面轮询回报的当前详情身份 key（页签关闭时用它记住「关的是哪个身份」）。 */
  noteKey: (key: string | null) => void
  /** 用户显式关闭了详情页签（只有 detail 页签才算）。 */
  noteClosed: (key: string | null) => void
  /** 独占结束：解除关闭记录 + 作废在飞落地。 */
  release: () => void
  /** 当前已应用的身份（诊断/测试）。 */
  appliedKey: () => string | null
  /** 该身份是否处于「用户已关闭」状态（诊断/测试）。 */
  isClosed: (key: string | null) => boolean
  /** 在飞请求数（诊断/测试）。 */
  inflightCount: () => number
}

/** Pet 绑定相位里「还在控制中」的取值；离开它们即新的一轮控制（关闭记录随之解除）。 */
const CONTROL_PHASES = new Set(['held', 'releasing', 'acquiring'])

export function createWorkbenchDetailController(
  deps: WorkbenchDetailDeps,
  fallbackName = 'DeepSeek Harness'
): WorkbenchDetailController {
  let applied: { key: string | null; sessionId: string | null } = { key: null, sessionId: null }
  /** 用户显式关闭过的身份；同身份不再自动重挂 */
  const closed = new Set<string>()
  /** 同一身份的在飞 promise（去重） */
  const inflight = new Map<string, Promise<void>>()
  /** 身份代际：新身份 / 释放 / 新控制轮次即 +1；旧 promise 见代际不符就不落地 */
  let generation = 0
  /** 上一次看到的控制相位（用于识别「新一轮控制」） */
  let phase: string | null = null
  /** 轮询最近回报的详情身份（页签关闭时用它记住关的是哪个身份） */
  let currentKey: string | null = null

  /** 页签在 ⇒ 只刷新 payload；返回是否已存在（存在即不需要挂载）。 */
  const refreshIfPresent = (patch: {
    url?: string
    cwd?: string
    readOnly?: boolean
    petSessionId?: string | null
    workbenchKey?: string | null
  }): boolean => {
    const existing = deps.findTab()
    if (!existing || existing.id !== DSH_WEB_OVERLAY_ID) return false
    deps.patchTab(existing.id, patch)
    return true
  }

  const open = (target: WorkbenchDetailTarget): Promise<void> => {
    const key = target.key
    // 同一身份已有在飞请求：复用它的 promise（绝不并发再开一次）
    const existing = key ? inflight.get(key) : undefined
    if (existing) return existing
    const startedAt = generation
    const name = target.name ?? fallbackName
    const run = async (): Promise<void> => {
      let res: WorkbenchDetailOpenResult
      try {
        res = await deps.openDetail({
          ...(target.sessionId ? { sessionId: target.sessionId } : {}),
          name
        })
      } catch (err) {
        console.warn('[workbench] detail open threw:', err)
        // 抛错等同于失败：同样不假标成功并恢复可用
        if (generation === startedAt && applied.key === key) applied = { key: null, sessionId: null }
        return
      }
      // 失败（无桥/无独占/导航被拒）如实记下：**不假标成功**，并显式恢复可用
      // （清掉乐观写入的 applied），让下一次真实变化/低频对账能再试一次。
      if (!res || res.success === false) {
        console.warn('[workbench] detail open failed:', res?.error)
        if (generation === startedAt && applied.key === key) applied = { key: null, sessionId: null }
        return
      }
      // 落地前核对：期间目标变了 / 控制释放了 / 新控制轮次 ⇒ 旧 promise 绝不落页签
      if (generation !== startedAt) return
      // 用户已显式关闭这个身份：尊重关闭，绝不把页签弹回来
      if (key && closed.has(key)) return
      // 页签已存在：原位刷新权威状态**与真实地址**（重挂会抢激活 = 把用户拽回工作台）
      if (
        refreshIfPresent({
          // 后台换代后端口会变：现有 webview 必须换到新实例，否则一直指向旧端口。
          // url 没变时 store 的同值短路会挡掉，不触发重载。
          url: String(res.url ?? ''),
          cwd: typeof res.cwd === 'string' ? res.cwd : undefined,
          readOnly: res.readOnly === true,
          petSessionId: res.petSessionId ?? target.sessionId,
          // 身份换代时页面内的 key 也要跟着换：用户之后关掉页签，记的必须是**当前**身份
          workbenchKey: key
        })
      ) {
        return
      }
      deps.mountTab({
        kind: 'dshWeb',
        url: String(res.url ?? ''),
        name,
        cwd: typeof res.cwd === 'string' ? res.cwd : undefined,
        detail: true,
        readOnly: res.readOnly === true,
        petSessionId: res.petSessionId ?? target.sessionId,
        // 页签自带身份：用户关掉它时，closeSideEffect 才知道关的是哪一个身份（据此保持关闭）
        workbenchKey: key
      })
    }
    const promise = run().finally(() => {
      if (key && inflight.get(key) === promise) inflight.delete(key)
    })
    if (key) inflight.set(key, promise)
    return promise
  }

  return {
    ensure: (target) => {
      if (target.reopen && target.key) {
        const tab = deps.findTab()
        if (closed.delete(target.key)) {
          // 关闭期间的旧请求作废；显式重开使用新一代并允许重新挂载。
          generation += 1
          inflight.delete(target.key)
          applied = { key: null, sessionId: null }
        } else if (!tab && !inflight.has(target.key)) {
          applied = { key: null, sessionId: null }
        }
        if (tab) deps.activateTab?.(tab.id)
      }
      // 同一身份已应用 ⇒ 最常见的重复（force 补发 / 10s 对账）：
      //   - 有在飞请求就把它的 promise 交回去（调用方 await 的必须是真落地，不是空转）；
      //   - 页签在就刷新 payload；
      //   - 页签不在（用户关过）就什么都不做 —— 关闭是持久决定。
      if (applied.key === target.key) {
        const running = target.key ? inflight.get(target.key) : undefined
        if (running) return running
        refreshIfPresent({ petSessionId: target.sessionId })
        return Promise.resolve()
      }
      // **新身份**：换一代（作废上一身份的在飞 promise）+ 清掉旧的关闭记录
      if (target.key) {
        generation += 1
        closed.clear()
      }
      applied = { key: target.key, sessionId: target.sessionId }
      // 新身份**必须**问一次主进程：`dsh:web:detail` 既拿复用后的 URL，也负责下发那次冻结的
      // 工作台导航。页签已存在时 open() 内部会改成原位刷新（不重挂），但这一趟不能省。
      return open(target)
    },
    notePhase: (next) => {
      const before = phase
      phase = next
      // 离开「控制中」相位 = 这一轮结束：解除关闭记录，下一轮同一身份可以重新打开
      if (before !== null && CONTROL_PHASES.has(before) && next !== null && !CONTROL_PHASES.has(next)) {
        generation += 1
        closed.clear()
      }
    },
    noteKey: (next) => {
      currentKey = next
    },
    noteClosed: (key) => {
      const target = key ?? currentKey
      if (!target) return
      closed.add(target)
    },
    release: () => {
      generation += 1
      closed.clear()
      inflight.clear()
      applied = { key: null, sessionId: null }
      currentKey = null
    },
    appliedKey: () => applied.key,
    isClosed: (key) => (key ? closed.has(key) : false),
    inflightCount: () => inflight.size
  }
}

// ===== 渲染层单例（MainWindow 注册；PaneView 里的无界面轮询按同一份记账上报） =====

let controller: WorkbenchDetailController | null = null

/** MainWindow 挂载时注册详情面状态机（重复注册以最后一次为准）。 */
export function setWorkbenchDetailController(next: WorkbenchDetailController | null): void {
  controller = next
}

/** 当前详情面状态机（未挂载时返回 null —— 轮询据此静默跳过上报）。 */
export function workbenchDetailLane(): WorkbenchDetailController | null {
  return controller
}
