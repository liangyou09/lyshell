/**
 * 破坏性命令内容扫描（B1: prompt-injection 防御层）
 *
 * 纯函数，无 IO，便于单测。在 http-server.ts 的 confirmDestructiveIfNeeded 中调用。
 *
 * 设计原则：高精准优先于高召回。宁可漏过一些"看起来危险"的命令，
 * 也不要误伤 agent 的正常工作流——误伤会让用户直接关掉 confirmDestructiveCommands，
 * 防御层就形同虚设。只覆盖"几乎一定是灾难性"的模式：
 *   删根/家目录、写块设备、mkfs、fork bomb、关机重启、chmod 根目录。
 *
 * 已知限制：无法捕获跨多次 send_input 拼装的命令（如逐字符发送 rm -rf /）。
 * 这是输入边界内容扫描的固有限制，由审计日志兜底——拼字符行为本身会留下调用痕迹。
 *
 * 注：pattern 清单为代码内置常量，刻意不暴露给用户/agent 编辑，
 *     避免被 prompt-injection 后的 agent 自行关掉。
 */

export interface DestructiveMatch {
  /** 命中的 pattern 名，用于弹窗展示 */
  name: string
  /** 人类可读说明 */
  description: string
  /** 命中的文本片段（截断展示） */
  snippet: string
}

interface DestructivePattern {
  name: string
  description: string
  pattern: RegExp
}

/**
 * 内置破坏性命令 pattern 清单。新增条目时务必在 destructive-check.test.ts
 * 补充正例/反例，保证精准度。
 */
export const DESTRUCTIVE_PATTERNS: readonly DestructivePattern[] = [
  {
    name: 'rm-rf-root',
    description: 'rm -rf 删除根目录 / 家目录 / 根下所有内容',
    // 仅匹配裸 /、裸 ~、/* 、~/* —— 精准排除 /tmp/x、~/foo 这类正常清理。
    // 尾边界允许空格/行尾/; & | 等 shell 分隔符，但不允许字母（排除 /tmp）。
    pattern: /\brm\s+-\w*(?:r\w*f|f\w*r)\w*\s+(?:\/\*|~\/\*|\/|~)(?=[\s;&|]|$)/
  },
  {
    name: 'dd-to-block-device',
    description: 'dd 写入块设备（覆盖磁盘数据）',
    // of= 指向 /dev/ 下的块设备；[^|;&\n]* 不跨越命令边界
    pattern: /\bdd\b[^|;&\n]*\bof\s*=\s*\/dev\/(?:sd|nvme|vd|hd|disk|loop)/
  },
  {
    name: 'mkfs',
    description: 'mkfs 格式化文件系统',
    pattern: /\bmkfs(?:\.\w+)?\b/
  },
  {
    name: 'write-to-block-device',
    description: '重定向写入块设备（覆盖磁盘数据）',
    // > /dev/sdX、2> /dev/sdX 等；/dev/null 不在清单内，正常放行
    pattern: />\s*\/dev\/(?:sd|nvme|vd|hd|disk|loop)/
  },
  {
    name: 'fork-bomb',
    description: 'fork bomb（耗尽进程表）',
    pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/
  },
  {
    name: 'shutdown-reboot',
    description: '关机 / 重启',
    // \b 边界排除 reboot_count、halted 之类的子串
    pattern: /\b(?:shutdown|reboot|halt|poweroff)\b|\binit\s+[06]\b/
  },
  {
    name: 'chmod-root',
    description: 'chmod 修改根目录权限',
    // 仅匹配裸 / 作为目标，排除 /usr/bin/foo 这类具体路径；尾边界同 rm-rf-root
    pattern: /\bchmod\s+(?:-\w*R\w*\s+)?[0-7]{3,4}\s+\/(?=[\s;&|]|$)/
  }
]

const MAX_SNIPPET_LEN = 80

/**
 * 扫描文本是否含破坏性命令。返回命中的 pattern 列表（空数组 = 安全）。
 * 每个 pattern 至多记一条命中（取首次匹配），避免重复刷屏。
 */
export function scanDestructiveCommand(text: string): DestructiveMatch[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const matches: DestructiveMatch[] = []
  for (const p of DESTRUCTIVE_PATTERNS) {
    const m = p.pattern.exec(text)
    if (m) {
      const snippet = m[0].length > MAX_SNIPPET_LEN
        ? m[0].slice(0, MAX_SNIPPET_LEN) + '...'
        : m[0]
      matches.push({ name: p.name, description: p.description, snippet })
    }
  }
  return matches
}
