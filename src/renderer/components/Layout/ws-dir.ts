/**
 * 工作区目录组的两个纯函数 —— HarnessPanel / AgentsPanel 共用。
 */

// 归一化组键:剥尾部分隔符,避免 D:\x 与 D:\x\ 裂成两组。剥后退化成「根」的
// 两类保留规范形,不能并错组:
// - 根路径(/ 或 \):合法工作目录,吞成空串会让 Harness 得到空题签、Agents
//   误并进「未指定目录」—— 规范成单个分隔符(/ 与 // 同根)
// - Windows 盘符根(D:\):剥成 D: 会与盘符相对路径 D:(指该盘的当前目录,是
//   另一个合法 cwd)混作一组 —— 规范成「盘符:\」,D:\ 与 D:/ 同根、与 D: 分组
// 没剥掉东西的(无尾分隔符)原样返回 —— D: 是 D:,不与 D:\ 混
export const normDirKey = (dir: string): string => {
  const stripped = dir.replace(/[\\/]+$/, '')
  if (stripped === dir) return dir                          // 无尾分隔符,原样
  if (stripped === '') return dir.charAt(0)                 // 全分隔符:根,规范成单个
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`  // 盘符根,规范成 X:\
  return stripped
}

// 组头题签取 basename(工作区名):题名短才立得住卷轴,全路径由组头 tooltip
// 提供;换名只在展示层。根路径 / 或全分隔符串没有段,回落原文
export const wsDirLabel = (dir: string): string =>
  dir.split(/[\\/]+/).filter(Boolean).pop() ?? dir

// 同名目录取父路径的差异片段，并给出独立序号；调用处须让序号不参与截断。
export const wsDirDetail = (dir: string, dirs: readonly string[]): { detail: string; detailMarker?: string } => {
  const sameName = dirs.filter(path => wsDirLabel(path) === wsDirLabel(dir)).sort()
  if (sameName.length < 2) return { detail: dir }

  const parents = sameName.map(path =>
    path.split(/[\\/]+/).filter(Boolean).slice(0, -1).join('/')
  )
  const index = sameName.indexOf(dir)
  const current = parents[index]
  const detailMarker = `#${index + 1}`
  if (!current) return { detail: dir, detailMarker }

  let prefix = 0
  while (prefix < current.length && parents.every(path => path[prefix] === current[prefix])) prefix++
  // 不从词中间截断：foo-bar/foo-baz 应显示 bar/baz；没有分隔符的
  // foobar/foobaz 则保留完整目录名，而非只留下 r/z。
  if (prefix > 0) {
    const shared = current.slice(0, prefix)
    const wordBoundary = Math.max(
      shared.lastIndexOf('/'), shared.lastIndexOf('-'),
      shared.lastIndexOf('_'), shared.lastIndexOf('.'), shared.lastIndexOf(' ')
    )
    const camelBoundary = [...shared.matchAll(/[a-z0-9](?=[A-Z])/g)].at(-1)?.index
    prefix = Math.max(wordBoundary + 1, camelBoundary === undefined ? 0 : camelBoundary + 1)
  }
  let suffix = 0
  while (suffix < current.length - prefix && parents.every(path => path[path.length - 1 - suffix] === current[current.length - 1 - suffix])) suffix++
  // 短的词尾（如 east/west 的 st）仍属于可读名称，长词尾或完整公共目录才省去。
  if (suffix < 4 && !current.slice(-suffix).includes('/')) suffix = 0
  const difference = current.slice(prefix, current.length - suffix) || current
  const separator = dir.includes('\\') ? '\\' : '/'
  return { detail: difference.replace(/\//g, separator), detailMarker }
}
