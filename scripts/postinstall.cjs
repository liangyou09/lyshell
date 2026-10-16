// 优先校验依赖官方提供的 Node-API 预编译模块；缺失或不兼容时才从源码重建。
const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const root = path.join(__dirname, '..')
const electronPath = require('electron')
const electronPackagePath = require.resolve('electron/package.json', { paths: [root] })
const electronVersion = JSON.parse(fs.readFileSync(electronPackagePath, 'utf8')).version
const checkNative = () => execFileSync(electronPath, [path.join(__dirname, 'check-native.cjs')], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit'
})

let ready = false
if (!process.argv.includes('--force') && process.env.npm_config_build_from_source !== 'true') {
  try { checkNative(); ready = true } catch { /* 交给 rebuild 修复，之后仍须通过真实运行时校验。 */ }
}
if (!ready) {
  const rebuildMain = require.resolve('@electron/rebuild', { paths: [root] })
  const rebuildCli = path.join(path.dirname(rebuildMain), 'cli.js')
  console.log(`[postinstall] 为 Electron ${electronVersion} 重建终端与串口模块`)
  // --force 只跳过已重建标记，仍可能复用校验失败的 prebuild；修复路径必须源码编译。
  execFileSync(process.execPath, [rebuildCli, '--force', '--build-from-source', '--version', electronVersion,
    '--only', 'node-pty,@serialport/bindings-cpp'], { cwd: root, stdio: 'inherit' })
  // 编译成功也必须验证当前 Electron 能真正载入模块；失败直接中断安装。
  checkNative()
}
