import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { check } = require('./check-architecture-boundaries.cjs') as { check: (root: string) => { cycles: string[][]; staticCycles: string[][]; violations: Array<{ reason: string }>; dynamicImports: Array<{ specifier: string }> } }
const directories: string[] = []
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lyshell-boundary-')); directories.push(root)
  for (const [file, text] of Object.entries(files)) {
    const target = join(root, file); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, text)
  }
  return root
}
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('architecture boundary gate', () => {
  it('ignores type-only aliases but finds mixed named imports and dynamic cycles', () => {
    const root = fixture({
      'src/main/a.ts': "import type { B } from './b'; export const a = 1",
      'src/main/b.ts': "import { type A, a } from './a'; export async function b() { return import('./c') }",
      'src/main/c.ts': "export { b } from '@main/b'"
    })
    const result = check(root)
    expect(result.staticCycles).toEqual([])
    expect(result.cycles).toEqual([['src/main/b.ts', 'src/main/c.ts']])
    expect(result.dynamicImports).toMatchObject([{ specifier: './c' }])
  })
  it('resolves aliases and rejects capabilities or registration dependencies across layers', () => {
    const result = check(fixture({
      'src/main/ipc/handlers.ts': 'export const main = true',
      'src/main/commands/service.ts': "export { main } from '../ipc/handlers'",
      'src/renderer/a.ts': "import type { Stats } from 'fs'; import 'node:child_process'; import '@main/ipc/handlers'",
      'src/shared/a.ts': "export * from '@/a'"
    }))
    expect(result.violations.map(item => item.reason)).toEqual(expect.arrayContaining([
      'application service must not depend on transport registration', 'renderer must not import Node/Electron capabilities', 'renderer must not depend on main', 'shared must not depend on main/renderer'
    ]))
    expect(result.violations).toHaveLength(4)
  })
})
