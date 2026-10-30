/** Electron 在 Linux 无密钥环时可提供 basic_text；available 不等于足够安全。 */
export function isStrongSecureStorage(storage: {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
} | undefined, platform: NodeJS.Platform = process.platform): boolean {
  try {
    return !!storage?.isEncryptionAvailable() &&
      !(platform === 'linux' && storage.getSelectedStorageBackend?.() === 'basic_text')
  } catch { return false }
}
