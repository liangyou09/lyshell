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

// 组头题签取 basename(工作区名):题名短才立得住卷轴,全路径走 labelTitle
// 进 tooltip;换名只在展示层。根路径 / 或全分隔符串没有段,回落原文
export const wsDirLabel = (dir: string): string =>
  dir.split(/[\\/]+/).filter(Boolean).pop() ?? dir
