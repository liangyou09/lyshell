import React, { useState } from 'react'

interface QuickInputBarProps {}

/**
 * 快速输入栏组件（固定在浮窗底部）
 */
const QuickInputBar: React.FC<QuickInputBarProps> = () => {
  const [command, setCommand] = useState('')
  const [targetSession, setTargetSession] = useState<string>('current')
  const [_showDropdown, setShowDropdown] = useState(false)
  const [historyDropdown, setHistoryDropdown] = useState(false)

  // 模拟历史命令
  const commandHistory = [
    'systemctl status nginx',
    'docker ps -a',
    'ls -la',
    'cd /var/log && tail -100 syslog'
  ]

  // 执行命令
  const handleExecute = () => {
    if (!command.trim()) return

    console.log('Execute:', command, 'to', targetSession)
    // TODO: 发送到主进程执行
    // window.electronAPI?.pythonExecute(command)

    // 清空输入
    setCommand('')
    setHistoryDropdown(false)
  }

  return (
    <div className="border-t border-[#3C3C3C] bg-[#1E1E1E] p-2">
      {/* 目标会话选择 */}
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="text-gray-400">目标:</span>
        <select
          value={targetSession}
          onChange={(e) => setTargetSession(e.target.value)}
          className="px-2 py-1 bg-[#3C3C3C] border border-[#555] rounded text-white text-xs focus:outline-none focus:border-[#0078D4]"
        >
          <option value="current">当前终端 (prod-01)</option>
          <option value="dev-02">开发服务器 (dev-02)</option>
          <option value="router">路由器串口</option>
          <option value="new">+ 新建会话</option>
        </select>
      </div>

      {/* 命令输入 */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onFocus={() => setShowDropdown(true)}
            onBlur={() => setTimeout(() => {
              setShowDropdown(false)
              setHistoryDropdown(false)
            }, 200)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleExecute()
              } else if (e.key === 'ArrowDown') {
                setHistoryDropdown(true)
              } else if (e.key === 'Escape') {
                setCommand('')
                setHistoryDropdown(false)
              }
            }}
            placeholder="输入命令或搜索..."
            className="w-full px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
          />
          <button
            onClick={() => setHistoryDropdown(!historyDropdown)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
          >
            ▼
          </button>

          {/* 历史下拉 */}
          {historyDropdown && (
            <div className="absolute left-0 right-0 top-full mt-1 bg-[#2D2D30] border border-[#555] rounded shadow-lg z-10 overflow-hidden">
              {commandHistory.map((cmd, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setCommand(cmd)
                    setHistoryDropdown(false)
                  }}
                  className="w-full px-3 py-1.5 text-sm text-white hover:bg-[#3C3C3C] truncate"
                >
                  {cmd}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 执行按钮 */}
        <button
          onClick={handleExecute}
          className="px-3 py-1.5 bg-[#0078D4] text-white rounded text-sm hover:bg-[#006CBD] transition-colors"
        >
          ▶ 执行
        </button>

        {/* 复制按钮 */}
        <button
          onClick={() => navigator.clipboard.writeText(command)}
          className="px-2 py-1.5 text-gray-400 hover:text-white transition-colors"
          title="复制"
        >
          📋
        </button>

        {/* 收藏按钮 */}
        <button
          className="px-2 py-1.5 text-gray-400 hover:text-white transition-colors"
          title="收藏"
        >
          ⭐
        </button>
      </div>

      {/* 提示 */}
      <div className="text-xs text-gray-500 mt-1">
        Enter 执行 | Shift+Enter 多行 | ↑↓ 历史 | Esc 取消
      </div>
    </div>
  )
}

export default QuickInputBar