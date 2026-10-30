'use strict'
// 使用普通 Node 运行；主脚本仅启动 Electron run-as-node，不创建窗口。
const { runOuter } = require('./remediation-windows-command-smoke.cjs')
runOuter().then(code => { process.exitCode = code }, error => {
  console.error(String(error?.message || error))
  process.exitCode = 1
})
