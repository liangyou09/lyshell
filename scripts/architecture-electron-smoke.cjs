const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const candidateRoot = process.argv.includes('--package-candidate')
  ? path.join(root, 'tmp/architecture/package-real/win-unpacked/resources/app.asar') : root
if (app.isPackaged || process.type !== 'browser') throw new Error('Run with the repository Electron executable in browser mode')
if (process.platform !== 'win32') throw new Error('This fixture validates Windows cmd/DPAPI; other platforms require their own fixture')
delete process.env.ELECTRON_RENDERER_URL
const evidence = path.join(root, 'tmp/architecture')
fs.mkdirSync(evidence, { recursive: true })
const profile = fs.mkdtempSync(path.join(evidence, 'electron-smoke-profile-'))
process.env.LYSHELL_DEMO_PROFILE = profile
if (!process.argv.includes('--demo-stage')) process.argv.push('--demo-stage')
const resultPath = path.join(evidence, 'electron-integration-result.json')
let started = false
let finished = false
const finish = (result) => {
  if (finished) return
  finished = true
  fs.writeFileSync(resultPath, JSON.stringify({ ...result, electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules }, null, 2))
  app.quit()
  setTimeout(() => app.exit(result.ok ? 0 : 1), 10000).unref()
}
setTimeout(() => finish({ ok: false, error: 'Integration deadline exceeded' }), 30000).unref()
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', () => {
    if (started || !win.webContents.getURL().includes('/dist/renderer/index.html')) return
    started = true
    setImmediate(async () => {
      try {
        const publicChecks = await win.webContents.executeJavaScript(`(async () => {
          const api = window.electronAPI
          const assert = (ok, label) => { if (!ok) throw new Error(label) }
          const base = { id: '', name: 'architecture-fixture', tags: [], terminal: { fontSize: 14, fontFamily: 'Consolas', encoding: 'utf-8', theme: {}, cursorStyle: 'block', cursorBlink: true, scrollback: 1000 }, createdAt: new Date(), updatedAt: new Date() }
          const stored = await api.createSession({ ...base, type: 'ssh', ssh: { host: 'fixture.invalid', port: 22, username: 'fixture', password: 'ARCH_SSH_FIXTURE_SECRET' } })
          assert(stored.id && stored.ssh.password === '__LYSHELL_SECRET_UNCHANGED__', 'SSH public DTO must mask')
          const updated = await api.updateSession({ ...stored, name: 'architecture-fixture-renamed' })
          assert(updated.ssh.password === '__LYSHELL_SECRET_UNCHANGED__', 'SSH masked update must preserve')
          const env = await api.addEnvProfile({ name: 'architecture-fixture-env', apiKey: 'ARCH_PROFILE_FIXTURE_SECRET', env: { TOKEN: 'ARCH_ENV_FIXTURE_SECRET' } })
          assert(env.success && env.profile.apiKey === '__LYSHELL_SECRET_UNCHANGED__', 'Profile public DTO must mask')
          const local = await api.createSession({ ...base, name: 'architecture-local-fixture', type: 'local', local: { shell: ${JSON.stringify(process.env.ComSpec)}, shellArgs: ['/d', '/q', '/k', 'if defined CUSTOM_CRED if not "%CUSTOM_CRED%"=="__LYSHELL_SECRET_UNCHANGED__" echo LYSHELL_ENV_OK'], cwd: ${JSON.stringify(root)}, env: { CUSTOM_CRED: 'ARCH_LOCAL_FIXTURE_SECRET' }, secretEnvKeys: ['CUSTOM_CRED'] } })
          assert(local.local.env.CUSTOM_CRED === '__LYSHELL_SECRET_UNCHANGED__', 'Local public DTO must mask')
          let connected = false
          const offStatus = api.onConnectionStatus(status => { if (status.id === local.id && status.status === 'connected') connected = true })
          const runtime = await api.connect(local)
          assert(!runtime.error, 'Local hydration/connect must succeed')
          const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
          for (let i = 0; i < 60 && !connected; i++) await sleep(100)
          offStatus()
          assert(connected, 'Real PTY connection must finish before acquiring input')
          let lease
          for (let i = 0; i < 50; i++) { lease = await api.terminalControl({ kind: 'acquire', sessionId: runtime.id }); if (lease.success) break; await sleep(100) }
          assert(lease.success, 'Real PTY must acquire fenced GUI lease')
          let output = ''
          const off = api.onTerminalData((id, data, receipt) => { if (id !== runtime.id || !receipt) return; output += data; if (!receipt.error) void api.terminalOutputControl({ kind: 'ack', sessionId: id, subscriptionId: receipt.subscriptionId, sequence: receipt.sequence }) })
          const subscription = await api.terminalOutputControl({ kind: 'subscribe', sessionId: runtime.id })
          assert(subscription.success, 'Real output subscription must succeed')
          api.terminalWrite(runtime.id, 'echo LYSHELL_INPUT_OK\\r')
          for (let i = 0; i < 80 && (!output.includes('LYSHELL_ENV_OK') || !output.includes('LYSHELL_INPUT_OK')); i++) await sleep(100)
          assert(output.includes('LYSHELL_ENV_OK'), 'Secret must reach real child environment')
          assert(output.includes('LYSHELL_INPUT_OK'), 'Fenced input/output must reach real PTY')
          off()
          await api.terminalOutputControl({ kind: 'unsubscribe', sessionId: runtime.id, subscriptionId: subscription.subscriptionId })
          await api.disconnect(runtime.id)
          const health = await api.storageHealth()
          assert(health.secrets.available && !health.stores.some(store => store.error), 'Actual secure storage must be healthy')
          return { sshMask: true, maskedUpdate: true, profileMask: true, localMask: true, realSecretEnvironment: true, realFencedPty: true, storageHealthy: true }
        })()`)
        const diskFiles = ['sessions.json', 'sessions.json.bak', 'secrets.json', 'secrets.json.bak', 'env-profiles.json', 'env-profiles.json.bak']
        for (const name of diskFiles) {
          const file = path.join(profile, 'config', name)
          if (fs.existsSync(file) && /ARCH_(SSH|PROFILE|ENV|LOCAL)_FIXTURE_SECRET/.test(fs.readFileSync(file, 'utf8'))) throw new Error('Fixture plaintext persisted in ' + name)
        }
        const rogue = new BrowserWindow({ show: false, webPreferences: { preload: path.join(candidateRoot, 'dist/preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
        await rogue.loadURL('data:text/html,<title>Unregistered fixture</title>')
        const rejected = await rogue.webContents.executeJavaScript(`window.electronAPI.listSessions().then(() => false, error => /current application window|FORBIDDEN/.test(error.message))`)
        rogue.destroy()
        if (!rejected) throw new Error('Unregistered WebContents was not rejected')
        finish({ ok: true, checks: { ...publicChecks, diskHasNoPlaintext: true, unregisteredWindowRejected: true } })
      } catch (error) { finish({ ok: false, error: String(error?.stack || error) }) }
    })
  })
})
require(path.join(candidateRoot, 'dist/main/index.js'))
