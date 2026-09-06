import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { COMMANDS, matchCommands, normalizeQuery, findExact, splitCommand, splitCommandUi, filterArgCandidates } from '../../commands/command-registry'
import type { CommandEntry } from '../../commands/command-registry'
import DocTabOverlay from '../DocPanel/DocTabOverlay'
import type { DocOverlayPayload } from '@shared/types'

/**
 * 全屏 TUI 命令界面 —— 空状态(嵌入 pane)与全局面板(Ctrl+Shift+P)共用。
 *
 * 琥珀磷光屏方向:整屏只有一种等宽字体、amber 一个焦点色,内容左对齐成一条
 * max-w-3xl 列(终端从左上角开始,居中是网页习惯)。四段:输出滚动区(命令回显,
 * 像 shell;空态零内容)/ 候选列表(输入非空才出现 —— 空输入是纯待命态,无补全
 * 无提示,↑↓ 翻命令历史;选中行 amber 反色,Tab 补全选中项;带参命令进入参数
 * 区后切换为参数目录 —— 参数区刚开(按了空格)时 ↑↓ 翻这条命令的参数历史)/ prompt(空
 * 输入时是 1.06s BIOS 闪率的块状光标 + 跟在其后的一行 ghost 提示:help、/?、/
 * 三个入口展开完整命令目录,输入即让位 —— 待命屏上唯一一行提示)/ 反色状态栏。
 * 整屏覆一层极淡 CRT 扫描线(.cs-scanlines,globals.css),是"管子材质"而非装饰。
 *
 * 两种形态的差异收敛在 mode:
 * - embedded:铺满空 pane,Esc 清空输入;被活面板
 *   (web / dsh web / MCP 审计)盖住时让出焦点、全撤后自动收回(covered 由
 *   PaneView 传入)。文档页签不盖屏而是内联进输出区(inlineDoc):md 在上、
 *   prompt 在下,键盘始终在命令屏 —— 点击文档内容(链接/按钮)也不带走焦点,
 *   文档即本次命令的输出
 * - overlay :铺满终端区(盖住页签行),120ms 浮现,Esc / closeOverlay
 *   命令(/local)经 onClose 关闭
 */

/** 输出区的一条历史:命令 echo + 回显(error = 未知命令) */
interface HistoryEntry {
  cmd: string
  output?: string
  error?: boolean
}

interface CommandScreenProps {
  mode: 'embedded' | 'overlay'
  /** embedded:所属 pane 激活时聚焦(activePaneId 启动后才落定,靠变化重触发) */
  paneActive?: boolean
  /** embedded:命令屏被活面板覆盖层(网页 / dsh web / MCP 审计,absolute inset-0
   *  盖屏)盖住 —— 让出焦点,键盘不往看不见的输入框里攒幽灵命令;全撤后收回。
   *  文档页签不走这里(不盖屏,见 inlineDoc) */
  covered?: boolean
  /** embedded 空态:激活中的文档页签内联为输出区 —— 完整的 DocTabOverlay(头条 +
   *  阅读画布)填满命令屏的输出位,md 在上、prompt 在下,文档即本次命令的输出;
   *  命令回显让位。id/paneId 供文档内部的打开/刷新动作寻路 */
  inlineDoc?: { id: string; paneId: string; payload: DocOverlayPayload }
  /** overlay:Esc / closeOverlay 命令执行后关闭面板 */
  onClose?: () => void
}

/** 命令行(候选列表与 /help 输出共用同一排版:name 定宽 + 描述截断) */
const CommandRow: React.FC<{
  name: string
  desc: string
  selected?: boolean
  onMouseEnter?: () => void
  onClick?: () => void
}> = ({ name, desc, selected, onMouseEnter, onClick }) => (
  <div
    onMouseEnter={onMouseEnter}
    onClick={onClick}
    className={`flex items-center gap-4 px-2 h-[32px] font-mono text-[13px] select-none ${
      onClick ? 'cursor-pointer' : ''
    } ${selected ? 'bg-[var(--amber)] text-black' : 'text-[var(--text-rack)]'}`}
  >
    <span className="w-[112px] flex-shrink-0">/{name}</span>
    <span className={`flex-1 min-w-0 truncate text-xs ${selected ? 'text-black' : 'text-[var(--text-rack-mute)]'}`}>
      {desc}
    </span>
  </div>
)

