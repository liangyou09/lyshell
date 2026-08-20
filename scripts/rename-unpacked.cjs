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
  fs.rmSync(dst, { recursive: true, force: true })
}
fs.renameSync(src, dst)
console.log(`[rename-unpacked] ${path.relative(root, src)} -> ${path.relative(root, dst)}`)
