'use strict'
// 独立 Windows Job 烟测。外层普通 Node 监视 Electron 的 Node 模式，不启动应用或 GUI。
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const evidenceRoot = path.join(root, 'tmp', 'windows-command-smoke')
const corePath = path.join(evidenceRoot, 'core.cjs')
const workerPath = path.join(root, 'dist', 'main', 'localCommandWorker.js')
const MAX_LOG_BYTES = 64 * 1024
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const errorRecord = error => ({ name: error?.name || 'Error', message: String(error?.message || error).slice(0, 512), code: error?.code, reason: error?.reason, retryDisposition: error?.retryDisposition, partialOutput: typeof error?.partialOutput === 'string' ? error.partialOutput.slice(0, 512) : undefined })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function assert(value, message) { if (!value) throw new Error(message) }
function within(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target))
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)
}
function runtimeEnvironment() {
  // 不继承 NODE_OPTIONS、token、APPDATA 或用户 profile 变量；只保留启动 Win32/Node 所需项。
  const names = new Set(['systemroot', 'windir', 'comspec', 'path', 'pathext', 'temp', 'tmp', 'processor_architecture'])
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (names.has(key.toLowerCase()) && typeof value === 'string') env[key] = value
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}
function quoteCommandArgument(value) {
  assert(typeof value === 'string' && !/["\r\n%!\0]/.test(value), 'Fixture path cannot be represented safely in cmd.exe')
  return '"' + value + '"'
}
function pidState(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'Invalid fixture PID')
  try { process.kill(pid, 0); return { pid, state: 'alive' } }
  catch (error) { return { pid, state: error.code === 'ESRCH' ? 'absent' : 'unknown', errorCode: error.code } }
}
const fixtureSource = [
  "'use strict'",
  "const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process')",
  "const [mode, dir, nonce] = process.argv.slice(2)",
  "function main() {",
  "  if (mode === 'output') { process.stdout.write('标准输出：中文\\n', () => process.stderr.write('标准错误：中文\\n', () => process.exit(7))); return }",
  "  if (mode === 'aborted') { fs.writeFileSync(path.join(dir, 'pre-abort-marker.txt'), nonce); return }",
  "  if (!['tree-root', 'tree-child', 'tree-grandchild'].includes(mode)) throw Error('Unknown fixture mode')",
  "  fs.writeFileSync(path.join(dir, mode + '.json'), JSON.stringify({ role: mode, nonce, pid: process.pid, parentPid: process.ppid }))",
  "  if (mode !== 'tree-grandchild') {",
  "    const next = mode === 'tree-root' ? 'tree-child' : 'tree-grandchild'",
  "    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE",
  "    const child = cp.spawn(process.execPath, [__filename, next, dir, nonce], { env, stdio: 'ignore', detached: true, windowsHide: true })",
  "    child.on('error', error => { fs.writeFileSync(path.join(dir, mode + '-spawn-error.json'), JSON.stringify({ code: error.code })); process.exit(9) })",
  "    child.unref()",
  "  }",
  "  setInterval(() => {}, 1000)",
  "}",
  "main()"
].join('\n')
async function runInner(runDir, nodePath, nonce) {
  assert(process.platform === 'win32' && process.arch === 'x64', 'This smoke requires Windows x64')
  const expectedElectron = require(path.join(root, 'package.json')).devDependencies.electron
  assert(process.versions.electron === expectedElectron, 'Smoke must use the pinned Electron runtime in Node mode')
  assert(within(evidenceRoot, runDir), 'Smoke run directory escaped its temporary evidence root')
  assert(path.isAbsolute(nodePath) && fs.existsSync(nodePath), 'System Node executable is required for fixtures')
  // 原生模块只在 Electron 进程中加载；不通过开发机 Node ABI 验证后冒充产品运行时。
  require('koffi')
  const { createWindowsCommandExecution } = require(corePath)
  const fixture = path.join(runDir, 'fixture.cjs')
  fs.writeFileSync(fixture, fixtureSource)
  const command = mode => [nodePath, fixture, mode, runDir, nonce].map(quoteCommandArgument).join(' ')
  const report = {
    ok: false, nonce, startedAt: new Date().toISOString(), runnerPid: process.pid,
    platform: process.platform, arch: process.arch, electron: process.versions.electron,
    node: process.versions.node, modulesAbi: process.versions.modules, koffiLoadedInElectron: true,
    workerPath, workerSha256: sha256(workerPath), coreSha256: sha256(corePath), cases: []
  }
  const active = new Set()
  // helper 退出后的 Job 查询使用 unref timer；烟测自身保持事件循环直到关闭证据收齐。
  const keepalive = setInterval(() => {}, 200)
  async function execute(name, options) {
    const handle = createWindowsCommandExecution({ cwd: runDir, treeSettleMs: 100, terminationConfirmMs: 3000, ...options }, { workerScriptPath: workerPath })
    active.add(handle)
    // 立即观察结果拒绝；它可能早于 resourceClosed。
    const observedResult = handle.result.then(value => ({ state: 'fulfilled', value }), error => ({ state: 'rejected', error: errorRecord(error) }))
    const result = await observedResult
    const resultAt = new Date().toISOString()
    const resourceClosed = await handle.resourceClosed
    const row = { name, result, reason: result.error?.reason, resultAt, resourceClosed, resourceClosedAt: new Date().toISOString() }
    report.cases.push(row)
    if (resourceClosed.state === 'closed') active.delete(handle)
    return row
  }
  function requireClosed(row, remote) {
    assert(row.resourceClosed.state === 'closed' && row.resourceClosed.localClosed === true && row.resourceClosed.remoteTerminated === remote, row.name + ': native resource closure was not confirmed')
  }
  try {
    const normal = await execute('utf8-and-exit-seven', { command: command('output'), timeoutMs: 5000 })
    requireClosed(normal, 'confirmed')
    assert(normal.result.state === 'fulfilled' && normal.result.value.exitCode === 7, 'The real command did not preserve exit code 7')
    assert(normal.result.value.output.includes('标准输出：中文') && normal.result.value.output.includes('标准错误：中文'), 'Chinese stdout/stderr did not survive UTF-8 collection')
    normal.checks = { chineseStdout: true, chineseStderr: true, actualExitCode: 7 }

    const timed = await execute('timeout-background-descendants', { command: command('tree-root'), timeoutMs: 3000 })
    assert(timed.result.state === 'rejected' && timed.result.error.code === 'OUTCOME_UNKNOWN' && timed.result.error.reason === 'COMMAND_TIMEOUT', 'The real command did not produce its timeout outcome')
    requireClosed(timed, 'confirmed')
    timed.backgroundPids = ['tree-root', 'tree-child', 'tree-grandchild'].map(role => {
      const file = path.join(runDir, role + '.json')
      assert(fs.existsSync(file), role + ': PID fixture did not start before the deadline')
      const record = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert(record.nonce === nonce && record.role === role, 'PID evidence belongs to a different smoke run')
      return { role, ...pidState(record.pid), parentPid: record.parentPid }
    })
    assert(timed.backgroundPids.every(record => record.state === 'absent'), 'A fixture PID remained alive or unknown after resourceClosed')

    const aborted = new AbortController(); aborted.abort()
    const beforeStart = await execute('pre-abort-no-dispatch', { command: command('aborted'), timeoutMs: 3000, signal: aborted.signal })
    assert(beforeStart.result.state === 'rejected', 'A pre-aborted command unexpectedly completed')
    requireClosed(beforeStart, 'not-dispatched')
    await delay(150)
    beforeStart.markerExists = fs.existsSync(path.join(runDir, 'pre-abort-marker.txt'))
    assert(!beforeStart.markerExists, 'The pre-aborted command wrote its side-effect marker')
    report.ok = true
  } catch (error) { report.error = errorRecord(error) }
  finally {
    for (const handle of active) { try { handle.cancel('shutdown') } catch { /* 外层仍按本次 runner PID 收尾。 */ } }
    clearInterval(keepalive)
    report.endedAt = new Date().toISOString()
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2))
  }
  return report.ok ? 0 : 1
}
async function runOuter() {
  assert(!process.versions.electron, 'Run this wrapper with system Node; it launches Electron Node mode itself')
  assert(process.platform === 'win32' && process.arch === 'x64', 'This smoke requires Windows x64')
  fs.mkdirSync(evidenceRoot, { recursive: true })
  const runDir = fs.mkdtempSync(path.join(evidenceRoot, 'run-'))
  assert(within(evidenceRoot, runDir), 'Invalid temporary smoke directory')
  const nonce = crypto.randomUUID()
  const metadata = { nonce, runDir, startedAt: new Date().toISOString(), sourceSha256: sha256(path.join(root, 'src/main/commands/windows-command-execution.ts')) }
  try {
    assert(fs.existsSync(workerPath), 'Build dist/main/localCommandWorker.js before running this smoke')
    require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/main/commands/windows-command-execution.ts')], outfile: corePath, bundle: true, platform: 'node', format: 'cjs', target: 'node22', tsconfig: path.join(root, 'tsconfig.node.json'), external: ['koffi'], logLevel: 'silent' })
    const electron = require('electron')
    const child = spawn(electron, [__filename, '--electron-runner', runDir, process.execPath, nonce], { cwd: root, env: runtimeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const outcome = await new Promise(resolve => {
      let exited = false, settled = false, stopping = false, failure, timedOut = false, cleanup
      const logs = { stdout: '', stderr: '' }
      let cleanupDeadline
      const finish = (exitCode, signal) => {
        if (settled) return
        settled = true
        clearTimeout(watchdog); clearTimeout(cleanupDeadline)
        for (const key of ['stdout', 'stderr']) fs.writeFileSync(path.join(runDir, key + '.log'), logs[key])
        resolve({ pid: child.pid, exitCode, signal, timedOut, failure, cleanup })
      }
      const stop = reason => {
        if (settled || stopping) return
        stopping = true
        failure ||= reason
        // 只能清理本次 spawn 返回且尚未 exit 的 PID，绝不枚举或清理共享应用/后台。
        if (!exited && Number.isSafeInteger(child.pid) && child.pid > 0) {
          const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 4000, encoding: 'utf8', env: runtimeEnvironment() })
          cleanup = { targetPid: child.pid, taskkillExitCode: killed.status, errorCode: killed.error?.code }
          if (!exited) { try { child.kill() } catch { /* 记录未确认，不能扩大清理目标。 */ } }
        }
        cleanupDeadline = setTimeout(() => {
          child.stdout?.destroy(); child.stderr?.destroy(); child.unref()
          finish(null, null)
        }, 4000)
      }
      const watchdog = setTimeout(() => { timedOut = true; stop('Independent 30-second smoke watchdog expired') }, 30000)
      for (const key of ['stdout', 'stderr']) child[key].on('data', buffer => {
        if (Buffer.byteLength(logs[key]) + buffer.length > MAX_LOG_BYTES) { stop('Smoke output exceeded its bounded diagnostic log'); return }
        logs[key] += buffer.toString('utf8')
      })
      child.once('error', error => stop('Smoke runner could not start: ' + error.code))
      child.once('exit', () => { exited = true })
      child.once('close', (code, signal) => finish(code, signal))
    })
    let inner
    const innerPath = path.join(runDir, 'result.json')
    if (fs.existsSync(innerPath)) inner = JSON.parse(fs.readFileSync(innerPath, 'utf8'))
    const report = { ...metadata, ...outcome, endedAt: new Date().toISOString(), ok: outcome.exitCode === 0 && !outcome.failure && inner?.ok === true && inner.nonce === nonce, inner }
    fs.writeFileSync(path.join(runDir, 'outer-result.json'), JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(evidenceRoot, 'latest-result.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ ok: report.ok, report: path.join(runDir, 'outer-result.json'), inner: innerPath, pid: outcome.pid, timedOut: outcome.timedOut }))
    return report.ok ? 0 : 1
  } catch (error) {
    const report = { ...metadata, ok: false, endedAt: new Date().toISOString(), error: errorRecord(error) }
    fs.writeFileSync(path.join(runDir, 'outer-result.json'), JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(evidenceRoot, 'latest-result.json'), JSON.stringify(report, null, 2))
    console.error(JSON.stringify({ ok: false, report: path.join(runDir, 'outer-result.json'), error: report.error }))
    return 1
  }
}
module.exports = { runOuter }
if (require.main === module) {
  const inner = process.argv[2] === '--electron-runner'
  const run = inner ? runInner(process.argv[3], process.argv[4], process.argv[5]) : runOuter()
  run.then(code => { if (inner) process.exit(code); else process.exitCode = code }, error => { console.error(JSON.stringify(errorRecord(error))); process.exit(1) })
}
