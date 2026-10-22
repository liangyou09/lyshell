import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import ts from 'typescript'
import { expect, it } from 'vitest'

const transpile = (name: string) => ts.transpileModule(readFileSync(join(process.cwd(), 'src/main/mcp', name), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText

it('精确高回溯反例在可终止的隔离 Worker 中正常完成', async () => {
  const result = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const glob = {}, listing = {};
      new Function('exports', workerData.glob)(glob);
      new Function('exports', 'require', workerData.listing)(listing, () => glob);
      parentPort.postMessage({ started: true });
      const name = 'a'.repeat(80);
      listing.listFilesBounded('/', async () => [{ name, path: '/' + name, isDir: false }], {
        recursive: false, glob: '*a'.repeat(30) + 'b', maxEntries: 1, signal: new AbortController().signal
      }).then(result => parentPort.postMessage({ result }));
    `, { eval: true, workerData: { glob: transpile('glob.ts'), listing: transpile('list-files.ts') } })
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer)
      void worker.terminate().then(() => error ? reject(error) : resolve(value))
    }
    timer = setTimeout(() => finish(new Error('Isolated fixture failed to start')), 10000)
    worker.on('error', error => finish(error))
    worker.on('message', (message: { started?: boolean; result?: unknown }) => {
      clearTimeout(timer)
      if (message.started) timer = setTimeout(() => finish(new Error('Glob exceeded isolated 1500ms budget')), 1500)
      else finish(undefined, message.result)
    })
  })
  expect(result).toMatchObject({ entries: [], truncated: false, scannedEntries: 1 })
}, 15000)

// C2 内存验证只在一次性隔离 Worker（128 MiB old heap 上限）里做：
// 超长模式必须在 token/闭包分配前被拒绝，因此不应出现 OOM 或显著堆增长。
// 不向正式进程或运行中的服务发送危险输入。
it('超长模式在隔离 Worker 中编译前被拒绝，128 MiB 堆内无放大', async () => {
  interface CaseResult {
    label: string
    compiled?: boolean
    name?: string
    message?: string
    length?: number
    heapGrowthBytes: number
  }
  const results = await new Promise<CaseResult[]>((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const glob = {};
      new Function('exports', workerData.glob)(glob);
      const measure = (label, make) => {
        const before = process.memoryUsage().heapUsed;
        let outcome;
        try {
          glob.compileGlob(make());
          outcome = { compiled: true };
        } catch (error) {
          outcome = { name: error.name, message: error.message, length: error.length };
        }
        return { label, ...outcome, heapGrowthBytes: process.memoryUsage().heapUsed - before };
      };
      // 先触发模块/函数的惰性编译，再取每次用例的基线。
      glob.compileGlob('a'); glob.compileGlob('*'); glob.compileGlob('[a]');
      parentPort.postMessage({ results: [
        measure('plain-100k', () => 'a'.repeat(100000)),
        measure('plain-1m', () => 'a'.repeat(1000000)),
        measure('charclass-1m', () => '[' + 'a'.repeat(1000000) + ']'),
        measure('limit-4096', () => 'a'.repeat(4096))
      ] });
    `, { eval: true, workerData: { glob: transpile('glob.ts') }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
    const finish = (error?: Error, value?: CaseResult[]) => {
      clearTimeout(timer)
      void worker.terminate().then(() => error ? reject(error) : resolve(value!))
    }
    const timer = setTimeout(() => finish(new Error('Isolated glob size fixture timed out')), 15000)
    worker.on('error', error => finish(error))
    worker.on('message', (message: { results: CaseResult[] }) => finish(undefined, message.results))
  })

  const byLabel = Object.fromEntries(results.map(result => [result.label, result]))
  for (const label of ['plain-100k', 'plain-1m', 'charclass-1m']) {
    const rejected = byLabel[label]
    expect(rejected.name).toBe('GlobPatternTooLongError')
    expect(rejected.message!.length).toBeLessThan(200)
    expect(rejected.heapGrowthBytes).toBeLessThan(8 * 1024 * 1024)
  }
  expect(byLabel['plain-100k'].length).toBe(100_000)
  expect(byLabel['plain-1m'].length).toBe(1_000_000)
  expect(byLabel['limit-4096']).toMatchObject({ compiled: true })
}, 20000)
