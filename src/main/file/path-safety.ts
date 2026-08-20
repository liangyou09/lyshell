import * as path from 'path'
import * as fs from 'fs'

/**
 * 敏感本地路径模式：私钥 / 凭据目录 / 自启动目录。
 * 读侧（upload）命中即拒绝，阻断 prompt-injected agent 经 MCP/IPC 外泄私钥与凭据。
 * 写侧（download）另有下载目录 containment 兜底，防持久化植入。
 * 刻意只列高置信度的敏感目标，避免误伤常规项目文件上传。
 */
const SENSITIVE_LOCAL_PATH_PATTERNS: readonly RegExp[] = [
  // 私钥 / 凭据目录
  /[/\\]\.ssh[/\\]/i,
  /[/\\]\.gnupg[/\\]/i,
  /[/\\]\.aws[/\\]/i,
  /[/\\]\.config[/\\]gcloud[/\\]/i,
  /[/\\]\.kube[/\\]/i,
  /[/\\]\.docker[/\\]/i,
  // 私钥文件（任意目录下的 id_rsa / id_ed25519 / ...）
  /[/\\]id_(?:rsa|ed25519|ecdsa|dsa)(?:_sk)?(?:\.[\w-]+)?$/i,
  // 凭据文件
  /[/\\]\.netrc$/i,
  /[/\\]\.git-credentials$/i,
  // Windows 自启动 / DPAPI 凭据库
  /[/\\](?:Startup|Start Menu)[/\\]/i,
  /[/\\]AppData[/\\](?:Roaming|Local)[/\\]Microsoft[/\\]Credentials/i,
  /[/\\]AppData[/\\]Roaming[/\\]Microsoft[/\\]Protect/i,
]

export interface LocalPathOpts {
  /**
   * write=true 表示本地写（download 落盘）：启用 containmentRoot 包含校验，阻断写到 Startup 等位置。
   * write=false（默认，upload 读本地）：拦截敏感路径，阻断外泄。
   */
  write?: boolean
  /** 写操作的允许根目录（下载目录）；write=true 时应提供。 */
  containmentRoot?: string
}

/**
 * 解析到最近存在的祖先目录的真实路径（跟随符号链接/junction）。
 * download 目标文件可能尚不存在，故从目标向上找到第一个存在的祖先做 realpath，
 * 以检测路径中已存在的符号链接是否指向根目录外部。
 * @returns 真实路径；若一直到文件系统根都不存在则返回 null。
 */
function realpathNearestExisting(p: string): string | null {
  let dir = p
  for (;;) {
    try {
      return fs.realpathSync(dir)
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e
      const parent = path.dirname(dir)
      if (parent === dir) return null  // 到达文件系统根仍不存在
      dir = parent
    }
  }
}

/**
 * 校验 MCP/IPC 传入的 localPath，防止任意本地文件读写。
 *
 * 背景：旧实现仅 `parts.includes('..')`，而 path.normalize 会把绝对路径里的 .. 折叠掉，
 * 导致任何绝对路径（如 C:\Users\u\.ssh\id_rsa 或 ...\Startup\evil.bat）都能通过——
 * 配合 session token 绕过 allowFileWrite/确认，形成"任意本地文件读写"漏洞。
 *
 * 修复：
 * - path.resolve 折叠 ..（含相对路径穿越），再守一道防御性 .. 检查。
 * - 写（download）：解析后路径必须落在 containmentRoot 内（path.relative 不以 .. 开头、不跨盘）。
 * - 读（upload）：命中敏感路径模式则拒绝。
 * - 符号链接/junction 防护：写侧拒绝已有的最终目标链接，并解析最近存在路径的真实位置；
 *   读侧解析真实路径后再次匹配敏感模式，防止普通名称的链接指向 Startup / .ssh 等位置。
 *
 * 注：realpath 与后续 open 之间存在 TOCTOU 窗口；本应用为单用户本地场景，威胁模型是
 * prompt-injected agent 而非并发本地攻击者竞态，此窗口可接受。
 */
export function assertSafeLocalPath(filePath: string, opts: LocalPathOpts = {}): string {
  const resolved = path.resolve(filePath)
  // resolve 已折叠 ..，这里再守一道（防御性，正常不会命中）
  if (resolved.split(path.sep).includes('..')) {
    throw new Error('localPath contains path traversal')
  }

  if (opts.write) {
    if (!opts.containmentRoot) {
      // 未提供根目录：仅查穿越（调用方对 download 应始终传 containmentRoot）
      return resolved
    }
    const root = path.resolve(opts.containmentRoot)
    // Windows 文件系统大小写不敏感，统一小写后再做 relative 比较，避免盘符/目录大小写差异误判为越界
    const isWin = process.platform === 'win32'
    const cmp = (p: string) => (isWin ? p.toLowerCase() : p)
    const rel = path.relative(cmp(root), cmp(resolved))
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`localPath must stay within the download directory (${root})`)
    }

    // 最终目标只要已是符号链接就拒绝。lstat 不跟随链接，因此断链也能识别；否则 realpath
    // 会因链接目标 ENOENT 回退到根内父目录，后续 open/fastGet 仍会跟随链接写到根外。
    try {
      if (fs.lstatSync(resolved).isSymbolicLink()) {
        throw new Error(`localPath must stay within the download directory (${root})`)
      }
    } catch (e: any) {
      if (e instanceof Error && /download directory/.test(e.message)) throw e
      if (e?.code !== 'ENOENT') throw e
    }

    // 符号链接/junction 防护：词法校验通过的路径可能某级目录是指向外部的链接。
    // 对目标路径开始查找最近存在项；目标不存在时自然回退到祖先目录。
    try {
      const realRoot = fs.realpathSync(root)
      const realTarget = realpathNearestExisting(resolved)
      if (realTarget !== null) {
        const realRel = path.relative(cmp(realRoot), cmp(realTarget))
        if (realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) {
          throw new Error(`localPath must stay within the download directory (${root})`)
        }
      }
    } catch (e: any) {
      if (e instanceof Error && /download directory/.test(e.message)) throw e
      // root/祖先不存在（测试 fixture 或目录尚未创建）：词法校验已是兜底，open 会因目录缺失失败。
    }
    return resolved
  }

  // 读：拦截敏感路径
  for (const re of SENSITIVE_LOCAL_PATH_PATTERNS) {
    if (re.test(resolved)) {
      throw new Error('localPath points to a sensitive location (private key / credentials / autostart)')
    }
  }
  // 符号链接防护：普通名称的符号链接可指向 .ssh/id_rsa 等敏感文件。realpath 解析真实路径后
  // 再次匹配敏感模式。文件尚不存在（ENOENT）时跳过--调用方的 stat 自会失败。
  try {
    const real = fs.realpathSync(resolved)
    for (const re of SENSITIVE_LOCAL_PATH_PATTERNS) {
      if (re.test(real)) {
        throw new Error('localPath points to a sensitive location (private key / credentials / autostart)')
      }
    }
  } catch (e: any) {
    if (e instanceof Error && /sensitive location/.test(e.message)) throw e
    // ENOENT 或其他 fs 错误：词法结果已足够，调用方 stat 会自然失败。
  }
  return resolved
}
