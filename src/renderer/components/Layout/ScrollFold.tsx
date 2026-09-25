import React from 'react'
import cn from 'classnames'

/**
 * 垂卷 —— 组内容开合的卷轴容器(折叠栏=卷轴的辊,行=纸:开=纸自辊下垂落,
 * 合=自底向上卷回辊上)。动画在 globals.css 的 .scroll-fold 系列:外层 grid
 * 行轨 0fr↔1fr 让高度真实参与布局(下方内容被真实推下,不是伪裁剪),窗口
 * 下沿即纸的自由边,::after 卷曲随自由边走。辊身/轴头都在折叠栏
 * (scroll-head 的 rod-caps / .rolled)上,本组件不渲染卷轴本体。只负责挂态
 * 与折叠稳态的 inert —— 裁掉的行不进 Tab 序与无障碍树(对齐 MainWindow
 * 侧栏收起的做法;React 18 不识别 inert 布尔 prop,折叠时展开注入空串)。
 */
const ScrollFold: React.FC<{
  /** 展开(垂纸)态 */
  open: boolean
  children: React.ReactNode
}> = ({ open, children }) => (
  <div className={cn('scroll-fold', open && 'open')} {...(open ? {} : { inert: '' })}>
    <div className="scroll-fold-paper">{children}</div>
  </div>
)

/**
 * 蝴蝶结 —— 折叠栏收起态的系绳记号:满卷(纸卷绕上辊)时绳把卷拴住。竖绳
 * 满跨卷面绕卷一圈(结下续到卷底 —— 这根绳就是「拴住卷轴」的读形来源),
 * 结打在绳中段:两环左右张开成翼、结心微歪、双尾带 S 弯垂落。灵动模型
 * 「拴紧处不动,自由端才活」:绕卷的绳绷紧静止(物理上拴紧就是紧的),两环
 * 两尾是自由端,globals.css 里各自绕接结端以互质周期微摆、永不锁相 —— 读
 * 作风里的绸带,不读作钟摆;S 弯预埋在静止形里,微摆把它放大成波动。线条
 * 故意不规则:绳 S 形微歪、两环不等形、双尾不对称 —— 手工系的绳。基础槽位
 * 占 12×16,分组卷在 CSS 里放大一档,开合行首不跳。
 */
export const ScrollTie: React.FC<{ group?: boolean }> = ({ group = false }) => (
  <svg className="scroll-tie" width="12" height="16" viewBox="0 0 12 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {group ? <>
    {/* 绕轴的一圈绳:暗边压进卷面，亮脊提起绳的圆度。 */}
    <path d="M6 0.5C7.2 2.2 4.8 4.6 6 7.1C7 9.2 5.1 12.3 6.1 15.5" stroke="rgba(0,0,0,.28)" strokeWidth="2.7" />
    <path d="M6 0.5C7.2 2.2 4.8 4.6 6 7.1C7 9.2 5.1 12.3 6.1 15.5" strokeWidth="1.55" />
    <path d="M5.55 1.3C6.2 2.6 5.1 4.8 5.7 6.4" stroke="rgba(255,255,255,.42)" strokeWidth="0.5" />
    {/* 两只不等的绳环略带面，避免缩小时只剩相交的线。 */}
    <path className="scroll-tie-loop-l" d="M5.6 7.2C3.7 5.3 1.2 5.8 1.5 7.4C1.8 9.1 4.2 9.1 5.9 8.1C4.7 8.5 2.9 8.5 2.7 7.4C2.5 6.7 4.3 6.6 5.6 7.2Z" fill="currentColor" fillOpacity=".28" strokeWidth=".8" />
    <path className="scroll-tie-loop-r" d="M6.5 7.3C8.6 5.8 10.8 6.5 10.6 8.2C10.3 9.6 8 9.5 6.7 8.3C8 8.9 9.4 8.9 9.5 8.1C9.6 7.4 8 6.8 6.5 7.3Z" fill="currentColor" fillOpacity=".28" strokeWidth=".8" />
    {/* 两条尾端宽窄有别，向下垂出轴面。 */}
    <path className="scroll-tie-tail-l" d="M5.5 8.5C4.2 9.8 3.5 11 4.2 12.7C4.7 13.8 4.4 14.9 5 15.7L5.8 15.2C5.2 14.4 5.5 13.5 5 12.3C4.6 11.2 5.5 10 6.1 8.9Z" fill="currentColor" fillOpacity=".55" strokeWidth=".6" />
    <path className="scroll-tie-tail-r" d="M6.5 8.6C7.8 9.8 8.5 11.5 7.8 13.2C7.5 13.9 7.7 14.2 7 14.7L6.4 14.1C6.9 13.8 6.5 13.5 7 12.8C7.5 11.6 6.8 10.4 6 9Z" fill="currentColor" fillOpacity=".42" strokeWidth=".6" />
    {/* 结心最后压在环和尾上，交叠关系才像真的打结。 */}
    <rect x="5" y="6.8" width="2.1" height="2.3" rx="0.9" fill="currentColor" stroke="none" transform="rotate(-8 6 8)" />
    </> : <>
      <path d="M6 0.4C7.3 2 4.7 4.4 6 6.9C7 8.9 5.1 12 6.2 15.6" strokeWidth="1.7" />
      <path d="M5.3 1.6C6.1 3.1 4.9 4.9 5.5 6.5" strokeWidth="0.55" stroke="rgba(255,255,255,.35)" />
      <path className="scroll-tie-loop-l" d="M5.6 7C3.6 5.2 1.3 5.7 1.7 7.3C2.1 8.9 4.6 8.8 6 8" strokeWidth="1.3" />
      <path className="scroll-tie-loop-r" d="M6.5 7.3C8.6 5.9 10.7 6.5 10.4 8.1C10.1 9.5 7.8 9.1 6.7 8.4" strokeWidth="1.25" />
      <rect x="5.1" y="6.9" width="1.9" height="2.1" rx="0.85" fill="currentColor" stroke="none" transform="rotate(-7 6 8)" />
      <path className="scroll-tie-tail-l" d="M5.6 8.6C4.7 9.7 3.5 11 4.3 12.6C4.9 13.9 4.4 14.9 5.1 15.6" strokeWidth="1.15" />
      <path className="scroll-tie-tail-r" d="M6.5 8.7C7.7 9.9 8.5 11.5 7.8 13.2C7.3 14.4 7.7 15.2 7 15.5" strokeWidth="1.05" />
    </>}
  </svg>
)

export default ScrollFold
