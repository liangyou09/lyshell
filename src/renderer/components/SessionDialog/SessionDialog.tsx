import React, { useState, useEffect } from 'react'
import type { SessionConfig } from '@shared/types'
import { ConnectionType } from '@shared/types'
import { DEFAULT_THEME_DARK } from '@shared/constants'

interface SessionDialogProps {
  open: boolean
  onClose: () => void
  onSubmit: (config: SessionConfig) => void
  initialConfig?: SessionConfig
}

const SessionDialog: React.FC<SessionDialogProps> = ({
  open,
  onClose,
  onSubmit,
  initialConfig
}) => {
  const [name, setName] = useState('')
  const [type, setType] = useState<ConnectionType>(ConnectionType.SSH)
  const [tags, setTags] = useState('')
  const [startupCommands, setStartupCommands] = useState('')

  // SSH 配置
  const [sshHost, setSshHost] = useState('')
  const [sshPort, setSshPort] = useState('22')
  const [sshUser, setSshUser] = useState('')
  const [sshPassword, setSshPassword] = useState('')
  const [sshPrivateKey, setSshPrivateKey] = useState('')
  const [sshShellEnterCommands, setSshShellEnterCommands] = useState('')
  const [sshShellEnterWait, setSshShellEnterWait] = useState('1000')

  // Telnet 配置
  const [telnetHost, setTelnetHost] = useState('')
  const [telnetPort, setTelnetPort] = useState('23')

  // Serial 配置
  const [serialPath, setSerialPath] = useState('COM1')
  const [serialBaudRate, setSerialBaudRate] = useState('9600')

  // 终端配置
  const [encoding, setEncoding] = useState<'utf-8' | 'gbk' | 'gb2312'>('utf-8')

  // 检测是否像IP地址（边输入边检测，支持部分IP和末尾的点）
  const isIPLike = (text: string): boolean => {
    // 匹配正在输入的IP格式: 数字.数字... 或带端口，末尾可以有待输入的点
    // 例如: 192, 192., 192.168, 192.168., 192.168.1, 192.168.1.1, 192.168.1.1:22
    const ipPattern = /^(\d{1,3}(\.\d{1,3}){0,3}\.?)(:(\d+))?$/
    return ipPattern.test(text.trim())
  }

  // 处理名称变化，自动填充IP到主机地址（边输入边填充）
  const handleNameChange = (value: string) => {
    setName(value)

    // 只在新建模式（无 initialConfig）时自动填充
    if (!initialConfig) {
      const trimmed = value.trim()
      if (isIPLike(trimmed)) {
        // 提取IP部分（去掉端口）
        // 同步显示输入进度，包括末尾的点（用户正在输入）
        const ipMatch = trimmed.match(/^(\d{1,3}(\.\d{1,3}){0,3}\.?)/)
        const portMatch = trimmed.match(/:(\d+)$/)

        if (ipMatch) {
          const host = ipMatch[1]  // 保留末尾的点，实时同步显示
          const port = portMatch ? portMatch[1] : null

          if (type === ConnectionType.SSH) {
            setSshHost(host)
            if (port) setSshPort(port)
          } else if (type === ConnectionType.TELNET) {
            setTelnetHost(host)
            if (port) setTelnetPort(port)
          }
        }
      }
      // 注意：不再匹配IP格式时不清空主机地址，避免输入过程中清空
      // 用户可以手动修改主机地址
    }
  }

  // 当 initialConfig 变化时更新状态
  useEffect(() => {
    if (initialConfig) {
      setName(initialConfig.name || '')
      setType(initialConfig.type || ConnectionType.SSH)
      setTags(initialConfig.tags?.join(', ') || '')
      setStartupCommands(initialConfig.startupCommands?.join('\n') || '')
      setSshHost(initialConfig.ssh?.host || '')
      setSshPort(initialConfig.ssh?.port?.toString() || '22')
      setSshUser(initialConfig.ssh?.username || '')
      setSshPassword(initialConfig.ssh?.password || '')
      setSshPrivateKey(initialConfig.ssh?.privateKey || '')
      setSshShellEnterCommands(initialConfig.ssh?.shellEnterCommands || '')
      setSshShellEnterWait(initialConfig.ssh?.shellEnterWait?.toString() || '1000')
      setTelnetHost(initialConfig.telnet?.host || '')
      setTelnetPort(initialConfig.telnet?.port?.toString() || '23')
      setSerialPath(initialConfig.serial?.path || 'COM1')
      setSerialBaudRate(initialConfig.serial?.baudRate?.toString() || '9600')
      setEncoding(initialConfig.terminal?.encoding || 'utf-8')
    } else {
      // 新建时清空
      setName('')
      setType(ConnectionType.SSH)
      setTags('')
      setStartupCommands('')
      setSshHost('')
      setSshPort('22')
      setSshUser('')
      setSshPassword('')
      setSshPrivateKey('')
      setSshShellEnterCommands('')
      setSshShellEnterWait('1000')
      setTelnetHost('')
      setTelnetPort('23')
      setSerialPath('COM1')
      setSerialBaudRate('9600')
      setEncoding('utf-8')
    }
  }, [initialConfig, open])

  if (!open) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    // 如果名称为空，默认使用IP地址
    let sessionName = name.trim()
    if (!sessionName) {
      if (type === ConnectionType.SSH) {
        sessionName = sshHost
      } else if (type === ConnectionType.TELNET) {
        sessionName = telnetHost
      } else if (type === ConnectionType.SERIAL) {
        sessionName = serialPath
      }
    }

    const config: SessionConfig = {
      id: initialConfig?.id || Date.now().toString(),
      name: sessionName,
      type,
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
      startupCommands: startupCommands.split('\n').filter(Boolean),
      terminal: {
        ...initialConfig?.terminal || {
          fontSize: 14,
          fontFamily: 'Consolas, Monaco, monospace',
          theme: DEFAULT_THEME_DARK,
          cursorStyle: 'block',
          cursorBlink: true,
          scrollback: 10000
        },
        encoding: encoding
      },
      createdAt: initialConfig?.createdAt || new Date(),
      updatedAt: new Date()
    }

    if (type === ConnectionType.SSH) {
      config.ssh = {
        host: sshHost.replace(/\.$/, ''),  // 去掉末尾的点
        port: parseInt(sshPort) || 22,
        username: sshUser,
        password: sshPassword || undefined,
        privateKey: sshPrivateKey || undefined,
        shellEnterCommands: sshShellEnterCommands || undefined,
        shellEnterWait: parseInt(sshShellEnterWait) || undefined,
      }
    } else if (type === ConnectionType.TELNET) {
      config.telnet = {
        host: telnetHost.replace(/\.$/, ''),  // 去掉末尾的点
        port: parseInt(telnetPort) || 23,
      }
    } else if (type === ConnectionType.SERIAL) {
      config.serial = {
        path: serialPath,
        baudRate: parseInt(serialBaudRate) || 9600,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
      }
    }

    onSubmit(config)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#2D2D30] rounded-lg shadow-xl w-[420px] overflow-hidden">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#3C3C3C]">
          <span className="text-white font-medium">
            {initialConfig ? '编辑会话' : '新建会话'}
          </span>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>

        {/* 表单 */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* 基本信息 */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400 w-16 shrink-0">会话名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="留空则使用IP"
              className="flex-1 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
            />
            <label className="text-xs text-gray-400 w-10 shrink-0">类型</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as ConnectionType)}
              className="w-20 px-2 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white focus:outline-none focus:border-[#0078D4]"
            >
              <option value={ConnectionType.SSH}>SSH</option>
              <option value={ConnectionType.TELNET}>Telnet</option>
              <option value={ConnectionType.SERIAL}>Serial</option>
            </select>
          </div>

          {/* SSH 配置 */}
          {type === ConnectionType.SSH && (
            <div className="space-y-3 pt-2 border-t border-[#3C3C3C]">
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-16 shrink-0">主机地址</label>
                <input
                  type="text"
                  value={sshHost}
                  onChange={(e) => setSshHost(e.target.value)}
                  placeholder="192.168.1.1"
                  className="flex-1 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                  required
                />
                <label className="text-xs text-gray-400 w-10 shrink-0">端口</label>
                <input
                  type="number"
                  value={sshPort}
                  onChange={(e) => setSshPort(e.target.value)}
                  placeholder="22"
                  className="w-20 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-16 shrink-0">用户名</label>
                <input
                  type="text"
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                  placeholder="root"
                  className="flex-1 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                  required
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-16 shrink-0">密码</label>
                <input
                  type="password"
                  value={sshPassword}
                  onChange={(e) => setSshPassword(e.target.value)}
                  placeholder="••••••••"
                  className="flex-1 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                />
              </div>

              <div className="flex items-start gap-2">
                <label className="text-xs text-gray-400 w-16 shrink-0 pt-1.5">Shell命令</label>
                <textarea
                  value={sshShellEnterCommands}
                  onChange={(e) => setSshShellEnterCommands(e.target.value)}
                  placeholder="进入Shell的命令，多行每行一个"
                  rows={2}
                  className="flex-1 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4] resize-none"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-16 shrink-0">私钥路径</label>
                <input
                  type="text"
                  value={sshPrivateKey}
                  onChange={(e) => setSshPrivateKey(e.target.value)}
                  placeholder="可选"
                  className="flex-1 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                />
                <label className="text-xs text-gray-400 w-10 shrink-0">等待</label>
                <input
                  type="number"
                  value={sshShellEnterWait}
                  onChange={(e) => setSshShellEnterWait(e.target.value)}
                  placeholder="1000"
                  className="w-20 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                />
              </div>
            </div>
          )}

          {/* Telnet 配置 */}
          {type === ConnectionType.TELNET && (
            <div className="space-y-3 pt-2 border-t border-[#3C3C3C]">
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-16 shrink-0">主机地址</label>
                <input
                  type="text"
                  value={telnetHost}
                  onChange={(e) => setTelnetHost(e.target.value)}
                  placeholder="192.168.1.1"
                  className="flex-1 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                  required
                />
                <label className="text-xs text-gray-400 w-10 shrink-0">端口</label>
                <input
                  type="number"
                  value={telnetPort}
                  onChange={(e) => setTelnetPort(e.target.value)}
                  placeholder="23"
                  className="w-20 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                />
              </div>
            </div>
          )}

          {/* Serial 配置 */}
          {type === ConnectionType.SERIAL && (
            <div className="space-y-3 pt-2 border-t border-[#3C3C3C]">
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-16 shrink-0">串口路径</label>
                <input
                  type="text"
                  value={serialPath}
                  onChange={(e) => setSerialPath(e.target.value)}
                  placeholder="COM1"
                  className="flex-1 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                  required
                />
                <label className="text-xs text-gray-400 w-10 shrink-0">波特率</label>
                <select
                  value={serialBaudRate}
                  onChange={(e) => setSerialBaudRate(e.target.value)}
                  className="w-20 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white focus:outline-none focus:border-[#0078D4]"
                >
                  <option value="9600">9600</option>
                  <option value="19200">19200</option>
                  <option value="38400">38400</option>
                  <option value="57600">57600</option>
                  <option value="115200">115200</option>
                </select>
              </div>
            </div>
          )}

          {/* 其他设置 */}
          <div className="space-y-3 pt-2 border-t border-[#3C3C3C]">
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400 w-16 shrink-0">编码</label>
              <select
                value={encoding}
                onChange={(e) => setEncoding(e.target.value as 'utf-8' | 'gbk' | 'gb2312')}
                className="flex-1 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white focus:outline-none focus:border-[#0078D4]"
              >
                <option value="utf-8">UTF-8</option>
                <option value="gbk">GBK</option>
                <option value="gb2312">GB2312</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400 w-16 shrink-0">标签</label>
              <input
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="逗号分隔，如: favorite, production"
                className="flex-1 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
              />
            </div>

            <div className="flex items-start gap-2">
              <label className="text-xs text-gray-400 w-16 shrink-0 pt-1.5">自动执行</label>
              <textarea
                value={startupCommands}
                onChange={(e) => setStartupCommands(e.target.value)}
                placeholder="每行一条命令，如:&#10;cd /var/www&#10;ls -la"
                rows={3}
                className="flex-1 px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4] resize-none"
              />
            </div>
          </div>

          {/* 按钮 */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 text-sm bg-[#0078D4] text-white rounded hover:bg-[#006CBD] transition-colors"
            >
              {initialConfig ? '保存' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default SessionDialog