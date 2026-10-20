import type { WorkLauncherProject } from './work-launcher-tree'

export interface WorkLauncherDirectory {
  key: string
  label: string
  path: string
  sourceId: string
  project?: WorkLauncherProject
  children: WorkLauncherDirectory[]
}

/** 只展开预设路径的目录层级，不读取磁盘；UNC 共享名和盘符根各自构成根节点。 */
export function buildWorkLauncherDirectories(projects: readonly WorkLauncherProject[], platform: string): WorkLauncherDirectory[] {
  const roots: WorkLauncherDirectory[] = []
  for (const project of projects) {
    if (!project.entries.length) continue
    const windows = platform === 'win32'
    const path = windows ? project.dir.replace(/\\/g, '/') : project.dir
    const unc = windows && path.match(/^\/\/([^/]+)\/([^/]+)(?:\/|$)/)
    const drive = windows && path.match(/^([a-z]:)\//i)
    const root = unc ? `//${unc[1]}/${unc[2]}/` : drive ? `${drive[1]}/` : path.startsWith('/') ? '/' : ''
    const rest = path.slice(root.length).split('/').filter(Boolean)
    const segments = root ? [root, ...rest] : rest
    let siblings = roots
    let currentPath = ''
    segments.forEach((segment, index) => {
      currentPath = index === 0 ? segment : `${currentPath.replace(/\/$/, '')}/${segment}`
      const key = windows ? currentPath.toLowerCase() : currentPath
      let node = siblings.find(item => item.key === key)
      if (!node) {
        node = {
          key,
          label: index === 0 && windows ? segment.replace(/\//g, '\\') : segment,
          path: windows ? currentPath.replace(/\//g, '\\') : currentPath,
          sourceId: project.entries[0].id,
          children: []
        }
        siblings.push(node)
      }
      if (index === segments.length - 1) node.project = project
      siblings = node.children
    })
  }
  const sort = (nodes: WorkLauncherDirectory[]): void => {
    nodes.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
    nodes.forEach(node => sort(node.children))
  }
  sort(roots)
  return roots
}
