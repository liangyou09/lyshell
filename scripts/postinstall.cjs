// node-pty 1.0.0 在 node 24 下无法原生编译（winpty GetCommitHash.bat 失败）。
// electron-builder.yml 已设 npmRebuild: false 跳过打包阶段重编；本脚本负责 npm install
// 时的 postinstall：仅在 node 18/20 LTS（node-pty 已验证可编译）上执行
// electron-builder install-app-deps，为当前 Electron 28 ABI 预编译 serialport/node-pty；
// 其他版本（含 node 24）直接跳过，避免 npm install 卡死在 winpty 编译上。
//
// 注意：开发运行时仍需 node 18/20 LTS 才有可用的 node-pty 二进制——跳过仅意味着
// 不报错中断，并未真正生成原生模块。在 node 24 上若只想装非原生依赖，可用
// npm install --ignore-scripts，但启动 app 仍会因加载不到 node-pty 而失败。
const { execSync } = require('child_process')

const major = Number(process.versions.node.split('.')[0])
if (major !== 18 && major !== 20) {
  console.warn(
    `[postinstall] node ${process.versions.node} 检测到，跳过 electron-builder install-app-deps` +
      `（node-pty 需 node 18/20 LTS 才能编译）。如需原生模块，请切换到 node 18/20 LTS。`
  )
  process.exit(0)
}

console.log(`[postinstall] node ${process.versions.node}，执行 electron-builder install-app-deps`)
execSync('electron-builder install-app-deps', { stdio: 'inherit' })
