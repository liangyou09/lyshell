import React, { useState } from 'react'
import cn from 'classnames'
import { isSecretEnvKey } from '@shared/harness'

/**
 * 环境变量 key-value 行编辑器（受控组件）—— HarnessPanel 变量组对话框与
 * AgentsPanel 的 Agent 编辑对话框共用一份，替代两处各自维护的行编辑逻辑。
 *
 * 行为对齐原 HarnessPanel 实现：敏感值（isSecretEnvKey 命中：API key / token 类）
 * 默认打码（-webkit-text-security 而非 type=password，免去 Chromium 自带小眼睛），
 * 点右侧眼睛按钮才明文；改 key 即复位该行打码（改名前后敏感性可能不同）；
 * 删行时明文状态随行号前移修正，避免串到别的行。
 *
 * 明文状态是组件内部 state：两个消费方都条件挂载（对话框开才渲染），
 * 重开对话框自然重置，无需外部传 reset 信号。
 */

export interface EnvRow {
  key: string
  value: string
}

export interface EnvRowsEditorTexts {
  keyPh: string          // key 输入框占位符，如 "KEY"
  valuePh: string        // value 输入框占位符，如 "value"
  addRow: string         // 添加行按钮文案（组件内拼 "+ " 前缀），如 "添加变量"
  deleteTitle: string    // 删行按钮 title
  showValue: string      // 明文按钮 title（当前打码，点击查看）
  hideValue: string      // 明文按钮 title（当前明文，点击隐藏）
}

interface EnvRowsEditorProps {
  value: EnvRow[]
  onChange: (rows: EnvRow[]) => void
  texts: EnvRowsEditorTexts
  /** key 被编辑时的回调（HarnessPanel 用于复位「尝试提交」态） */
  onKeyChange?: () => void
}

/** 明文查看敏感 env 值（默认打码，点击切换） */
const IconEye: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </svg>
)

const IconEyeOff: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.6 5.1C1.7 6.2 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.2 0 2.2-.3 3-.8M6.7 3.7c.4-.1.8-.2 1.3-.2 4 0 6.5 4.5 6.5 4.5s-.6 1.1-1.6 2.1" />
    <path d="M2.5 13.5l11-11" />
  </svg>
)

const IconX: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 2l7 7M9 2l-7 7" /></svg>
)

const EnvRowsEditor: React.FC<EnvRowsEditorProps> = ({ value, onChange, texts, onKeyChange }) => {
  // 明文行号集合（仅敏感行有意义）；行号与 value 一一对应，删行时前移修正
  const [revealed, setRevealed] = useState<Set<number>>(new Set())

  const addRow = () => onChange([...value, { key: '', value: '' }])
  const updateRow = (i: number, field: 'key' | 'value', v: string) => {
    onChange(value.map((row, idx) => (idx === i ? { ...row, [field]: v } : row)))
    // 改 key 即复位该行的明文状态：改名前后是不是敏感值可能不同，保证「默认打码」语义
    if (field === 'key') {
      setRevealed((prev) => {
        const next = new Set(prev)
        next.delete(i)
        return next
      })
      onKeyChange?.()
    }
  }
  const removeRow = (i: number) => {
    onChange(value.filter((_, idx) => idx !== i))
    // 行号前移同步修正，避免「明文」状态串到别的行
    setRevealed((prev) => {
      const next = new Set<number>()
      for (const idx of prev) {
        if (idx < i) next.add(idx)
        else if (idx > i) next.add(idx - 1)
      }
      return next
    })
  }
  const toggleReveal = (i: number) =>
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  return (
    <div className="bg-[var(--bg-base)] border border-[var(--rule)] rounded-sm overflow-hidden">
      {value.length === 0 ? (
        <button
          onClick={addRow}
          className="w-full text-left py-1.5 px-2.5 text-[11.5px] [font-family:inherit] text-[var(--text-rack-data)] hover:text-[var(--amber)] hover:bg-[var(--bg-slot)] transition-colors"
        >
          + {texts.addRow}
        </button>
      ) : (
        <>
          {value.map((row, i) => {
            // 敏感值(API key/token)默认打码:用 -webkit-text-security 而非 type=password,
            // 免去 Chromium 自带的「小眼睛」,明文切换只走右侧按钮
            const secret = isSecretEnvKey(row.key)
            const isRevealed = revealed.has(i)
            return (
              <div key={i} className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--rule-soft)] last:border-b-0">
                <input
                  type="text"
                  value={row.key}
                  onChange={(e) => updateRow(i, 'key', e.target.value)}
                  placeholder={texts.keyPh}
                  className="flex-1 min-w-0 bg-transparent border-none text-[12px] [font-family:inherit] text-[var(--amber)] placeholder:text-[var(--text-rack-data)] focus:outline-none"
                />
                <span className="text-[var(--text-rack-mute)] [font-family:inherit] text-[12px] select-none">=</span>
                <input
                  type="text"
                  value={row.value}
                  onChange={(e) => updateRow(i, 'value', e.target.value)}
                  placeholder={texts.valuePh}
                  className={cn(
                    'flex-[2] min-w-0 bg-transparent border-none text-[12px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] focus:outline-none',
                    secret && !isRevealed && '[-webkit-text-security:disc]'
                  )}
                />
                {secret && (
                  <button
                    onClick={() => toggleReveal(i)}
                    title={isRevealed ? texts.hideValue : texts.showValue}
                    className="w-[18px] h-[18px] flex-shrink-0 inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] text-[var(--text-rack-faint)] hover:text-[var(--amber)] transition-colors"
                  >
                    {isRevealed ? <IconEyeOff /> : <IconEye />}
                  </button>
                )}
                <button
                  onClick={() => removeRow(i)}
                  title={texts.deleteTitle}
                  className="w-[18px] h-[18px] flex-shrink-0 inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] text-[var(--text-rack-faint)] hover:text-[var(--error-rack)] transition-colors"
                >
                  <IconX />
                </button>
              </div>
            )
          })}
          <button
            onClick={addRow}
            className="w-full text-left py-1.5 px-2.5 text-[11.5px] [font-family:inherit] text-[var(--text-rack-data)] hover:text-[var(--amber)] hover:bg-[var(--bg-slot)] transition-colors"
          >
            + {texts.addRow}
          </button>
        </>
      )}
    </div>
  )
}

export default EnvRowsEditor
