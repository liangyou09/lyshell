const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const fixture = process.argv.includes('--architecture') ? 'architecture-electron-smoke.cjs' : 'remediation-electron-smoke.cjs'
const resultFile = path.join(__dirname, '..', process.argv.includes('--architecture')
  ? 'tmp/architecture/electron-integration-result.json' : 'tmp/remediation-smoke/electron-result.json')
if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile)
const result = spawnSync(require('electron'), [path.join(__dirname, fixture)], { env, stdio: 'inherit', timeout: 60000 })
if (result.error) console.error(result.error.message)
const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null
process.exitCode = result.status === 0 && report?.ok === true ? 0 : 1
