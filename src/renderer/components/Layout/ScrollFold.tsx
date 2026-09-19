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
 * 故意不规则:绳 S 形微歪、两环不等形、双尾不对称 —— 手工系的绳。槽位恒
 * 占 12×16,开合行首不跳。
 */
export const ScrollTie: React.FC = () => (
  <svg className="scroll-tie" width="12" height="16" viewBox="0 0 12 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {/* 竖绳:满跨卷面绕卷一圈 —— 绷紧的拴绳(拴紧处,不参与摆动),比缆绳
        细一档读绸带;S 微歪是勒进卷面的张力,不是僵直线 */}
    <path d="M6 0.4C7.3 2 4.7 4.4 6 6.9C7 8.9 5.1 12 6.2 15.6" strokeWidth="1.7" />
    {/* 高光:绳身左缘细亮线,读出绳的受光 */}
    <path d="M5.3 1.6C6.1 3.1 4.9 4.9 5.5 6.5" strokeWidth="0.55" stroke="rgba(255,255,255,.35)" />
    {/* 左环 / 右环:结挽出的两个不等形翼(自由端),class 供 CSS 绕结端微摆 */}
    <path className="scroll-tie-loop-l" d="M5.6 7C3.6 5.2 1.3 5.7 1.7 7.3C2.1 8.9 4.6 8.8 6 8" strokeWidth="1.3" />
    <path className="scroll-tie-loop-r" d="M6.5 7.3C8.6 5.9 10.7 6.5 10.4 8.1C10.1 9.5 7.8 9.1 6.7 8.4" strokeWidth="1.25" />
    {/* 结心:绳与两环收拢的 pinch,微歪的实心小块(张力汇聚点,恒静止) */}
    <rect x="5.1" y="6.9" width="1.9" height="2.1" rx="0.85" fill="currentColor" stroke="none" transform="rotate(-7 6 8)" />
    {/* 双尾:结后垂落的自由端,S 弯预埋在形里(微摆时放大成波动),不等长 */}
    <path className="scroll-tie-tail-l" d="M5.6 8.6C4.7 9.7 3.5 11 4.3 12.6C4.9 13.9 4.4 14.9 5.1 15.6" strokeWidth="1.15" />
    <path className="scroll-tie-tail-r" d="M6.5 8.7C7.7 9.9 8.5 11.5 7.8 13.2C7.3 14.4 7.7 15.2 7 15.5" strokeWidth="1.05" />
  </svg>
)

export default ScrollFold
