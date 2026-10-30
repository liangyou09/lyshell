// 仅创建独立临时 profile；比较 webview 失败单独记录，不放宽产品安全策略。
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const root = path.resolve(__dirname, '..')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const reportFile = path.join(root, 'tmp/browser-host-smoke/result.json')
if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile)
const result = spawnSync(require('electron'), [path.join(__dirname, 'remediation-browser-host-smoke.cjs')],
  { cwd: root, env, stdio: 'inherit', timeout: 45000, windowsHide: true })
if (result.error) console.error(result.error.message)
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null
console.log(JSON.stringify(report))
process.exitCode = result.status === 0 && report?.ok === true ? 0 : 1
