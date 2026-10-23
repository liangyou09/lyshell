const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

module.exports = {
  electronDist(options) {
    // 本机 Electron 不能用于其他操作系统或架构，交给打包器复用相应下载缓存。
    if (options.platformName !== process.platform || options.arch !== process.arch) return undefined

    try {
      const packagePath = require.resolve('electron/package.json', { paths: [options.packager.projectDir] })
      const installed = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
      const dist = path.join(path.dirname(packagePath), 'dist')
      const version = fs.readFileSync(path.join(dist, 'version'), 'utf8').trim()
      const expected = options.version.replace(/^v/, '')
      const executable = process.platform === 'win32' ? 'electron.exe'
        : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'

      // 同时检查依赖版本和解压产物版本，避免升级中断后复用旧运行时。
      if (installed.version !== expected || version !== expected || !fs.existsSync(path.join(dist, executable))) {
        return undefined
      }
      // npm_config_arch 等安装选项可使本地运行时与打包进程架构不同。
      // 直接探测产物，损坏或不可运行的分发包同样回退到下载缓存。
      let runtime
      try {
        runtime = JSON.parse(execFileSync(path.join(dist, executable), ['-e',
          'console.log(JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.electron}))'], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8',
          timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
        }).trim())
      } catch { return undefined }
      if (runtime.platform !== options.platformName || runtime.arch !== options.arch || runtime.version !== expected) return undefined
      return dist
    } catch (error) {
      // 尚未安装或尚未解压时，保留 electron-builder 默认的缓存优先下载行为。
      if (error.code === 'ENOENT' || error.code === 'MODULE_NOT_FOUND') return undefined
      throw error
    }
  }
}
