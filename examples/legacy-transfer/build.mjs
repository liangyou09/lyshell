import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
const require = createRequire(import.meta.url)
const Zip = require('adm-zip')
const here = dirname(fileURLToPath(import.meta.url))
// ssh2 的可选 native 加速器禁用打包，使用随包纯 JS 实现，无需 npm install。
await build({ entryPoints: [join(here, 'src/main.ts'), join(here, 'src/worker.ts')], outdir: here,
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  external: ['cpu-features', './crypto/build/Release/sshcrypto.node'],
  sourcemap: false, legalComments: 'eof' })
const zip = new Zip()
for (const file of ['lyshell-plugin.json', 'main.js', 'worker.js', 'icon.svg', 'README.md']) zip.addLocalFile(join(here, file))
for (const file of ['transfer.html', 'transfer.js', 'transfer.css']) zip.addLocalFile(join(here, 'views', file), 'views')
zip.addFile('views/connection.js', Buffer.from('window.legacyTransferPort = null;\n'))
// 依赖版权声明随安装包一起发布。
zip.addFile('THIRD_PARTY_LICENSES.txt', Buffer.concat(await Promise.all(['ssh2', 'asn1', 'bcrypt-pbkdf', 'tweetnacl', 'safer-buffer'].map(async name => {
  const pkg = require.resolve(`${name}/package.json`)
  return Buffer.concat([Buffer.from(`\n--- ${name} ---\n`), await readFile(join(dirname(pkg), 'LICENSE'))])
}))))
await mkdir(join(here, 'dist'), { recursive: true })
zip.writeZip(join(here, 'dist', 'legacy-transfer-1.0.0.zip'))
console.log('Built examples/legacy-transfer/dist/legacy-transfer-1.0.0.zip')
