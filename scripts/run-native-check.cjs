const { spawnSync } = require('node:child_process')
const path = require('node:path')
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
const result = spawnSync(require('electron'), [path.join(__dirname, 'check-native.cjs')], { env, stdio: 'inherit' })
process.exitCode = result.status ?? 1
