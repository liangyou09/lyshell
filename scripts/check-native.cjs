// 在 Electron 的 Node 模式执行，确保安装时校验的是产品运行时，而不是开发机 Node ABI。
const path = require('path')
const expectedVersion = require('../package.json').devDependencies.electron
if (process.versions.electron !== expectedVersion) {
  throw new Error(`原生模块校验需要 Electron ${expectedVersion}，当前为 ${process.versions.electron || 'Node.js'}`)
}

const ptyRoot = path.dirname(require.resolve('node-pty/package.json'))
if (process.platform === 'win32') {
  // 两个 ConPTY 模块都可能延迟加载，仅 require('node-pty') 不足以验证关闭路径。
  const { loadNativeModule } = require(path.join(ptyRoot, 'lib/utils.js'))
  loadNativeModule('conpty')
  loadNativeModule('conpty_console_list')
} else {
  require('node-pty')
}
require('serialport')
require('koffi')
console.log(`[native] Electron ${process.versions.electron}: PTY、串口与 Koffi 模块载入通过`)
