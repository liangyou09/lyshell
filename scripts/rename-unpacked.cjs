/**
 * 将 electron-builder --dir 产出的 win-unpacked 目录重命名为
 * lyshell-x64-<version>-unpacked（打包产物目录命名规约）。
 * 由 `npm run pack` / `npm run dist:win` 在 electron-builder 完成后链式调用。
 *
 * 说明：electron-builder 的 unpacked 目录名硬编码为 `${platform}-unpacked`
 * （见 app-builder-lib/out/platformPackager.js 的 computeAppOutDir），没有配置项
 * 可改，故在构建完成后做一次重命名。
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const version = require(path.join(root, 'package.json')).version

const outRoot = path.join(root, 'release', version)
const src = path.join(outRoot, 'win-unpacked')
const dst = path.join(outRoot, `lyshell-x64-${version}-unpacked`)

if (!fs.existsSync(src)) {
  // 非 Windows（mac/linux --dir 产出 mac / linux-unpacked）时跳过，不视为失败
  console.log(`[rename-unpacked] skip: ${path.relative(root, src)} not found`)
  process.exit(0)
}

if (fs.existsSync(dst)) {
  try {
    // maxRetries 兜 Windows 上的瞬时锁（杀软扫描句柄等）；运行中的 exe 锁不在此列
    fs.rmSync(dst, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 })
  } catch (e) {
    // 旧 unpacked 目录被占用：最常见是旧版 LyShell 还在从该目录运行（Windows 锁着
    // 运行中 exe 及其所在目录）。此时 electron-builder 产物已就绪，不必整链重新
    // 打包——完全退出 LyShell 后单独重跑本脚本即可补完重命名
    if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'ENOTEMPTY') {
      console.error(`[rename-unpacked] 目标目录被占用，无法删除：${path.relative(root, dst)}`)
      console.error('[rename-unpacked] 通常是旧版 LyShell 正从该目录运行——完全退出 LyShell 后重跑: node scripts/rename-unpacked.cjs')
      process.exit(1)
    }
    throw e
  }
}
fs.renameSync(src, dst)
console.log(`[rename-unpacked] ${path.relative(root, src)} -> ${path.relative(root, dst)}`)
