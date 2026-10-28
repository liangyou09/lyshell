/**
 * 将 electron-builder --dir 产出的 win-unpacked 目录重命名为
 * lyshell-x64-<version>-unpacked（打包产物目录命名规约）。
 * 由 `npm run pack` / `npm run dist:win` 在 electron-builder 完成后链式调用。
 *
 * 说明：electron-builder 的 unpacked 目录名硬编码为 `${platform}-unpacked`
 * （见 app-builder-lib/out/platformPackager.js 的 computeAppOutDir），没有配置项
 * 可改，故在构建完成后做一次重命名；Windows 持续锁住源目录时复制并保留原目录。
 */
const fs = require('fs')
const path = require('path')
const { setTimeout: delay } = require('node:timers/promises')

const lockErrors = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY'])

/** rename 没有 rm 的 maxRetries；给 Windows 扫描或临时目录句柄有限的释放时间。 */
async function renameWithRetry(src, dst, { rename = fs.promises.rename, wait = delay, maxRetries = 5, retryDelay = 300 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(src, dst)
      return
    } catch (error) {
      if (!lockErrors.has(error.code) || attempt >= maxRetries) throw error
      await wait(retryDelay * (attempt + 1))
    }
  }
}

/** 目录句柄可能阻止 rename 但仍允许读取；复制成功才将目标目录视为就绪。 */
async function placeUnpacked(src, dst, { copy = fs.promises.cp, ...retryOptions } = {}) {
  try {
    await renameWithRetry(src, dst, retryOptions)
    return 'renamed'
  } catch (error) {
    if (!lockErrors.has(error.code)) throw error
    await copy(src, dst, { recursive: true, errorOnExist: true, force: false })
    return 'copied'
  }
}

async function main() {
  const root = path.resolve(__dirname, '..')
  const version = require(path.join(root, 'package.json')).version

  const outRoot = path.join(root, 'release', version)
  const src = path.join(outRoot, 'win-unpacked')
  const dst = path.join(outRoot, `lyshell-x64-${version}-unpacked`)

  if (!fs.existsSync(src)) {
    // 非 Windows（mac/linux --dir 产出 mac / linux-unpacked）时跳过，不视为失败
    console.log(`[rename-unpacked] skip: ${path.relative(root, src)} not found`)
    return
  }

  if (fs.existsSync(dst)) {
    try {
      // maxRetries 兜 Windows 上的瞬时锁（杀软扫描句柄等）；运行中的 exe 锁不在此列
      fs.rmSync(dst, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 })
    } catch (error) {
      if (!lockErrors.has(error.code)) throw error
      console.error(`[rename-unpacked] 目标目录被占用，无法替换：${path.relative(root, dst)}`)
      console.error('[rename-unpacked] 请释放该目录的占用后重跑：node scripts/rename-unpacked.cjs')
      process.exitCode = 1
      return
    }
  }

  try {
    const result = await placeUnpacked(src, dst)
    if (result === 'copied') {
      console.warn(`[rename-unpacked] 源目录持续无法重命名，已完整复制到：${path.relative(root, dst)}`)
      console.warn(`[rename-unpacked] 原目录仍保留：${path.relative(root, src)}`)
    } else {
      console.log(`[rename-unpacked] ${path.relative(root, src)} -> ${path.relative(root, dst)}`)
    }
  } catch (error) {
    console.error(`[rename-unpacked] 解压目录整理失败（${error.code || 'unknown'}），原始产物仍保留：${src}`)
    console.error('[rename-unpacked] 请检查目录占用、可用空间或访问权限后重跑：node scripts/rename-unpacked.cjs')
    process.exitCode = 1
  }
}

module.exports = { renameWithRetry, placeUnpacked }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
