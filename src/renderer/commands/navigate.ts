import type { NavTab } from '../components/Layout/ActivityRail'

/**
 * 左栏页签切换事件 —— 命令注册表（/sessions 等导航命令）与文档动作链接
 * （/ls 清点文档的「新建」入口）共用的解耦通道：请求方派发 window CustomEvent，
 * MainWindow 监听后调 handleNavChange。
 *
 * 独立成叶子模块（不 import command-registry）：readDoc → inventory →
 * doc-actions 的引用链要派发导航，若引到注册表会成环（注册表 → readDoc）。
 */

/** 事件名;detail 为目标 NavTab */
export const NAV_EVENT = 'lyshell:navigate'

/** 派发页签切换事件 */
export function dispatchNavigate(tab: NavTab): void {
  window.dispatchEvent(new CustomEvent<NavTab>(NAV_EVENT, { detail: tab }))
}