/** 目录行:名字 + 说明;children = 行首缩进标记出的子命令行(挂最近的父行) */
interface CatalogRow {
  name: string
  desc: string
  children: { name: string; desc: string }[]
}

/** 输出区正文(按行渲染):「[/]名字 + 两个以上空格 + 说明」的目录行 —— 目前 /?
 *  打进输出区的命令清单 —— 按命令分组渲染,与候选列表同一套视觉:名字列定宽、
 *  说明列只在自身列内换行。层级不吃对比度(暗色再暗一档在深色屏上读不清),
 *  差别全在结构:首行「# 」开头的标题(字距标签 + 细底线,man-page 式抬头,
 *  词首大写、带命令总数);父行与其子命令行(树形勾线 ├ 兄弟 / └ 组尾,tree 语的从属
 *  标记)抱成一个组、组内零间距,组间 mt-2 留白;字号比交互目录大一档 —— 它是
 *  印下来留在屏上读的文档:父行名字 14px 亮色,子行与说明列 13px。子命令是
 *  清单里「能跟着命令接着输的东西」—— 勾线与参数词整列琥珀点亮(磷光屏里
 *  被"打亮"的词),一扫即见;说明列统一 data 档(比 mute 亮一档的可读次级,
 *  mute 拿来当正文在深色屏上读着吃力)。其余输出(单行回显、报错)维持纯文本原样 */
const OutputBody: React.FC<{ output: string }> = ({ output }) => {
  const lines = output.split('\n')
  const title = lines[0]?.startsWith('# ') === true ? lines[0].slice(2) : null
  const rows: (CatalogRow | { plain: string })[] = []
  for (const line of title !== null ? lines.slice(1) : lines) {
    const m = line.match(/^(\s*)(\S+?)\s{2,}(.*)$/)
    if (!m) {
      rows.push({ plain: line })
      continue
    }
    // 行首缩进 = 子命令:挂进最近的父行(没有父行的防御性落回普通行)
    const last = rows[rows.length - 1]
    if (m[1] !== '' && last !== undefined && 'children' in last) {
      last.children.push({ name: m[2], desc: m[3] })
    } else {
      rows.push({ name: m[2], desc: m[3], children: [] })
    }
  }
  return (
    <>
      {title !== null && (
        <div className="mb-1.5 border-b border-[var(--rule)] pb-1.5 text-[12px] tracking-[0.15em] text-[var(--text-rack)]">
          {title}
        </div>
      )}
      {rows.map((row, i) =>
        'plain' in row ? (
          <div key={i} className="whitespace-pre-wrap break-words">{row.plain}</div>
        ) : (
          <div key={i} className={i > 0 ? 'mt-2' : undefined}>
            <div className="flex items-baseline gap-4 py-0.5">
              <span className="w-[112px] flex-shrink-0 text-sm text-[var(--text-rack)]">{row.name}</span>
              <span className="flex-1 min-w-0 break-words text-[13px] text-[var(--text-rack-data)]">{row.desc}</span>
            </div>
            {row.children.map((c, j) => (
              <div key={c.name} className="flex items-baseline gap-4">
                <span className="w-[112px] flex-shrink-0 pl-3 text-[13px] text-[var(--amber)]">
                  <span aria-hidden className="mr-1">{j === row.children.length - 1 ? '└' : '├'}</span>
                  {c.name}
                </span>
                <span className="flex-1 min-w-0 break-words text-[13px] text-[var(--text-rack-data)]">{c.desc}</span>
              </div>
            ))}
          </div>
        )
      )}
    </>
  )
}

