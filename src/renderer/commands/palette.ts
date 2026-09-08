/**
 * 全局命令面板（REPL）打开事件 —— 深层组件与窗口 chrome 的解耦通道：
 * 请求方（页签条的「+」钮）派发 window CustomEvent，常驻挂载的 MainWindow
 * 监听后置 paletteOpen(true)，与 Ctrl+Shift+P 进同一块面板（打开而非切换）。
 *
 * 独立叶子模块（先例：navigate.ts 的 NAV_EVENT）：事件名是请求方与监听方
 * 共用的常量，若互相 import 组件会成环（页签条 → MainWindow），常量沉在
 * 叶子里双向引用。面板挂载在常驻的 MainWindow 上，不走 ui-store 的请求表
 * —— 那是为「消费者条件挂载会丢事件」的场景设计的。
 */
export const PALETTE_EVENT = 'lyshell:open-palette'

/** 派发「打开全局命令面板」事件 */
export function dispatchOpenPalette(): void {
  window.dispatchEvent(new CustomEvent(PALETTE_EVENT))
}
