// node-pty 1.0.0 在 node 24 下无法完整编译（winpty 目标 GetCommitHash.bat 失败）。
// electron-builder.yml 已设 npmRebuild: false 跳过打包阶段重编；本脚本负责 npm install
// 时的 postinstall，为当前 Electron 28 ABI 预编译原生模块：
//
// - node 18/20 LTS：执行 electron-builder install-app-deps，全量编译 serialport / node-pty。
// - Windows + 其他版本（含 node 24）：winpty 目标编不过，改用 node-gyp + 最小 binding.gyp
//   只编译 ConPTY 相关的 conpty / conpty_console_list 两个目标（现代 Windows 走 ConPTY，
//   winpty 运行时用不到），跳过 winpty 避免编译卡死。
// - 非 Windows + 其他版本：保持原行为，跳过并提示（不报错中断）。
//
// 注意：开发/打包运行时都需要这些 .node 二进制。若 Windows + node 24 下跳过编译，
// node-pty 会缺 conpty_console_list.node，关闭终端会话时报
// "Cannot find module '../build/Debug/conpty_console_list.node'"。
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const major = Number(process.versions.node.split('.')[0])
const root = path.join(__dirname, '..')
const toPosix = (p) => p.replace(/\\/g, '/')

function electronVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
  } catch (e) {
    return null
  }
}

// Windows + node 24 等：只编译 ConPTY 目标，跳过 winpty。
function buildConptyOnly() {
  const version = electronVersion()
  const nodeGypBin = path.join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
  const nanDir = path.join(root, 'node_modules', 'nan')
  const nodePtyDir = path.join(root, 'node_modules', 'node-pty')

  if (!version || !fs.existsSync(nodeGypBin) || !fs.existsSync(nanDir) || !fs.existsSync(nodePtyDir)) {
    console.warn('[postinstall] 缺少 electron / node-gyp / nan / node-pty，跳过 ConPTY 编译。')
    console.warn('[postinstall] 本脚本仅支持 npm 的扁平 node_modules 布局；pnpm/yarn 下 node-gyp 不在根 node_modules，会命中此分支。')
    console.warn('[postinstall] 请切换到 node 18/20 LTS 后执行 npm run rebuild。')
    return
  }

  const buildDir = path.join(nodePtyDir, '.conpty-only-build')
  const bindingGyp = {
    targets: [
      {
        target_name: 'conpty',
        include_dirs: [toPosix(nanDir)],
        sources: [
          toPosix(path.join(nodePtyDir, 'src', 'win', 'conpty.cc')),
          toPosix(path.join(nodePtyDir, 'src', 'win', 'path_util.cc')),
        ],
        libraries: ['shlwapi.lib'],
      },
      {
        target_name: 'conpty_console_list',
        include_dirs: [toPosix(nanDir)],
        sources: [toPosix(path.join(nodePtyDir, 'src', 'win', 'conpty_console_list.cc'))],
      },
    ],
  }

  const required = ['conpty.node', 'conpty_console_list.node']
  try {
    fs.mkdirSync(buildDir, { recursive: true })
    fs.writeFileSync(path.join(buildDir, 'binding.gyp'), JSON.stringify(bindingGyp, null, 2))

    execSync(
      `"${process.execPath}" "${nodeGypBin}" rebuild --runtime=electron --target=${version} ` +
        `--dist-url=https://electronjs.org/headers --arch=${process.arch}`,
      { stdio: 'inherit', cwd: buildDir }
    )

    const outDir = path.join(buildDir, 'build', 'Release')
    const destDir = path.join(nodePtyDir, 'build', 'Release')
    fs.mkdirSync(destDir, { recursive: true })
    const missing = []
    for (const f of required) {
      const src = path.join(outDir, f)
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(destDir, f))
        console.log(`[postinstall] 已生成 ${f}`)
      } else {
        missing.push(f)
      }
    }
    // node-gyp 退出码为 0 不保证两个目标都编出产物（可能只编出一个），须断言 .node 齐全，
    // 不能只因命令成功就打印「完成」。
    if (missing.length > 0) {
      throw new Error(`ConPTY 编译产物缺失：${missing.join(', ')}`)
    }
    console.log('[postinstall] ConPTY 原生模块编译完成')
  } catch (e) {
    console.warn(`[postinstall] ConPTY 原生模块编译失败：${e.message}`)
    console.warn('[postinstall] 关闭终端会话时可能报 "Cannot find module conpty_console_list.node"。')
    console.warn('[postinstall] 请切换到 node 18/20 LTS 后执行 npm run rebuild。')
    // ConPTY 二进制是 Windows 运行时的硬依赖：编译失败或产物缺失都会产出运行时报错的产物，
    // 本地 npm run dist 打包同样中招。故一律 fail-fast（而非仅 CI），避免静默带病通过。
    throw e
  } finally {
    try {
      fs.rmSync(buildDir, { recursive: true, force: true })
    } catch (_) {
      /* 忽略临时目录清理失败 */
    }
  }
}

if (major === 18 || major === 20) {
  console.log(`[postinstall] node ${process.versions.node}，执行 electron-builder install-app-deps`)
  execSync('electron-builder install-app-deps', { stdio: 'inherit' })
} else if (process.platform === 'win32') {
  console.warn(
    `[postinstall] node ${process.versions.node} 检测到，winpty 目标无法编译，` +
      '改为只编译 ConPTY 原生模块（conpty + conpty_console_list）。'
  )
  buildConptyOnly()
} else {
  console.warn(
    `[postinstall] node ${process.versions.node} 检测到，跳过原生模块编译` +
      '（node-pty 需 node 18/20 LTS）。如需原生模块，请切换到 node 18/20 LTS。'
  )
}
