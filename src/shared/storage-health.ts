export interface StorageHealth {
  stores: Array<{ name: string; error?: 'corrupt' | 'unreadable' }>
  secrets: { available: boolean; corrupt: boolean; weak: boolean; backend: string }
}
