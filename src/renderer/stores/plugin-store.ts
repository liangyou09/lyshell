import { create } from 'zustand'
import type {
  PluginListItem,
  PluginInstallDevRequest,
  PluginInstallZipRequest,
  PluginPickResult,
  PluginPickFileResult,
  PluginFetchUrlResult
} from '@shared/plugin-types'

/**
 * 插件管理 store -- 镜像 locale/theme-store 的 plain create() 形态(不用 persist 中间件)。
 *
 * 镜像主进程 plugin:* IPC(见 src/preload/index.ts bridge):
 *   listPlugins / pickPluginFolder / installDevPlugin / enablePlugin / disablePlugin / uninstallPlugin
 * 所有写操作(install/enable/disable/uninstall)成功后自动 load() 刷新列表。
 *
 * preload bridge 返回 Promise<unknown>(对齐现有 addAgent 等),此处调用点就地断言具体形状。
 * 详见 docs/plugin-system-design.md §8(生命周期)。
 */

interface InstallResult {
  success: boolean
  error?: string
  entry?: PluginListItem
  /** engines.lyshell 不兼容等 warn-only 提示(安装仍成功);供 UI 非静默回显 */
  warning?: string
}

interface SimpleResult {
  success: boolean
  error?: string
}

interface PluginStore {
  items: PluginListItem[]
  loading: boolean
  /** 最近一次写操作错误(供 UI 临时提示) */
  error: string | null
  load: () => Promise<void>
  pickFolder: () => Promise<PluginPickResult>
  installDev: (req: PluginInstallDevRequest) => Promise<InstallResult>
  pickFile: () => Promise<PluginPickFileResult>
  fetchUrl: (url: string) => Promise<PluginFetchUrlResult>
  installZip: (req: PluginInstallZipRequest) => Promise<InstallResult>
  cancelDownload: (path: string) => Promise<SimpleResult>
  enable: (id: string) => Promise<boolean>
  disable: (id: string) => Promise<boolean>
  uninstall: (id: string) => Promise<SimpleResult>
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  items: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null })
    try {
      const items = ((await window.electronAPI?.listPlugins()) as PluginListItem[] | undefined) ?? []
      set({ items, loading: false })
    } catch (e) {
      set({ loading: false, error: (e as Error).message })
    }
  },

  pickFolder: async () => {
    return ((await window.electronAPI?.pickPluginFolder()) as PluginPickResult) ?? {
      success: false,
      error: 'unavailable'
    }
  },

  installDev: async (req) => {
    try {
      const res = (await window.electronAPI?.installDevPlugin(req)) as InstallResult | undefined
      if (res?.success) {
        await get().load()
      }
      return { success: !!res?.success, error: res?.error, entry: res?.entry, warning: res?.warning }
    } catch (e) {
      set({ error: (e as Error).message })
      return { success: false, error: (e as Error).message }
    }
  },

  pickFile: async () => {
    return ((await window.electronAPI?.pickPluginFile()) as PluginPickFileResult | undefined) ?? {
      success: false,
      error: 'unavailable'
    }
  },

  fetchUrl: async (url) => {
    return (
      ((await window.electronAPI?.fetchPluginUrl({ url })) as PluginFetchUrlResult | undefined) ?? {
        success: false,
        error: 'unavailable'
      }
    )
  },

  installZip: async (req) => {
    try {
      const res = (await window.electronAPI?.installZipPlugin(req)) as InstallResult | undefined
      if (res?.success) {
        await get().load()
      }
      return { success: !!res?.success, error: res?.error, entry: res?.entry, warning: res?.warning }
    } catch (e) {
      set({ error: (e as Error).message })
      return { success: false, error: (e as Error).message }
    }
  },

  // 取消 URL 安装:即时删除临时下载文件(.downloads/ 下,服务端 assertUnderBase 兜底)。fire-and-forget 即可。
  cancelDownload: async (path) => {
    try {
      const res = (await window.electronAPI?.cancelPluginDownload(path)) as SimpleResult | undefined
      return { success: !!res?.success, error: res?.error }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  },

  enable: async (id) => {
    try {
      const res = (await window.electronAPI?.enablePlugin(id)) as SimpleResult | undefined
      if (res?.success) await get().load()
      return !!res?.success
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },

  disable: async (id) => {
    try {
      const res = (await window.electronAPI?.disablePlugin(id)) as SimpleResult | undefined
      if (res?.success) await get().load()
      return !!res?.success
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },

  uninstall: async (id) => {
    try {
      const res = (await window.electronAPI?.uninstallPlugin(id)) as SimpleResult | undefined
      if (res?.success) await get().load()
      return { success: !!res?.success, error: res?.error }
    } catch (e) {
      set({ error: (e as Error).message })
      return { success: false, error: (e as Error).message }
    }
  }
}))