const CommandScreen: React.FC<CommandScreenProps> = ({ mode, paneActive, covered, inlineDoc, onClose }) => {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  // 历史回溯:{scope, pos}。scope '' = 整行回溯,输入空时按 ↑ 进入;scope 'ls'
  // = /ls 的参数回溯,命令名后按了空格、参数区还空着时按 ↑ 进入(子命令级)。
  // pos = 过滤后历史(时间正序)从最新往回数第几条(0 = 最近一条)。↓ 越过最新
  // 退出(整行回空、参数回溯回到命令名 + 空格),任何其它按键(输入/Tab/Enter/
  // Esc)也退出
  const [historyBrowse, setHistoryBrowse] = useState<{ scope: string; pos: number } | null>(null)
  // IME 组合中:块状光标让位原生 caret(组合文本的位置才是用户当下看的)
  const [composing, setComposing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const outputRef = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => matchCommands(value), [value])

  // 参数目录:首词精确命中且命令声明了参数候选(当前 /help、/ls)时,候选列表
  // 切换为参数目录 —— filterArgCandidates 前缀优先、零命中回落错字兜底,
  // 参数区刚打开(空白后还没键入)即完整目录。↑↓ / Tab / Enter / 点击与
  // 命令目录同一套交互。
  const argCatalog = useMemo(() => {
    const parsed = splitCommandUi(value)
    if (parsed.args === undefined) return null
    const entry = findExact(parsed.name)
    const candidates = entry?.argCandidates
    if (!entry || !candidates) return null
    return {
      entry,
      args: parsed.args,
      candidates: filterArgCandidates(candidates, parsed.args),
      total: candidates.length
    }
  }, [value])
  // 两种目录共用一套 selectedIndex / ↑↓ 循环 / 滚动跟随
  const listLength = argCatalog ? argCatalog.candidates.length : matches.length

  // 空输入且非 IME 组合 = 待命态:块状光标接管(prompt 本身就是邀请,不放 placeholder)
  const showBlockCursor = value === '' && !composing

  // 输入非空才有补全与提示:空输入是纯待命态(候选列表/计数全不出现,↑↓ 的
  // 去处是命令历史,见 handleKeyDown),键入第一个字符(含 /)即展开 —— 提示
  // 永远跟着输入走,不抢在输入之前。空白字符(纯空格/制表)不算"开始输入"。
  // 整行回溯中候选列表暂避(召回的是完整命令,过滤目录反而是噪音);参数回溯
  // 保留 —— 召回的参数即过滤词,参数目录就是对召回值的预览
  const browsingLines = historyBrowse !== null && historyBrowse.scope === ''
  const listVisible = !browsingLines && value.trim() !== ''

  // 聚焦:overlay 挂载即聚焦;embedded 等所属 pane 激活(启动时 activePaneId
  // 晚于挂载落定,依赖 paneActive 翻转重触发追平)。embedded 被覆盖层(文档
  // 页签)盖住时让出焦点 —— 键盘不该打进看不见的输入框里攒出一条幽灵命令;
  // 覆盖层全撤(关掉清单页签)后收回,接着打字不用先点一下输入框
  useEffect(() => {
    if (mode === 'overlay' || (paneActive && !covered)) inputRef.current?.focus()
    else if (covered) inputRef.current?.blur()
  }, [mode, paneActive, covered])

  // 点击任意处聚焦 prompt —— TUI 惯例:整屏就是输入面(xterm 同款 mousedown 聚焦);
  // 也是焦点意外丢失(窗口切回 / 时序竞态)的自愈通道。被覆盖层盖住时不抢焦点
  // (活动覆盖层 zIndex 更高,点击根本到不了这里,守卫只是防御性兜底)。
  // 点击落在可聚焦控件上(内联文档的头条按钮、md 链接、复制钮、大纲轨…)时,先
  // 阻断 mousedown 的默认动作 —— 浏览器会把焦点搬给该控件;click 仍照常派发,
  // 功能不受影响。待命屏上点其他内容,输入焦点不变,点完文档直接接着打字。
  // 例外:prompt 自身与纯文本/留白不拦,光标定位与文档拖选维持原生行为
  const handleRootMouseDown = (e: React.MouseEvent) => {
    if (covered) return
    if (e.button !== 0) return
    // 从点击目标向上走到命令屏根(不越过根,页签条等外部容器不归这里管),途中
    // 撞上第一个可聚焦元素即拦
    let node: HTMLElement | null = e.target as HTMLElement
    while (node && node !== e.currentTarget) {
      if (node === inputRef.current) break
      if (node.matches('button, a, input, select, textarea, [tabindex]')) {
        e.preventDefault()
        break
      }
      node = node.parentElement
    }
    inputRef.current?.focus()
  }

  // 新输出滚到底(shell 习惯:最新输出可见)
  useEffect(() => {
    const el = outputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [history])

  // 高亮候选保持在视野内
  useEffect(() => {
    listRef.current?.children[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, listLength])

  const execute = (entry: CommandEntry, args?: string) => {
    const output = entry.run(args)
    setHistory(h => [...h, { cmd: args ? `${entry.name} ${args}` : entry.name, output: output ?? undefined }])
    setValue('')
    setSelectedIndex(0)
    setHistoryBrowse(null)
    // /local(长出终端)、/help(手册页签落在分屏上)这类结果要露出来的命令,
    // overlay 形态执行完即关面板
    if (mode === 'overlay' && entry.closeOverlay) onClose?.()
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value)
    setSelectedIndex(0)
    setHistoryBrowse(null)  // 重新输入即退出历史回溯
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // IME 组合中的 Enter 是选字;组合中的 Escape 是取消候选,都不当命令键
    if (e.nativeEvent.isComposing) return

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // 历史回溯的三个入口:回溯中继续翻;输入空(待命)= 整行回溯;命令名后
      // 按了空格且参数区空着 = 这条命令的参数回溯(子命令)。其余时刻 ↑↓ 仍是
      // 候选选择。history 里存的是回显行(未知命令也算),按 / 前缀召回;↑ 翻到
      // 最旧一条停住,↓ 越过最新退出(整行回空、参数回溯回到命令名 + 空格)
      const argIdle = argCatalog !== null && argCatalog.args === ''
      if (historyBrowse !== null || value.trim() === '' || argIdle) {
        e.preventDefault()
        let scope: string
        if (historyBrowse) scope = historyBrowse.scope
        else if (argIdle && argCatalog) scope = argCatalog.entry.name
        else scope = ''
        // 参数回溯按命令名过滤:只翻这条命令用过的行(含无参的它本身),别的
        // 命令的历史不混入;整行回溯(scope '')不过滤
        const scoped = scope === ''
          ? history
          : history.filter(h => h.cmd === scope || h.cmd.startsWith(`${scope} `))
        if (scoped.length === 0) return
        if (e.key === 'ArrowUp') {
          const pos = Math.min((historyBrowse?.pos ?? -1) + 1, scoped.length - 1)
          if (historyBrowse && pos === historyBrowse.pos) return  // 已在最旧一条,按住不动
          setValue(`/${scoped[scoped.length - 1 - pos].cmd}`)
          setHistoryBrowse({ scope, pos })
        } else if (historyBrowse !== null) {
          const pos = historyBrowse.pos - 1
          if (pos < 0) {
            setValue(scope === '' ? '' : `/${scope} `)
            setHistoryBrowse(null)
          } else {
            setValue(`/${scoped[scoped.length - 1 - pos].cmd}`)
            setHistoryBrowse({ scope, pos })
          }
        }
        setSelectedIndex(0)
        return
      }
      if (listLength === 0) return
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setSelectedIndex(i => (i + delta + listLength) % listLength)
      return
    }

    if (e.key === 'Tab') {
      e.preventDefault()
      setHistoryBrowse(null)  // 回溯中按 Tab = 把召回的命令当普通输入处理,退出回溯
      // 空输入待命:没有可补全的对象(preventDefault 保住焦点不跳走即可)
      if (!listVisible) return
      if (argCatalog) {
        // 参数目录:补全选中的候选(↑↓ / 悬停点亮的那行;唯一命中时即它)
        if (argCatalog.candidates.length === 0) return
        const sel = argCatalog.candidates[selectedIndex] ?? argCatalog.candidates[0]
        setValue(`/${argCatalog.entry.name} ${sel.value}`)
        setSelectedIndex(0)
        return
      }
      if (matches.length === 0) return
      // 输入已是完整命令名:按它规整(补斜杠;带参数目录的顺势带空格展开参数),
      // 不改写用户已敲定的命令(help、/? 这类别名会展开整张目录,选中行未必是
      // 输入的本意);否则补全选中的候选行 —— 点亮的那条就是 Tab 的去处
      const sel = findExact(normalizeQuery(value)) ?? matches[selectedIndex] ?? matches[0]
      setValue(sel.argCandidates ? `/${sel.name} ` : `/${sel.name}`)
      setSelectedIndex(0)
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      // 空输入(含纯空白)回车 = 空 shell 行:不执行、不回显。此前会静默执行
      // 候选列表的第一条(空输入即全量目录),列表不出现后更是不可见的选中。
      // 判空不判 listVisible —— 历史回溯中召回的命令(列表暂避)照常执行
      if (value.trim() === '') return
      // 参数目录:已键参数且目录有命中 → 执行选中候选(↑↓ 可选,与命令模式同一
      // 语义);参数为空(刚按空白,按原文执行 = 全量/缺省)或无命中(按原文,
      // 由命令自行报错)不走选中
      if (argCatalog) {
        const sel = argCatalog.candidates[selectedIndex] ?? argCatalog.candidates[0]
        if (argCatalog.args !== '' && sel) execute(argCatalog.entry, sel.value)
        else execute(argCatalog.entry, argCatalog.args || undefined)
        return
      }
      // 带参数的输入(/help chinese)按首词精确匹配命令名,参数原文透传给 run();
      // /? 是目录里的真命令(输入即动词),无参回车也按原文路由而非目录首行;
      // 其余无参数输入维持既有路径 —— 回车执行候选列表里的选中项(前缀 + ↑↓ 选择)
      const parsed = splitCommand(value)
      const entry = parsed.args || parsed.name === '?'
        ? findExact(parsed.name)
        : matches[selectedIndex]
      if (entry) {
        execute(entry, parsed.args)
      } else {
        // 输入非空但零匹配:像 shell 一样回显报错行(空输入无匹配不会发生,空=全部)
        const q = normalizeQuery(value)
        setHistory(h => [...h, {
          cmd: q,
          error: true,
          output: t('commandBar.unknownCommand', { cmd: q })
        }])
        setValue('')
        setSelectedIndex(0)
        setHistoryBrowse(null)
      }
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      if (mode === 'overlay' && onClose) {
        onClose()
      } else {
        setValue('')
        setSelectedIndex(0)
        setHistoryBrowse(null)
      }
    }
  }

  return (
    <div
      onMouseDown={handleRootMouseDown}
      className={`relative w-full h-full flex flex-col bg-[var(--terminal-bg)] font-mono ${mode === 'overlay' ? 'cs-fade-in' : ''}`}
    >
      {/* 输出区。空态跑出文档页签(/ls、/help)时,激活的文档内联在此 —— 完整的
          DocTabOverlay(absolute inset-0 填满下方 relative 容器):md 在上、本组件
          的候选列表/prompt/状态栏在其下,键盘始终在命令屏;命令回显让位(文档即
          本次输出)。其余时刻是回显滚动区(命令 echo;空态零内容 —— 待命屏上
          不出现任何未经请求的信息) */}
      {inlineDoc ? (
        <div className="flex-1 min-h-0 relative">
          <DocTabOverlay id={inlineDoc.id} paneId={inlineDoc.paneId} payload={inlineDoc.payload} />
        </div>
      ) : (
        <div ref={outputRef} className="flex-1 min-h-0 overflow-y-auto px-8">
          <div className="max-w-3xl w-full">
            {history.map((h, i) => (
              <div key={i} className="mb-3">
                <div className="text-[13px] text-[var(--text-rack)]">
                  <span className="text-[var(--amber)]">❯</span> /{h.cmd}
                </div>
                <div className={`pl-3 text-xs mt-0.5 ${h.error ? 'text-red-400' : 'text-[var(--text-rack-mute)]'}`}>
                  {h.output ? <OutputBody output={h.output} /> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 候选列表:输入非空才出现(空输入 = 纯待命态,无补全无提示),输入即过滤,
          参数区 = 参数目录;直接盖在 prompt 上方(fzf 布局),行首列即回车会执行的
          完整命令。高度取所需、允许收缩 + 自滚:矮分屏里列表让位到刚好放得下,
          多出的行在列表内滚动(状态栏永不出屏)。此前 max-h-[45%] 挂在内层 ——
          父层 auto 高度会让百分比解析失效,钳制从未生效,矮屏里尾部命令
          直接被裁掉且无滚动 */}
      {listVisible && (
        <div className="shrink min-h-0 overflow-y-auto px-8 pb-2">
          <div ref={listRef} className="max-w-3xl w-full">
            {argCatalog ? (
              argCatalog.candidates.length > 0 ? (
                argCatalog.candidates.map((c, i) => (
                  <CommandRow
                    key={c.value}
                    name={`${argCatalog.entry.name} ${c.value}`}
                    desc={t(c.descriptionKey)}
                    selected={i === selectedIndex}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => execute(argCatalog.entry, c.value)}
                  />
                ))
              ) : (
                <div className="px-2 h-[32px] flex items-center text-xs text-[var(--text-rack-mute)] select-none">
                  {t('commandBar.emptyArg')}
                </div>
              )
            ) : (
              matches.length > 0 ? (
                matches.map((entry, i) => (
                  <CommandRow
                    key={entry.name}
                    name={entry.name}
                    desc={t(entry.descriptionKey)}
                    selected={i === selectedIndex}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => execute(entry)}
                  />
                ))
              ) : (
                <div className="px-2 h-[32px] flex items-center text-xs text-[var(--text-rack-mute)] select-none">
                  {t('commandBar.emptyResult')}
                </div>
              )
            )}
          </div>
        </div>
      )}

      {/* prompt 输入行 —— 空输入时块状光标在文本原点待命(1.06s BIOS 闪率,见
          globals.css),光标后跟一行 ghost 提示(help、/?、/ 展开完整命令目录) */}
      <div className="shrink-0 px-8 py-3 border-t border-[var(--rule)]">
        <div className="max-w-3xl w-full flex items-center gap-2">
          <span className="text-[var(--amber)] text-sm font-bold select-none">❯</span>
          <div className="flex-1 min-w-0 relative">
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              spellCheck={false}
              autoComplete="off"
              aria-label={t('commandBar.placeholder')}
              className={`flex-1 min-w-0 bg-transparent outline-none border-none text-sm text-[var(--text-rack)] ${
                showBlockCursor ? 'caret-transparent' : 'caret-[var(--amber)]'
              }`}
            />
            {showBlockCursor && (
              <>
                <span aria-hidden className="cs-blink pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 w-2 h-[19px] bg-[var(--amber)]" />
                {/* 待命 ghost 提示:跟在块状光标后的一行暗色建议(fish 式),点名
                    help、/?、/ 三个入口都能展开完整命令目录;输入即让位 */}
                <span aria-hidden className="pointer-events-none absolute left-2 right-0 top-1/2 -translate-y-1/2 truncate text-sm text-[var(--text-rack-dim)] select-none">
                  {t('commandBar.idleHint')}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 状态栏:反色条,左快捷键右计数(tmux 式收尾);tabular-nums 防计数跳动推挤。
          计数与候选列表同门 —— 空输入待命态不出现(无提示),输入后亮出 */}
      <div className="shrink-0 h-7 flex items-center justify-between px-4 text-[11px] select-none bg-[var(--text-rack)] text-[var(--terminal-bg)]">
        <span>
          {mode === 'overlay' ? t('commandBar.statusOverlay') : t('commandBar.statusEmbedded')}
        </span>
        {listVisible && (
          <span className="tabular-nums">
            {argCatalog
              ? t('commandBar.argCount', { matched: argCatalog.candidates.length, total: argCatalog.total })
              : t('commandBar.matchCount', { matched: matches.length, total: COMMANDS.length })}
          </span>
        )}
      </div>

      {/* CRT 扫描线 —— 整屏材质层,盖住全部内容含状态栏,不参与交互与屏读 */}
      <div aria-hidden className="absolute inset-0 pointer-events-none cs-scanlines" />
    </div>
  )
}

export default CommandScreen
