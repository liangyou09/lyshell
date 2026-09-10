import { useEffect } from 'react'
import { useRef } from 'react'
import type { MutableRefObject, RefObject } from 'react'

// ========== ESC 回退栈 ==========
// 模块级：所有可 ESC 收起的层（浮层 / 终端搜索条 / 对话框 / 命令面板）同开时只有
// 栈顶消费按键，逐层回退（后开的先收，与视觉层级一致）。每层在挂监听时压栈、
// 卸监听时弹栈。
// 栈籍 effect 的 deps 只有 open —— close/refs 每次渲染都是新引用，若跟着重挂会把
// 本层弹了再压到栈顶，层序被重排（下层组件的任意重渲染都会篡位），必须与监听
// effect 拆开、token 存 ref 跨重渲染保序。
// 想参与回退顺序的层必须走这套 hook 而不是自留 ESC 监听（window 冒泡 / 元素
// onKeyDown）：栈顶成员在 document 捕获层截停后，自留的监听收不到按键 ——
// 各听各的就退化成「视觉在上层的要多按一下 ESC」。

const dismissStack: symbol[] = []

function pushDismissToken(): symbol {
  const token = Symbol()
  dismissStack.push(token)
  return token
}

function popDismissToken(token: symbol): void {
  const i = dismissStack.indexOf(token)
  if (i >= 0) dismissStack.splice(i, 1)
}

function isTopmostDismiss(token: symbol): boolean {
  return dismissStack[dismissStack.length - 1] === token
}

/** 栈籍登记（两个公开 hook 共用）：open 时压栈、关闭时弹栈，token 存 ref 供监听查栈顶 */
function useDismissToken(open: boolean): MutableRefObject<symbol | null> {
  const tokenRef = useRef<symbol | null>(null)
  useEffect(() => {
    if (!open) return
    const token = pushDismissToken()
    tokenRef.current = token
    return () => {
      popDismissToken(token)
      tokenRef.current = null
    }
  }, [open])
  return tokenRef
}

/** ESC 捕获处理器工厂 —— 两个公开 hook 共用的一份语义（栈顶裁决 + 截停不穿透） */
function escStackHandler(
  tokenRef: MutableRefObject<symbol | null>,
  close: () => void
): (ev: KeyboardEvent) => void {
  return (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return
    // IME 组合中的 ESC 是取消候选词（组合期按键带 isComposing / keyCode 229），
    // 不当收层键 —— 面板/对话框里输中文按 ESC 收候选时不应把整个层收掉
    if (ev.isComposing || ev.keyCode === 229) return
    const token = tokenRef.current
    // 非栈顶（上方还有别的层）不消费也不截停，让栈顶自己的监听去收
    if (token === null || !isTopmostDismiss(token)) return
    ev.stopPropagation()
    close()
  }
}

/**
 * 浮层收起（外部点击 / ESC）—— 编码选择菜单、图标选择器、日期选择器共用的收起逻辑。
 *
 * ESC 在 document 捕获阶段拦截并 stopPropagation：浮层开着时 ESC 的语义是「收浮层」，
 * 不该再穿透给底下真正的目标 —— xterm 的 textarea 在事件冒泡到它之前就把裸 \x1b 发给了
 * 远端（状态栏菜单盖在终端上方时按 ESC，菜单关了、远端也收到一个 ESC 键），必须抢在
 * 目标处理前截停。多个层同开时由回退栈裁决：只有栈顶消费，其余层不动作也不截停。
 *
 * refs 内的 mousedown 不算外部点击 —— 传浮层本体 + 触发按钮（按钮自己走 toggle 开合）。
 */
export function useDismiss(
  open: boolean,
  close: () => void,
  refs: ReadonlyArray<RefObject<HTMLElement | null>>
): void {
  const tokenRef = useDismissToken(open)
  useEffect(() => {
    if (!open) return
    const onDown = (ev: MouseEvent) => {
      const target = ev.target as Node | null
      if (target && refs.some(ref => ref.current?.contains(target))) return
      close()
    }
    const onKey = escStackHandler(tokenRef, close)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
    // close/refs 每次渲染都是新引用，open 期间重挂监听无害 —— 换取监听器永远拿到最新闭包，
    // 免掉 latest-ref 转发样板；tokenRef 来自 useRef、引用恒稳定，进 deps 不触发重挂
  }, [open, close, refs, tokenRef])
}

/**
 * 无「外部点击收起」语义的层（终端搜索条 / 对话框 / 命令面板）加入同一个 ESC 回退栈：
 * ESC 同样在 document 捕获层按栈顶消费、逐层回退、不穿透给 xterm。与 useDismiss 的
 * 差别仅是没有 mousedown 外点收起 —— 收起语义由自身交互决定，这里只统一 ESC 的
 * 层级顺序与截停。
 */
export function useEscDismiss(open: boolean, close: () => void): void {
  const tokenRef = useDismissToken(open)
  useEffect(() => {
    if (!open) return
    const onKey = escStackHandler(tokenRef, close)
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
    // tokenRef 来自 useRef、引用恒稳定，进 deps 不触发重挂
  }, [open, close, tokenRef])
}
