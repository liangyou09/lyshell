import React, { useRef } from 'react'
import cn from 'classnames'

export interface PanelTabItem<T extends string> {
  key: T
  label: React.ReactNode
}

/**
 * 面板页签 —— 嵌进面板首行(铭牌头行/标题条)右端的页签语汇:
 * font-mono 12px semibold,激活态文字转 amber 并以 2px amber 底边线咬住所在行的发丝线。
 * 挂在首行时,这条 amber 线与窗口顶排终端页签(PaneTabBar)的激活下边线同处
 * 第一行横带,整窗读作一条贯穿的横线。
 * 容器必须满高(h-full):所在行给出高度,按钮随之满高,下划线才能落在行的底边上。
 *
 * 键盘语义:tablist + tab + roving tabindex(Tab 进组、左右箭头在组内走、Home/End 跳两端,
 * 移动即激活),与 ActivityRail 的竖版页签笼同一套机柜语汇。宿主面板的内容区未标
 * role=tabpanel,故不挂 aria-controls —— 语义止步于页签本身,不虚构不存在的关联。
 */
const PanelTabs = <T extends string>({
  tabs,
  active,
  onChange
}: {
  tabs: ReadonlyArray<PanelTabItem<T>>
  active: T
  onChange: (key: T) => void
}): JSX.Element => {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const activeIndex = tabs.findIndex(tab => tab.key === active)

  /** 箭头/Home/End 移动即激活:focus 跟着新激活页签走,保持 roving tabindex 单焦点 */
  const activateAt = (index: number): void => {
    const next = ((index % tabs.length) + tabs.length) % tabs.length
    const tab = tabs[next]
    if (tab && tab.key !== active) onChange(tab.key)
    buttonRefs.current[next]?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault()
        activateAt(activeIndex - 1)
        break
      case 'ArrowRight':
        e.preventDefault()
        activateAt(activeIndex + 1)
        break
      case 'Home':
        e.preventDefault()
        activateAt(0)
        break
      case 'End':
        e.preventDefault()
        activateAt(tabs.length - 1)
        break
      default:
        break
    }
  }

  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      className="flex h-full flex-shrink-0"
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.key === active
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            ref={el => { buttonRefs.current[index] = el }}
            onClick={() => onChange(tab.key)}
            aria-selected={isActive}
            tabIndex={isActive || (activeIndex === -1 && index === 0) ? 0 : -1}
            className={cn(
              'relative h-full px-2.5 flex items-center justify-center leading-none text-[12px] font-mono font-semibold transition-colors cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--amber)]',
              isActive
                ? 'text-[var(--amber)]'
                : 'text-[var(--text-rack-mute)] hover:text-[var(--text-rack)]'
            )}
          >
            {tab.label}
            {/* amber 底边线 —— bottom-[-1px] 压住所在行的 border-b,让选中页签"咬合"进下方主体 */}
            {isActive && <span aria-hidden className="absolute inset-x-0 bottom-[-1px] h-[2px] bg-[var(--amber)]" />}
          </button>
        )
      })}
    </div>
  )
}

export default PanelTabs
