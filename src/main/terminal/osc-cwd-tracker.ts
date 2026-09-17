/* eslint-disable no-control-regex */
/**
 * 工作目录报告 OSC 序列的增量解析器(local 会话页签悬停详情卡的数据源)。
 *
 * 终端流里 shell 会主动上报当前工作目录,两种事实标准:
 * - OSC 9;9(ConEmu 风格):pwsh 的 PSReadLine 2.1+ 在每次 prompt 渲染时自动发送
 *   (`\x1b]9;9;"C:\path"`,ST/BEL 结尾,Windows Terminal 用同款机制跟踪目录);
 * - OSC 7(iTerm2 风格):`file://host/path` URI,配了 shell integration 的 bash/zsh 发。
 *
 * 输出流按 data chunk 到达,单条 OSC 可能被拆在两个 chunk 里 —— 解析器保留
 * "最后一个未终结 OSC 起的尾巴"跨 chunk 拼接,不丢序列;尾巴超上限(垃圾流
 * 没有终止符)丢弃,防内存膨胀。
 *
 * cmd 不发任何目录序列,调用方以 spawn 目录作种子 —— 悬停卡停留在启动值。
 */

// OSC 9;9:路径为字面 Windows 路径;ConEmu 规范与 PSReadLine 实发都带双引号,
// 兼容不带引号变体([^"] 里天然排掉 ST 的 \x1b 与 BEL)
const OSC_9_9_RE = /\x1b\]9;9;"?([^"\x07\x1b]+)"?(?:\x07|\x1b\\)/g
// OSC 7:data 段须是 file:// URI;空 host(localhost 写法两种)都收
const OSC_7_RE = /\x1b\]7;(file:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g

// 尾巴保留上限:目录报告序列本身几百字节封顶,超长的必是垃圾流
const TAIL_LIMIT = 1024

/** OSC 7 的 file:// URI → 本地路径(host 段丢弃:local 会话 shell 必在本机) */
function fileUriToPath(uri: string): string | null {
  try {
    const u = new URL(uri)
    if (u.protocol !== 'file:') return null
    return decodeURIComponent(u.pathname)
  } catch {
    return null
  }
}

export class OscCwdTracker {
  /** 未终结的 OSC 尾巴(可能以 \x1b] 开头,也可能只剩 \x1b 单字符) */
  private tail = ''
  /** 当前已知工作目录(种子或最近检出) */
  private cwd: string | null

  /**
   * @param seed 已知初始值(local 会话的 spawn 目录)—— 首条同值 OSC 被
   *   去重挡掉,不会产生空转推送
   */
  constructor(seed: string | null = null) {
    this.cwd = seed
  }

  /** 喂入一个输出 chunk;检出比上次新的目录时返回它,否则返回 null(同值去重) */
  push(chunk: string): string | null {
    if (!chunk) return null
    const buf = this.tail + chunk
    this.tail = this.trimToPending(buf)

    // 两种序列都收集,取流内位置最靠后的(时间最新);通常一个 shell 只发一种
    let best: { index: number; path: string } | null = null
    for (const [re, toPath] of [
      [OSC_9_9_RE, (m: RegExpExecArray) => m[1]] as const,
      [OSC_7_RE, (m: RegExpExecArray) => fileUriToPath(m[1])] as const
    ]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(buf)) !== null) {
        const path = toPath(m)
        if (path && (!best || m.index > best.index)) best = { index: m.index, path }
      }
    }

    if (best && best.path !== this.cwd) {
      this.cwd = best.path
      return best.path
    }
    return null
  }

  /** 当前已知工作目录(未检出过则为种子) */
  getCwd(): string | null {
    return this.cwd
  }

  /**
   * 计算 buf 里需要保留的尾巴:
   * 1. 最后一个 `\x1b]` 之后没有终止符(BEL / 完整 ST)→ 从它起整个保留
   *    (含 ST 只到一半 `\x1b` 的情况——序列开头 `\x1b]` 不能丢);
   * 2. buf 以孤立 `\x1b` 结尾(`\x1b]` 的前半被拆到下个 chunk)→ 保留它;
   * 3. 其余(所有序列已终结)不保留。截断在序列中间的其他转义(CSI 等)
   *    不属于解析范围,丢弃无妨。
   */
  private trimToPending(buf: string): string {
    const lastOscStart = buf.lastIndexOf('\x1b]')
    if (lastOscStart !== -1) {
      const rest = buf.slice(lastOscStart)
      if (!rest.slice(1).includes('\x07') && !rest.slice(1).includes('\x1b\\')) {
        return rest.length <= TAIL_LIMIT ? rest : ''
      }
      return ''
    }
    return buf.endsWith('\x1b') ? '\x1b' : ''
  }
}
