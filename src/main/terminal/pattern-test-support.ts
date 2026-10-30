/**
 * 测试专用工具：把**真实** Worker / 探针源码用 esbuild 打包成可独立加载的 CJS 文件。
 *
 * 生产构建走 electron-vite（`dist/main/patternWorker.js`）；测试里不复制实现，
 * 只把同一份源码打包成 Node 可直接 `new Worker()` 的文件，避免"测试用的假 Worker"。
 */
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PATTERN_SOURCE_DIR = dirname(fileURLToPath(import.meta.url))

const OUT_DIR = join(tmpdir(), 'lyshell-pattern-tests')

function outputPath(name: string): string {
  mkdirSync(OUT_DIR, { recursive: true })
  return join(OUT_DIR, `${name}-${process.pid}.cjs`)
}

async function bundle(options: { name: string; entryPath?: string; contents?: string }): Promise<string> {
  const outfile = outputPath(options.name)
  await build({
    ...(options.entryPath
      ? { entryPoints: [options.entryPath] }
      : { stdin: { contents: options.contents ?? '', resolveDir: PATTERN_SOURCE_DIR, loader: 'ts', sourcefile: `${options.name}.ts` } }),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    logLevel: 'silent',
    sourcemap: false,
    alias: {
      '@shared': join(PATTERN_SOURCE_DIR, '../../shared'),
      '@main': join(PATTERN_SOURCE_DIR, '..')
    }
  })
  return outfile
}

let workerBundle: Promise<string> | null = null

/** 真实 `pattern-worker.ts` 的打包产物（同一进程内只打包一次）。 */
export function buildPatternWorkerBundle(): Promise<string> {
  workerBundle ??= bundle({ name: 'pattern-worker', entryPath: join(PATTERN_SOURCE_DIR, 'pattern-worker.ts') })
  return workerBundle
}

/** 打包一段临时探针源码（入口源码以字符串给出，但 import 的仍是真实源码）。 */
export async function buildProbeBundle(name: string, source: string): Promise<string> {
  return bundle({ name, contents: source })
}

/** 写一个独立 Worker 脚本（用于模拟启动失败/永不就绪/自定义回包时序）。 */
export function writeTemporaryScript(name: string, source: string): string {
  mkdirSync(OUT_DIR, { recursive: true })
  const file = join(OUT_DIR, `${name}-${process.pid}.cjs`)
  writeFileSync(file, source, 'utf8')
  return file
}
