// 示例清单回归：examples/*/lyshell-plugin.json 必须全部通过 validateManifest。
// 示例是与校验器共同演进的文档 —— 清单漂移（如缺省字段被校验拒绝）会让用户
// 按示例写出的插件装不上（曾因 activationEvents 必填误伤纯声明式清单）。
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { validateManifest } from '../src/shared/plugin-types'

const EXAMPLES_DIR = __dirname

describe('examples 清单回归（全部可安装）', () => {
  const manifests = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(d.name, 'lyshell-plugin.json'))
    .filter((p) => existsSync(join(EXAMPLES_DIR, p)))

  it('examples 下确有清单可测（防目录更名后测试空转）', () => {
    expect(manifests.length).toBeGreaterThan(0)
  })

  for (const rel of manifests) {
    it(`${rel} 通过 validateManifest`, () => {
      const raw = JSON.parse(readFileSync(join(EXAMPLES_DIR, rel), 'utf-8'))
      const r = validateManifest(raw)
      expect(r.errors).toEqual([])
      expect(r.ok).toBe(true)
    })
  }
})
