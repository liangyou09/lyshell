import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import type { QuickCommand, QuickCommandGroup } from '@shared/types'
import { useQuickCommandsStore } from '../../stores/quick-commands-store'
import { useEscDismiss } from '../../hooks'
import ScrollFold, { ScrollTie } from '../Layout/ScrollFold'

interface QuickCommandsPanelProps {
  /** 快捷命令派发（由 MainWindow 提供,拆行/转义规则统一在 dispatchCommand；可选以容错无宿主场景） */
  onExecuteCommand?: (cmd: QuickCommand) => void
  /** dsh web 接管活动分屏时置灰：命令会发进被 webview 挡住的终端，必须禁发 */
  disabled?: boolean
}

/** 折叠态持久化 key（对齐 protoFilter 的 localStorage 做法） */
const COLLAPSED_KEY = 'lyshell.quickCmdCollapsed.v1'

// 预定义分组颜色（1 默认 + 4 用户槽位共用色板）
const PREDEFINED_COLORS = ['#0078D4', '#E81123', '#107C10', '#FFB900', '#FF69B4']

/**
 * 快捷命令侧栏模块 —— 栏底常驻动作位（文件管理器之下、状态栏之上；更早驻留
 * 过 StatusBar.tsx 底部状态栏，后迁入会话栏搜索框下方，现回迁栏底）。
 *
 * 结构：标题行（折叠 caret + 分组 LED 色点 + ＋）+ 印匣 wrap 区（每键一方钤章
 * .seal,器形机械在 globals.css）。可折叠（点标题行切换，localStorage 持久化；
 * 键盘 Enter/Space 同效）：折叠只剩标题行；展开态高度随印章自然换行增减,
 * 但封顶 5 行、超出内滚 —— 不再把上方会话列表挤干。
 * 数据来自 quick-commands-store（Ctrl+F1-F12 直发监听在 MainWindow 常驻，
 * 依赖同一 store，侧栏收起/切页签时快捷键不受影响）。
 */
