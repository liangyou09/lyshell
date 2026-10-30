// 为单条 Node 验证命令保存完整 stdout/stderr、HEAD、命令与真实退出码。
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const root = path.resolve(__dirname, '..')
const output = path.join(root, 'docs/validation/2026-10-30-remediation')
const label = process.argv[2]
const args = process.argv.slice(3)
if (!label || !args.length || !/^[a-z0-9-]+$/.test(label)) throw Error('Expected label and node script arguments')
fs.mkdirSync(output, { recursive: true })
const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const start = new Date().toISOString()
const stream = fs.openSync(path.join(output, `${label}.log`), 'w')
const child = cp.spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', stream, stream] })
let spawnError
child.on('error', error => { spawnError = error.code || 'SPAWN_FAILED' })
child.on('close', (code, signal) => {
  fs.closeSync(stream)
  const result = { head, command: ['node', ...args], start, end: new Date().toISOString(), exitCode: code, signal, spawnError }
  fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ label, ...result }))
  console.log(fs.readFileSync(path.join(output, `${label}.log`), 'utf8').slice(-12000))
  process.exitCode = code ?? 1
})
