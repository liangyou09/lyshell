import React, { useState, useEffect } from 'react'

interface AgentConfig {
  id: string
  name: string
  command: string
  icon?: string
  cwd?: string
  env?: Record<string, string>
  order: number
}

interface AgentBarProps {
  onLaunchAgent: (agentId: string) => void
}

const AgentBar: React.FC<AgentBarProps> = ({ onLaunchAgent }) => {
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [showDialog, setShowDialog] = useState(false)
  const [editAgent, setEditAgent] = useState<AgentConfig | undefined>(undefined)
  const [newName, setNewName] = useState('')
  const [newCommand, setNewCommand] = useState('')
  const [newIcon, setNewIcon] = useState('')
  const [newCwd, setNewCwd] = useState('')

  useEffect(() => {
    loadAgents()
  }, [])

  const loadAgents = async () => {
    try {
      const result = await window.electronAPI?.listAgents()
      if (result && Array.isArray(result)) {
        setAgents(result)
      }
    } catch (err) {
      console.error('Failed to load agents:', err)
    }
  }

  const handleLaunch = (agent: AgentConfig) => {
    onLaunchAgent(agent.id)
  }

  const handleContextMenu = (agent: AgentConfig, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setEditAgent(agent)
    setNewName(agent.name)
    setNewCommand(agent.command)
    setNewIcon(agent.icon || '')
    setNewCwd(agent.cwd || '')
    setShowDialog(true)
  }

  const handleAdd = () => {
    setEditAgent(undefined)
    setNewName('')
    setNewCommand('')
    setNewIcon('')
    setNewCwd('')
    setShowDialog(true)
  }

  const handleSave = async () => {
    if (!newName.trim() || !newCommand.trim()) return

    if (editAgent) {
      await window.electronAPI?.updateAgent({
        ...editAgent,
        name: newName.trim(),
        command: newCommand.trim(),
        icon: newIcon || undefined,
        cwd: newCwd || undefined
      })
    } else {
      await window.electronAPI?.addAgent({
        name: newName.trim(),
        command: newCommand.trim(),
        icon: newIcon || undefined,
        cwd: newCwd || undefined,
        order: agents.length
      })
    }

    await loadAgents()
    setShowDialog(false)
  }

  const handleDelete = async () => {
    if (editAgent) {
      await window.electronAPI?.deleteAgent(editAgent.id)
      await loadAgents()
      setShowDialog(false)
    }
  }

  if (agents.length === 0) return null

  return (
    <>
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[#3C3C3C] bg-[#252526]">
        <span className="text-xs text-gray-500 mr-1">Agent</span>
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-thin flex-1 min-w-0">
          {agents.map(agent => (
            <button
              key={agent.id}
              onClick={() => handleLaunch(agent)}
              onContextMenu={(e) => handleContextMenu(agent, e)}
              className="flex items-center gap-1 px-2 py-0.5 text-xs whitespace-nowrap flex-shrink-0 bg-[#3C3C3C] text-gray-300 hover:bg-[#555] hover:text-white cursor-pointer transition-colors rounded"
              title={`${agent.name}: ${agent.command}`}
            >
              {agent.icon && <span>{agent.icon}</span>}
              <span>{agent.name}</span>
            </button>
          ))}
        </div>
        <button
          onClick={handleAdd}
          title="添加 Agent"
          className="w-[20px] h-[20px] flex items-center justify-center text-gray-500 hover:text-white hover:bg-[#555] rounded text-xs flex-shrink-0"
        >
          +
        </button>
      </div>

      {/* Agent 编辑对话框 */}
      {showDialog && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-[#2D2D30] rounded-lg shadow-xl w-[380px] p-4">
            <div className="text-sm text-white font-medium mb-3">
              {editAgent ? '编辑 Agent' : '添加 Agent'}
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-16 shrink-0">名称</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Claude Code"
                  autoFocus
                  className="flex-1 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-16 shrink-0">命令</label>
                <input
                  type="text"
                  value={newCommand}
                  onChange={(e) => setNewCommand(e.target.value)}
                  placeholder="claude"
                  className="flex-1 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-16 shrink-0">图标</label>
                <input
                  type="text"
                  value={newIcon}
                  onChange={(e) => setNewIcon(e.target.value)}
                  placeholder="🤖"
                  className="w-16 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                />
                <label className="text-xs text-gray-400 w-16 shrink-0">工作目录</label>
                <input
                  type="text"
                  value={newCwd}
                  onChange={(e) => setNewCwd(e.target.value)}
                  placeholder="可选"
                  className="flex-1 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                {editAgent && (
                  <button
                    onClick={handleDelete}
                    className="px-3 py-1 text-sm text-red-400 hover:text-red-300 transition-colors"
                  >
                    删除
                  </button>
                )}
                <button
                  onClick={() => setShowDialog(false)}
                  className="px-3 py-1 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSave}
                  className="px-3 py-1 text-sm bg-[#0078D4] text-white rounded hover:bg-[#006CBD] transition-colors"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default AgentBar