const QuickCommandsPanel: React.FC<QuickCommandsPanelProps> = ({ onExecuteCommand, disabled }) => {
  // 细粒度选择器：印匣区 DOM 较多,避免无关字段变化(如别的分组被编辑)触发整面板重渲
  const commands = useQuickCommandsStore(s => s.commands)
  const groups = useQuickCommandsStore(s => s.groups)
  const defaultGroupColor = useQuickCommandsStore(s => s.defaultGroupColor)
  const selectedGroupId = useQuickCommandsStore(s => s.selectedGroupId)
  const loadAll = useQuickCommandsStore(s => s.loadAll)
  const setSelectedGroupId = useQuickCommandsStore(s => s.setSelectedGroupId)
  const { t } = useTranslation()

  // 折叠态：点标题行切换（toggleCollapsed 负责写 localStorage）
  const [collapsed, setCollapsed] = useState(false)

  // 钤印一拍(按下键 700ms 整章下压敷印泥)—— 与 LAUNCH 执笔拍同构的
  // 器物动作签名:笔起新纸上提,章落旧纸下压。timer 挂 ref 供连点重置与
  // 卸载清理(面板随页签切换卸载,残拍不泄漏)
  const [sealFlash, setSealFlash] = useState<string | null>(null)
  const sealFlashTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (sealFlashTimerRef.current !== null) window.clearTimeout(sealFlashTimerRef.current)
  }, [])

  const [showAddDialog, setShowAddDialog] = useState(false)
  const [showBatchGroupDialog, setShowBatchGroupDialog] = useState(false)  // 批量编辑分组对话框
  const [batchGroups, setBatchGroups] = useState<{id: string, name: string, color: string}[]>([])  // 批量编辑的分组数据
  const [editCommand, setEditCommand] = useState<QuickCommand | undefined>(undefined)
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newGroupId, setNewGroupId] = useState<string>('')
  const [newEscape, setNewEscape] = useState(false)
  const [nameError, setNameError] = useState(false)  // 名称为空时提示必填
  const [contentError, setContentError] = useState(false)  // 命令为空时提示必填
  const [editingCommandId, setEditingCommandId] = useState<string | null>(null)
  const [groupDialogOffset, setGroupDialogOffset] = useState({ x: 0, y: 0 })
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  // 恢复折叠态（挂载时读 localStorage;对齐 protoFilter 的持久化做法）
  useEffect(() => {
    try {
      if (localStorage.getItem(COLLAPSED_KEY) === '1') setCollapsed(true)
    } catch { /* localStorage 不可用,回退展开 */ }
  }, [])

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0') } catch { /* quota */ }
      return next
    })
  }

  // 重置对话框状态 —— 只调稳定 setter,useCallback 空依赖使其引用稳定,
  // ESC 监听据此显式声明依赖(不再依赖"事件触发时变量恰好已初始化"的巧合闭包)
  const resetDialogState = useCallback(() => {
    setEditCommand(undefined)
    setNewName('')
    setNewContent('')
    setNewGroupId('')
    setNewEscape(false)
    setNameError(false)
    setContentError(false)
  }, [])

  // ESC键关闭对话框 —— 入 ESC 回退栈(与浮层/终端搜索条统一层级顺序:栈顶优先、
  // 逐层回退),门控在「有对话框开着」:原先 window 监听常驻,没开对话框时 ESC
  // 也会跑一遍全是 no-op 的重置;不自留监听也避免栈顶成员截停后本层收不到
  useEscDismiss(
    showAddDialog || showBatchGroupDialog || editingCommandId !== null,
    () => {
      setShowAddDialog(false)
      setShowBatchGroupDialog(false)
      setEditingCommandId(null)
      resetDialogState()
    }
  )

  // 默认分组（始终存在，不可删除，名称固定，颜色持久化到偏好设置）
  const DEFAULT_GROUP: QuickCommandGroup = {
    id: 'default',
    name: 'Default',
    order: 0,
    color: defaultGroupColor || undefined
  }

  // 合并默认分组和用户分组（过滤掉名称为空的分组）
  const allGroups = [DEFAULT_GROUP, ...groups.filter(g => g.name && g.name.trim().length > 0)]

  // 新建命令（＋ 按钮 / 空态入口；沿袭原轨道双击语义）
  const handleAddNew = () => {
    setEditCommand(undefined)
    setEditingCommandId(null)
    setNewName('')
    setNewContent('')
    setNewEscape(false)
    setNameError(false)
    setContentError(false)
    // 自动填入当前选中的分组（默认分组则不填 groupId）
    setNewGroupId(selectedGroupId === 'default' ? '' : selectedGroupId)
    setShowAddDialog(true)
  }

  // 单击执行命令 —— 整条交给宿主派发（dispatchCommand 统一拆行/转义/结尾符），
  // 随手钤印一拍：命令已落纸(写进活动终端)，章面敷泥是这场落笔的视觉签名
  const handleExecute = (cmd: QuickCommand) => {
    if (disabled || !onExecuteCommand) return
    onExecuteCommand(cmd)
    setSealFlash(cmd.id)
    if (sealFlashTimerRef.current !== null) window.clearTimeout(sealFlashTimerRef.current)
    sealFlashTimerRef.current = window.setTimeout(() => setSealFlash(null), 700)
  }

  // 右键编辑命令
  const handleCommandContextMenu = (cmd: QuickCommand, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setEditCommand(cmd)
    setEditingCommandId(cmd.id)
    setNewName(cmd.name)
    setNewContent(cmd.content)
    setNewGroupId(cmd.groupId || '')
    setNewEscape(cmd.escapeSequences ?? false)
    setNameError(false)
    setContentError(false)
    setShowAddDialog(true)
  }

  // 保存命令
  const handleSaveCommand = async () => {
    // 名称与命令均为必填项：为空时各自高亮并提示，不再静默返回
    const nameEmpty = !newName.trim()
    const contentEmpty = !newContent.trim()
    setNameError(nameEmpty)
    setContentError(contentEmpty)
    if (nameEmpty || contentEmpty) return

    // 检查分组命令数量限制（最多12个）
    const targetGroupId = newGroupId || undefined
    const groupCommands = commands.filter(c => c.groupId === targetGroupId)

    // 编辑模式时不检查数量（因为只是修改，不增加）
    if (!editCommand && groupCommands.length >= 12) {
      const groupName = targetGroupId
        ? groups.find(g => g.id === targetGroupId)?.name || 'this group'
        : 'Default'
      alert(t('statusbar.commandLimit', { name: groupName }))
      return
    }

    const command: QuickCommand = {
      id: editCommand?.id || Date.now().toString(),
      name: newName.trim(),
      content: newContent,
      groupId: targetGroupId,
      escapeSequences: newEscape,
      order: editCommand?.order ?? groupCommands.length  // 设置顺序
    }

    if (editCommand) {
      await window.electronAPI?.commandUpdate(command)
    } else {
      await window.electronAPI?.commandAdd(command)
    }

    await loadAll()
    setShowAddDialog(false)
    setEditingCommandId(null)
    resetDialogState()
  }

  // 删除命令
  const handleDeleteCommand = async () => {
    if (editCommand) {
      await window.electronAPI?.commandDelete(editCommand.id)
      await loadAll()
      setShowAddDialog(false)
      setEditingCommandId(null)
      resetDialogState()
    }
  }

  // 拖动分组编辑窗口
  const handleGroupDialogMouseDown = (e: React.MouseEvent) => {
    const startX = e.clientX
    const startY = e.clientY
    const startOffsetX = groupDialogOffset.x
    const startOffsetY = groupDialogOffset.y

    const handleMouseMove = (e: MouseEvent) => {
      setGroupDialogOffset({
        x: startOffsetX + e.clientX - startX,
        y: startOffsetY + e.clientY - startY
      })
    }

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }

  // 打开批量编辑分组对话框
  const handleOpenGroupDialog = () => {
    // 固定 1 个默认分组 + 4 个用户分组槽位
    const editGroups: {id: string, name: string, color: string}[] = [
      { id: 'default', name: 'Default', color: defaultGroupColor },
      ...groups.map(g => ({ id: g.id, name: g.name, color: g.color || '' }))
    ]
    // 补齐到 5 个槽位（1 默认 + 4 用户）
    while (editGroups.length < 5) {
      editGroups.push({ id: '', name: '', color: '' })
    }
    setBatchGroups(editGroups.slice(0, 5))
    setDraggedIndex(null)
    setDragOverIndex(null)
    setGroupDialogOffset({ x: 0, y: 0 })
    setShowBatchGroupDialog(true)
  }

  // 批量保存分组：固定 1+4 槽位，空名称视为无效分组
  const handleSaveBatchGroups = async () => {
    // 持久化默认分组颜色（名称固定，存到偏好设置）
    const newDefaultColor = batchGroups[0].color || ''
    await window.electronAPI?.setConfig?.('quickCommand.defaultGroupColor', newDefaultColor)

    const userGroups = batchGroups.slice(1)

    // 更新/创建/删除用户分组
    for (let i = 0; i < userGroups.length; i++) {
      const group = userGroups[i]
      const name = group.name.trim()

      if (group.id) {
        if (name) {
          // 更新有效分组
          await window.electronAPI?.commandGroupUpdate({
            id: group.id,
            name,
            color: group.color || undefined,
            order: i + 1
          })
        } else {
          // 名称清空 -> 视为无效，删除该分组；若分组下还有命令，先确认
          const groupCommandCount = commands.filter(c => c.groupId === group.id).length
          if (groupCommandCount > 0) {
            const confirmed = confirm(
              t('statusbar.deleteGroupConfirm', { count: groupCommandCount })
            )
            if (!confirmed) continue
          }
          await window.electronAPI?.commandGroupDelete(group.id)
        }
      } else if (name) {
        // 创建新分组
        const newId = `group-${Date.now()}-${i}`
        await window.electronAPI?.commandGroupAdd({
          id: newId,
          name,
          color: group.color || undefined,
          order: i + 1
        })
      }
      // 空槽位（无 id 且无名称）直接跳过
    }

    await loadAll()
    // 选中的分组可能刚被删掉 —— 回落检查必须对着重载后的真实分组做:
    // 本地 batchGroups 里被删槽位(清空名称)的 id 仍在,若查它则恒判"存在",回落永不触发
    const freshGroups = useQuickCommandsStore.getState().groups
    if (selectedGroupId !== 'default' && !freshGroups.some(g => g.id === selectedGroupId)) {
      setSelectedGroupId('default')
    }
    setShowBatchGroupDialog(false)
  }

  // 分组拖拽排序
  const handleGroupDragStart = (index: number) => {
    if (index === 0) return
    setDraggedIndex(index)
  }

  const handleGroupDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedIndex === null || draggedIndex === index || index === 0) return
    setDragOverIndex(index)
  }

  const handleGroupDrop = (targetIndex: number) => {
    if (draggedIndex === null || draggedIndex === targetIndex || targetIndex === 0) return
    const newGroups = [...batchGroups]
    const [removed] = newGroups.splice(draggedIndex, 1)
    newGroups.splice(targetIndex, 0, removed)
    setBatchGroups(newGroups)
    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  const handleGroupDragEnd = () => {
    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  // 获取分组下的命令（默认分组显示未分配groupId的命令，包括空字符串）
  const getCommandsByGroup = (groupId: string) => {
    if (groupId === 'default') {
      return commands.filter(c => !c.groupId || c.groupId === '')
    }
    return commands.filter(c => c.groupId === groupId)
  }

  // 当前显示的命令 —— store loadAll 时已按 order 全局排序,filter 保序,渲染期无需再 sort
  const currentGroup = allGroups.find(g => g.id === selectedGroupId) || DEFAULT_GROUP
  const displayCommands = useMemo(() => {
    const gid = selectedGroupId || 'default'
    return gid === 'default'
      ? commands.filter(c => !c.groupId || c.groupId === '')
      : commands.filter(c => c.groupId === gid)
  }, [commands, selectedGroupId])
  // 当前分组颜色 —— 染整排钤章的印钮(inline color→currentColor,同轴头/漆杆机制)
  const currentGroupColor = currentGroup?.color || ''

  // 限制字符串的视觉宽度不超过最大值（中文字符算1，英文字符算0.5）
  const limitVisualWidth = (str: string, maxWidth: number): string => {
    let result = ''
    let width = 0
    for (const char of str) {
      const charWidth = /[一-鿿]/.test(char) ? 1 : 0.5
      if (width + charWidth <= maxWidth) {
        result += char
        width += charWidth
      } else {
        break
      }
    }
    return result
  }

  // LED 槽位：默认分组 + 用户分组，补齐到 5 个（空槽位虚线圆，点击开分组编辑）
  const ledSlots = [...allGroups, ...Array.from({ length: Math.max(0, 5 - allGroups.length) }, () => null)]

  return (
    <div className="flex-shrink-0">
      {/* ===== 标题行 —— 对齐 SessionsPanel GroupHeader 视觉语言 ===== */}
      <div
        onClick={toggleCollapsed}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => {
          // 键盘开合:印匣区被 ScrollFold inert 挡在 Tab 序外,键盘用户只能
          // 从这里展开。target 不在自己身上不接 —— 行内 LED 分组点/＋ 聚焦
          // 时按 Enter,keydown 冒泡上来不能误触折叠
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapsed() }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          // 右键打开批量编辑分组对话框（沿袭原分组键右键语义）
          handleOpenGroupDialog()
        }}
        title={t('statusbar.groupSwitchHint')}
        // 点击折叠/展开印匣区（行内 LED 色点/＋都 stopPropagation,不会误触）。
        // 不画 border-b:行底缘就是标题行↔印匣区的缝(辊 rod-caps 悬在行内
        // 居中、隔着小缝望纸),硬线会把辊与下方内容切成两物;折叠时下方紧邻
        // 状态栏的 border-t,自带底线也会叠成双线
        className={cn(
          // scroll-head:标题行即卷轴的裱首+辊(与会话分组折叠栏同款),collapsed
          // 时纸裹轴卷成同径满卷(轴藏卷内,只露两端轴头),展开后回归光辊;
          // rod-caps 端头色跟当前分组色。栏本体无底色(透明,露出 bg-base 框
          // 体),hover 也不铺底 —— 与会话分组折叠栏同款,指针 + 绳的提亮是
          // 全部悬停反馈。
          // 行内垫同 GroupHeader:对称垫,内容线与居中的辊同心;右垫同款
          // 加厚(20px)—— 右轴头占行缘 6-12px,计数/LED/＋与其隔 8px 空气
          'relative scroll-head group flex items-center gap-2.5 pl-3 pr-[20px] py-[5px] text-[10px] text-[var(--text-rack-mute)] cursor-pointer select-none',
          collapsed && 'rolled'
        )}
      >
        {/* 卷轴辊 —— 与 GroupHeader 同款:行内垂直居中(悬浮机件上下留
            气),辊径恒 20px 开合不变粗细 —— 展开时轴体隔着小缝望着印匣区
            顶缘,折叠时纸裹轴成同径满卷(轴藏卷内;圆柱读形在 globals.css
            的 .rod-caps);两端轴头恒跟辊同径、随辊居中不动,色跟当前分组
            LED(未设分组色回落中性 dim) */}
        <span aria-hidden className="rod-caps" style={{ color: currentGroupColor || undefined }} />
        {/* 蝴蝶结记号(ScrollTie)—— 与 GroupHeader 同款:collapsed 时绳在
            满卷上系成蝴蝶结(绳随纸自下方荡上绑紧 + 自由端各拍微摆),展开后
            结解开、绳跟着纸向下飘落淡出(槽位恒占防行首跳动;节拍在
            globals.css 的 .scroll-tie) */}
        <span
          className={cn(
            // 绳色随轴头(currentGroupColor inline 注入,与 rod-caps 同源 ——
            // 拴卷的绳与卷两端的轴头同色),未设分组色回落中性 mute;行悬停
            // 提亮走 opacity 一档(inline color 压过 class,hover 变色类只在
            // 无分组色时生效)
            'inline-flex transition text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)] opacity-80 group-hover:opacity-100'
          )}
          style={{ color: currentGroupColor || undefined }}
        >
          <ScrollTie />
        </span>
        {/* 题签(scroll-slip)—— 与 GroupHeader 同款(书体/金墨在 globals.css),
            题名全栏一只金;折叠时这行字落在纸卷上,读作卷上题签 */}
        <span className="flex-shrink-0 scroll-slip text-[13px]">
          {t('sidebar.quickCmdSection')}
        </span>
        {/* 当前分组名 —— 题签上的小字注记:与题名同金,收小收淡
            (opacity 75 = 金的淡一档);当前在哪组由 LED 单选点 + 轴头色认 */}
        <span className="flex-shrink-0 scroll-slip text-[10.5px] opacity-75">
          · {currentGroup.name}
        </span>
        <span className="flex-1 h-px bg-[var(--rule)]" />
        <span className="[font-family:inherit] text-[11px] text-[var(--text-rack-data)] tracking-[.04em] normal-case tabular-nums">
          {displayCommands.length}
        </span>
        {/* action 簇: LED 分组色点 + ＋ —— 同 LIVE 段 close-all 的按钮语言 */}
        <span className="flex items-center gap-[5px] ml-1.5">
          {ledSlots.map((g, i) =>
            g ? (
              <button
                key={g.id}
                onClick={(e) => {
                  e.stopPropagation()
                  setSelectedGroupId(g.id)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleOpenGroupDialog()
                }}
                title={t('sidebar.quickCmdSwitchGroup', { name: g.name, n: getCommandsByGroup(g.id).length })}
                aria-pressed={selectedGroupId === g.id}
                className={cn(
                  // LED 单选圆:选中/未选中都保持可读;未选中态不压暗
                  'w-[8px] h-[8px] rounded-full flex-shrink-0 transition-all',
                  selectedGroupId === g.id ? 'opacity-100' : 'opacity-60 hover:opacity-100'
                )}
                style={{
                  backgroundColor: g.color || 'var(--text-rack-dim)',
                  boxShadow: selectedGroupId === g.id && g.color
                    ? `0 0 8px ${g.color}`
                    : undefined
                }}
              />
            ) : (
              // 空槽位：虚线圆，点击开分组编辑去命名
              <button
                key={`slot-${i}`}
                onClick={(e) => {
                  e.stopPropagation()
                  handleOpenGroupDialog()
                }}
                title={t('statusbar.editGroups')}
                className="w-[8px] h-[8px] rounded-full flex-shrink-0 border border-dashed border-[var(--text-rack-dim)] opacity-80 hover:opacity-100 transition-opacity"
              />
            )
          )}
        </span>
        {/* ＋ 新建命令（不随面板折叠消失） */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            handleAddNew()
          }}
          title={t('statusbar.clickToAddHint')}
          className="ml-1 h-[20px] w-[20px] inline-flex items-center justify-center rounded-[3px] cursor-pointer text-[14px] leading-none text-[var(--text-rack-mute)] hover:text-[var(--amber)] hover:bg-[var(--bg-elev)] transition-colors"
        >
          ＋
        </button>
      </div>

      {/* ===== 印匣区（键的基底）—— 基底对齐协议筛选 chips strip（bg-strip）:
            印章立的匣盘,群章共卧一匣。折叠时垂卷收起（ScrollFold 垂卷动画,
            与会话分组同款:标题行=辊,印匣区自辊垂落/卷回,窗口下沿是自由边,
            不画横杆 —— 与状态栏 border-t 不叠线）。
            展开态高度随印章自然换行增减,但封顶 5 行（max-h 152px = 5 行印章
            24px + 4 行行距 4px + 上下垫 16px）,超出走 rack-scroll 内滚 ——
            每组上限 12 条,窄栏全堆下时不再把上方的会话列表/文件管理器挤干;
            本模块坐栏底（状态栏正上方）,底部 hairline 由状态栏 border-t 提供,
            不再自带 border-b ===== */}
      <ScrollFold open={!collapsed}>
        <div className="flex flex-wrap gap-[4px] px-2 py-2 max-h-[152px] overflow-y-auto rack-scroll bg-[var(--bg-strip)] content-start">
          {displayCommands.length === 0 ? (
            <span className="text-[11px] text-[var(--text-rack-dim)] tracking-[.04em] py-[3px] px-1">
              {t('sidebar.quickCmdEmpty')}
              <button
                onClick={handleAddNew}
                className="ml-1 text-[var(--amber)] hover:underline cursor-pointer"
              >
                {t('sidebar.quickCmdAddNew')}
              </button>
            </span>
          ) : (
            displayCommands.map((cmd, index) => (
              <button
                key={cmd.id}
                data-cmd
                // 阻止鼠标点击时抢走焦点,点完后光标仍留在终端,避免按回车再次触发该命令
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleExecute(cmd)}
                onContextMenu={(e) => handleCommandContextMenu(cmd, e)}
                className={cn(
                  // 钤章(seal):章体/印钮/印文/钤印拍的机械全在 globals.css
                  // 的 .seal 系列,这里只挂身份色(inline color → 印钮
                  // currentColor,分组色染钮,同轴头/漆杆机制)与拍态(.on);
                  // 器无持久态 —— 分组选择归标题行 LED,这里不携带拴绳/解绳
                  // 语义。F 键号不刻章面(印文独占),Ctrl+F 提示走 title 悬停
                  'seal relative flex-shrink-0 h-[24px] pl-[12px] pr-[10px] flex items-center select-none',
                  disabled
                    ? 'cursor-not-allowed opacity-40'
                    : 'cursor-pointer',
                  editingCommandId === cmd.id && 'ring-1 ring-inset ring-[var(--amber)]',
                  sealFlash === cmd.id && 'on'
                )}
                style={{ color: currentGroupColor || 'var(--text-rack-dim)' }}
                title={disabled
                  ? t('sidebar.quickCmdDisabled')
                  : `${index < 12 ? `Ctrl+F${index + 1} · ` : ''}${cmd.content}`}
              >
                {/* 章体 —— 一方温石,垫在印文后(z -1);钤印拍整面敷印泥朱 */}
                <span aria-hidden className="seal-stone" />
                {/* 印钮 —— 顶缘瓦钮(盖章的手按处),分组色染钮(currentColor) */}
                <span aria-hidden className="seal-knob" />
                {/* 印文 — 命令名刻进石面(书体/刻痕在 globals.css),钤印拍翻纸色(纸透上来) */}
                <span className="seal-name">{cmd.name}</span>
              </button>
            ))
          )}
        </div>
      </ScrollFold>

      {/* Quick-command editor */}
      {showAddDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--bg-rack)] border border-[var(--rule)] rounded-[4px] shadow-2xl w-[400px] overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-[var(--bg-slot)] border-b border-[var(--rule)]">
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full ring-2 ring-[var(--bg-slot)]"
                  style={{ backgroundColor: currentGroupColor || 'var(--text-rack-dim)' }}
                />
                <span className="text-[12px] font-semibold text-[var(--text-rack)]">
                  {editCommand ? t('statusbar.editCommandTitle') : t('statusbar.newCommandTitle')}
                </span>
              </div>
              <button
                onClick={() => {
                  setShowAddDialog(false)
                  setEditingCommandId(null)
                  resetDialogState()
                }}
                className="text-[var(--text-rack-dim)] hover:text-[var(--text-rack)] text-lg leading-none px-1"
                aria-label={t('common.close')}
              >
                ×
              </button>
            </div>

            <div className="px-4 py-4 space-y-4">
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-[12px] tracking-[.04em] text-[var(--text-rack-data)] mb-1.5">
                    {t('statusbar.fieldName')}
                    <span className="text-[var(--error-rack)] ml-0.5" title={t('statusbar.nameRequired')}>*</span>
                  </label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => {
                      setNewName(e.target.value)
                      if (nameError) setNameError(false)
                    }}
                    placeholder={t('statusbar.namePlaceholder')}
                    autoFocus
                    aria-required="true"
                    className={cn(
                      'w-full px-2.5 py-1.5 bg-[var(--bg-base)] border rounded-[3px] text-sm text-[var(--text-rack)] placeholder-[var(--text-rack-faint)] focus:outline-none',
                      nameError
                        ? 'border-[var(--error-rack)] focus:border-[var(--error-rack)]'
                        : 'border-[var(--rule)] focus:border-[var(--amber)]'
                    )}
                  />
                  {nameError && (
                    <div className="mt-1 text-[11px] text-[var(--error-rack)]">{t('statusbar.nameRequired')}</div>
                  )}
                </div>
                <div className="w-[130px]">
                  <label className="block text-[12px] tracking-[.04em] text-[var(--text-rack-data)] mb-1.5">{t('statusbar.fieldGroup')}</label>
                  <select
                    value={newGroupId}
                    onChange={(e) => setNewGroupId(e.target.value)}
                    className="w-full px-2 py-1.5 bg-[var(--bg-base)] border border-[var(--rule)] rounded-[3px] text-sm text-[var(--text-rack)] focus:outline-none focus:border-[var(--amber)]"
                  >
                    <option value="">{t('statusbar.defaultGroup')}</option>
                    {groups.map(g => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[12px] tracking-[.04em] text-[var(--text-rack-data)] mb-1.5">
                  {t('statusbar.fieldCommand')}
                  <span className="text-[var(--error-rack)] ml-0.5" title={t('statusbar.commandRequired')}>*</span>
                </label>
                <textarea
                  value={newContent}
                  onChange={(e) => {
                    setNewContent(e.target.value)
                    if (contentError) setContentError(false)
                  }}
                  placeholder={t('statusbar.commandPlaceholder')}
                  rows={4}
                  aria-required="true"
                  className={cn(
                    'w-full px-2.5 py-2 bg-[var(--bg-base)] border rounded-[3px] text-sm font-mono text-[var(--text-rack)] placeholder-[var(--text-rack-faint)] focus:outline-none resize-none',
                    contentError
                      ? 'border-[var(--error-rack)] focus:border-[var(--error-rack)]'
                      : 'border-[var(--rule)] focus:border-[var(--amber)]'
                  )}
                />
                {contentError && (
                  <div className="mt-1 text-[11px] text-[var(--error-rack)]">{t('statusbar.commandRequired')}</div>
                )}
              </div>

              <label
                className="flex items-center gap-2.5 cursor-pointer select-none group/esc"
                title={t('statusbar.parseEscapeTitle')}
              >
                <span className="relative flex-shrink-0">
                  <input
                    type="checkbox"
                    checked={newEscape}
                    onChange={(e) => setNewEscape(e.target.checked)}
                    className="sr-only peer"
                  />
                  <span
                    className={cn(
                      'block w-4 h-4 rounded-[4px] border transition-colors',
                      newEscape
                        ? 'bg-[var(--amber)] border-[var(--amber)]'
                        : 'bg-[var(--bg-base)] border-[var(--rule)] group-hover/esc:border-[var(--text-rack-dim)]'
                    )}
                  />
                  <svg
                    viewBox="0 0 14 14"
                    className={cn(
                      'absolute inset-0 w-4 h-4 m-auto pointer-events-none transition-opacity',
                      newEscape ? 'opacity-100' : 'opacity-0'
                    )}
                    style={{ color: 'var(--bg-base)' }}
                  >
                    <path d="M3 7.5 L5.5 10 L11 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="text-xs text-[var(--text-rack)]">{t('statusbar.parseEscape')}</span>
              </label>
            </div>

            <div className="flex items-center justify-between gap-2 px-4 py-3 bg-[var(--bg-slot)] border-t border-[var(--rule)]">
              {editCommand ? (
                <button
                  onClick={handleDeleteCommand}
                  className="px-3 py-1.5 text-xs font-medium text-[var(--error-rack)] hover:bg-[var(--error-rack)]/10 rounded-[3px] transition-colors"
                >
                  {t('statusbar.delete')}
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowAddDialog(false)
                    setEditingCommandId(null)
                    resetDialogState()
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] hover:bg-[var(--bg-elev)] rounded-[3px] transition-colors"
                >
                  {t('statusbar.cancel')}
                </button>
                <button
                  onClick={handleSaveCommand}
                  className="px-4 py-1.5 text-xs font-semibold bg-[var(--amber)] text-[var(--bg-base)] rounded-[3px] hover:brightness-110 transition-[filter]"
                >
                  {t('statusbar.save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Group editor */}
      {showBatchGroupDialog && (
        <div className="fixed inset-0 z-50 pointer-events-none">
          <div
            className="pointer-events-auto absolute top-1/2 left-1/2 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[4px] w-[320px] overflow-hidden"
            style={{
              transform: `translate(-50%, -50%) translate(${groupDialogOffset.x}px, ${groupDialogOffset.y}px)`,
              boxShadow: '0 24px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.03)'
            }}
          >
            <div
              className="flex items-center justify-between px-4 py-3 bg-[var(--bg-base)] border-b border-[var(--rule)] cursor-move select-none"
              onMouseDown={handleGroupDialogMouseDown}
            >
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-[var(--text-rack)] tracking-wide">{t('statusbar.editGroups')}</span>
                <span
                  className="text-xs font-mono text-[var(--text-rack-data)] px-1.5 py-0.5 bg-[var(--bg-elev)] rounded-[2px]"
                  style={{ fontFeatureSettings: '"tnum" 1' }}
                >
                  {batchGroups.length - 1}/4
                </span>
              </div>
              <button
                onClick={() => {
                  setShowBatchGroupDialog(false)
                  setGroupDialogOffset({ x: 0, y: 0 })
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className="w-7 h-7 flex items-center justify-center text-[var(--text-rack-dim)] hover:text-[var(--text-rack)] text-lg leading-none pointer-events-auto rounded-[3px] hover:bg-[var(--bg-elev)] transition-colors"
                aria-label={t('common.close')}
              >
                ×
              </button>
            </div>

            <div className="px-4 py-4 space-y-2">
              {batchGroups.map((bg, index) => {
                const isDefault = index === 0
                const isDragged = draggedIndex === index
                const isDragOver = dragOverIndex === index && draggedIndex !== index
                return (
                  <div
                    key={index}
                    draggable={!isDefault}
                    onDragStart={() => handleGroupDragStart(index)}
                    onDragOver={(e) => handleGroupDragOver(e, index)}
                    onDrop={() => handleGroupDrop(index)}
                    onDragEnd={handleGroupDragEnd}
                    className={cn(
                      'group flex items-center gap-2 p-2 rounded-[4px] bg-[var(--bg-base)] border transition-all',
                      isDragOver ? 'border-[var(--amber)] ring-1 ring-[var(--amber)]/30' : 'border-[var(--rule)]',
                      isDragged && 'opacity-40',
                      !isDefault && 'hover:border-[var(--text-rack-dim)]'
                    )}
                  >
                    {/* Drag handle / default lock */}
                    {!isDefault ? (
                      <div
                        className="w-5 h-5 flex-shrink-0 flex items-center justify-center rounded-[3px] bg-[var(--bg-elev)] border border-[var(--rule)] text-[10px] font-mono text-[var(--text-rack)] cursor-move"
                        title={t('statusbar.dragToReorder')}
                      >
                        {index}
                      </div>
                    ) : (
                      <div
                        className="w-5 h-5 flex-shrink-0 flex items-center justify-center text-[var(--text-rack-data)]"
                        title={t('statusbar.defaultGroupLabel')}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="5" y="11" width="14" height="10" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                      </div>
                    )}

                    {/* Nameplate input */}
                    <input
                      type="text"
                      value={bg.name}
                      onChange={(e) => {
                        if (isDefault) return
                        const newGroups = [...batchGroups]
                        newGroups[index].name = limitVisualWidth(e.target.value, 6)
                        setBatchGroups(newGroups)
                      }}
                      placeholder={isDefault ? t('statusbar.defaultGroup') : t('statusbar.groupNamePlaceholder')}
                      disabled={isDefault}
                      className={cn(
                        'flex-1 min-w-0 h-7 px-2.5 bg-[var(--bg-rack)] border border-[var(--rule)] rounded-[3px] text-sm text-[var(--text-rack)] placeholder-[var(--text-rack-faint)]',
                        isDefault ? 'cursor-not-allowed opacity-80' : 'focus:outline-none focus:border-[var(--amber)]'
                      )}
                    />

                    {/* Color swatches */}
                    <div className="flex items-center gap-[2px] h-7">
                      {PREDEFINED_COLORS.map(color => {
                        const selected = bg.color === color
                        return (
                          <button
                            key={color}
                            type="button"
                            onClick={() => {
                              const newGroups = [...batchGroups]
                              newGroups[index].color = color
                              setBatchGroups(newGroups)
                            }}
                            className={cn(
                              'w-[18px] h-[18px] rounded-[3px] flex-shrink-0 box-border block overflow-hidden',
                              'border appearance-none p-[1px] m-0',
                              selected
                                ? 'border-white/90'
                                : 'border-black/60 hover:border-black/80'
                            )}
                            aria-label={t('statusbar.setGroupColor', { color })}
                          >
                            <span
                              className="block w-full h-full rounded-[2px]"
                              style={{ backgroundColor: color }}
                            />
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="px-4 pb-2 text-[10px] text-[var(--text-rack-dim)] leading-relaxed">
              {t('statusbar.clearGroupHint')}
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3 bg-[var(--bg-base)] border-t border-[var(--rule)]">
              <button
                onClick={() => {
                  setShowBatchGroupDialog(false)
                  setGroupDialogOffset({ x: 0, y: 0 })
                }}
                className="px-3 py-1.5 text-xs font-medium text-[var(--text-rack-data)] hover:text-[var(--text-rack)] hover:bg-[var(--bg-elev)] rounded-[3px] transition-colors"
              >
                {t('statusbar.cancel')}
              </button>
              <button
                onClick={handleSaveBatchGroups}
                className="px-4 py-1.5 text-xs font-semibold bg-[var(--amber)] text-[var(--bg-base)] rounded-[3px] hover:brightness-110 transition-[filter]"
              >
                {t('statusbar.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default QuickCommandsPanel
