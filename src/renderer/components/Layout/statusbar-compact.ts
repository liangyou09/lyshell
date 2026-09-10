/**
 * 状态栏读数窄宽降级的阈值裁决(纯函数,无 React 依赖)。
 *
 * 侧栏宽 180-400 可拖而读数是恒定文案:按价值分级整段退场 ——
 *   <300px 隐藏「行数」(读数家族里价值最低的一段,见 TerminalSize hideLines)
 *   <260px 整段隐藏 TerminalSize(尺寸+行数),协议码与编码读数守住到底
 * 进入/退出阈值各留 6px 迟滞,防边界抖动时读数闪现。
 *
 * 抽成纯函数的原因:jsdom 无布局(clientWidth 恒 0)且无 ResizeObserver 实现,
 * 组件级测试只能测到自己的 mock;阈值真值表在此直测,SessionsPanel 的 effect
 * 只剩「订阅 observer → setState」的接线,阈值数值改动不需要开 Electron 验证。
 */
export interface StatusbarCompactState {
  /** 第一档:<300px 隐藏行数读数 */
  hideLines: boolean
  /** 第二档:<260px 整段隐藏尺寸读数 */
  hideSize: boolean
}

/** 隐藏行数阈值(进入 300 / 退出 306,迟滞 6px) */
const LINES_HIDE_AT = 300
/** 整段隐藏尺寸阈值(进入 260 / 退出 266,迟滞 6px) */
const SIZE_HIDE_AT = 260
/** 迟滞宽度:已隐藏态需宽回 阈值+6 才恢复 */
const HYSTERESIS = 6

/**
 * 按当前侧栏宽度与上一状态裁决降级档位。
 * 状态机的「上一状态」决定走进入阈值还是退出阈值 —— 调用方持有状态并在
 * observer 回调里把返回值回写。
 */
export function evaluateStatusbarCompact(
  width: number,
  prev: StatusbarCompactState
): StatusbarCompactState {
  return {
    hideLines: prev.hideLines ? width < LINES_HIDE_AT + HYSTERESIS : width < LINES_HIDE_AT,
    hideSize: prev.hideSize ? width < SIZE_HIDE_AT + HYSTERESIS : width < SIZE_HIDE_AT
  }
}
