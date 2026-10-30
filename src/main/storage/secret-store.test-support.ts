import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { SecretCipher } from './secret-store'

/**
 * 秘密存储的测试辅助（仅供 *.test.ts 使用）。
 *
 * 三个仓储默认使用全局 `secretStore`（写 <userData>/secrets.json），而 vitest
 * 并发执行测试文件、且 electron.safeStorage 在单测里不可用 —— 因此相关测试要
 * 通过 `vi.mock('./secret-store')` 把单例换成指向唯一临时文件的真实 SecretStore。
 * 本文件刻意只做「路径 + 内存 cipher」，不 import SecretStore 运行时，避免 mock
 * 工厂加载本模块时形成循环依赖。
 */

const TEST_DIR = join(tmpdir(), 'lyshell-secret-tests')

/** 每个测试文件用唯一文件名，避免并发互踩 */
export function secretTestPath(fileName: string): string {
  mkdirSync(TEST_DIR, { recursive: true })
  return join(TEST_DIR, fileName)
}

/** 清掉 vault 主文件与 .bak（beforeAll 调用，避免上次运行的残留条目） */
export function resetSecretFiles(filePath: string): void {
  // 写入失败用例会用目录占住 vault 路径，清理时需要递归删除
  rmSync(filePath, { force: true, recursive: true })
  rmSync(`${filePath}.bak`, { force: true, recursive: true })
}

export interface MemoryCipherOptions {
  /** false 模拟平台安全存储不可用 */
  available?: boolean
  /** Linux 弱后端名（如 'basic_text'） */
  backend?: string
}

/**
 * 进程内可逆 cipher：XOR 0x5a 后落盘，磁盘上不会出现秘密明文，同时保持
 * safeStorage 的 Buffer 接口形状。解密失败可通过传入坏密文触发。
 */
export function createTestCipher(options: MemoryCipherOptions = {}): SecretCipher {
  return {
    isEncryptionAvailable: () => options.available !== false,
    encryptString: (plain: string) => {
      const buffer = Buffer.from(plain, 'utf8')
      for (let i = 0; i < buffer.length; i += 1) buffer[i] ^= 0x5a
      return buffer
    },
    decryptString: (encrypted: Buffer) => Buffer.from(encrypted.map((byte) => byte ^ 0x5a)).toString('utf8'),
    getSelectedStorageBackend: () => options.backend ?? 'test_backend'
  }
}
