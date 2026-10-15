// 目标配置 —— 换目录/换 shell 只改这里（CSP 限制 script-src 'self'，必须是 views/ 下的外部文件）。
window.LAUNCHER_CONFIG = {
  // 保存会话名（list_sessions 按此名查找复用；改名会另建一条）
  sessionName: 'LyShell 源码 PS7',
  // PowerShell 7；LocalConnector 的 resolveShell('pwsh') 会解析到 pwsh.exe
  shell: 'pwsh',
  // LyShell 源码目录
  cwd: 'D:\\workspace\\claude\\LyShell',
  tags: ['dev', 'lyshell', 'ps7'],
  summary: 'LyShell 源码目录的 PowerShell 7 开发终端'
}
