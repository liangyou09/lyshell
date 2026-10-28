/** 回退开关仅在 renderer 启动时读取；关闭优化不修改用户已经提交的分类。 */
function enabled(name: 'previews' | 'sidebarRestore'): boolean {
  try {
    const flags: unknown = JSON.parse(localStorage.getItem('lyshell.taskShelf.features.v1') || '{}')
    return !flags || typeof flags !== 'object' || (flags as Record<string, unknown>)[name] !== false
  } catch { return true }
}
export const SHELF_PREVIEWS_ENABLED = enabled('previews')
export const SHELF_SIDEBAR_RESTORE_ENABLED = enabled('sidebarRestore')
