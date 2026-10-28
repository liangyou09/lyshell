/* eslint-disable no-control-regex */
/**
 * SSH 重连上下文辅助函数(纯函数,无 IO)。
 *
 * 职责边界:
 * - 记住“上次所在的普通 POSIX 目录”,重连时尽力 `cd` 回去;
 * - 记住“一小段可读输出尾部”,重连后作为上下文展示。
 *
 * 明确不做的事(避免变成终端仿真器或框架):
 * - 不解析提示符猜目录(提示符格式无穷多,猜错会 `cd` 到错误位置);
 * - 不写 shell 启动脚本、不注入 tmux/exec/startup 命令;
 * - 不读写文件、不访问网络、不缓存用户输入。
 *
 * 之所以只接受“绝对 POSIX 路径”:远端 shell 一旦不是 POSIX(cmd/pwsh 与
 * 各类 Windows 路径写法),`cd --` 的语义就不再成立;宁可放弃恢复目录,
 * 也不要生成一条会失败或去错位置的命令。
 */

import { stripAnsiToText } from './ansi-stripper'

/** 输出上下文尾部上限(UTF-16 码元),与服务端字段预算一致 */
export const SSH_CONTEXT_LIMIT = 32768

/** 目录字符串长度上限(与上下文同量级,防止异常长串进入命令) */
const DIRECTORY_MAX_LENGTH = 4096

/** ASCII 控制字符(0x00-0x1F)与 DEL(0x7F):换行/制表符也算控制字符 */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/

/**
 * Windows 盘符伪 POSIX 路径:`/C:/Users/...`、`/C:\Users\...`、`/C:`
 * 这类值来自把 Windows 路径前面硬加一个斜杠,在 POSIX 上会变成名为 `C:`
 * 的目录 —— 必须拒绝,而不是“修一下”。
 */
const WINDOWS_DRIVE_RE = /^\/[A-Za-z]:([/\\]|$)/

/** 剥离后仍可能残留的不可读字符:DEL 与 C1 控制区(0x80-0x9F) */
const UNREADABLE_RE = /[\x7f\x80-\x9f]/g

/**
 * `ESC` + 中间字节(0x20-0x2F)+ 终结字节 的序列,例如 `ESC ( B`(字符集指定)、
 * `ESC # 8`(屏幕对齐测试)。ansi-stripper 的 ESC_SINGLE_RE 只认 0x40-0x5F,
 * 这类序列会被它剥掉 ESC 却把 `(B` 当正文留下 —— 这里先清掉。
 */
const ESC_WITH_INTERMEDIATES_RE = /\x1b[\x20-\x2f]+[\x30-\x7e]/g

/** 尾巴上未终结的半个同类序列(分块截断的残留),一并丢弃而不是当正文 */
const ESC_TRAILING_PARTIAL_RE = /\x1b[\x20-\x2f]+$/

/**
 * 把未知输入收敛成“可信的绝对 POSIX 目录”。
 *
 * 只做校验,不做任何“猜想式修正”:不 trim、不去尾斜杠、不解析 `.`/`..`、
 * 不展开 `~`。普通空格、引号、`$`、反引号都原样保留 —— 它们由
 * {@link buildSshDirectoryCommand} 负责安全引用。
 *
 * @returns 合法时返回与输入完全一致的原串;否则 `undefined`
 */
export function normalizeSshDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > DIRECTORY_MAX_LENGTH) return undefined
  // 绝对 POSIX 路径:首字符必须是 /
  if (value[0] !== '/') return undefined
  // 拒绝 /C:/... 形式的 Windows 路径伪装
  if (WINDOWS_DRIVE_RE.test(value)) return undefined
  // 任何控制字符(含 \n \r \t)与 DEL 都会撕裂命令行或污染终端
  if (CONTROL_CHAR_RE.test(value)) return undefined
  return value
}

/**
 * 生成用于恢复工作目录的**单条**命令。
 *
 * 输出形如 `cd -- '<path>'\r`,整条路径处于单引号引用内(单引号按 POSIX
 * 习惯转义为 `'\''`),因此 `$`、`` ` ``、`"`、`\`、`;`、`|`、`&`、空格
 * 都不会被 shell 解释。目录不合法时不生成任何命令(返回 `undefined`),
 * 调用方应“只重连、不 cd”。
 */
export function buildSshDirectoryCommand(value: unknown): string | undefined {
  const directory = normalizeSshDirectory(value)
  if (directory === undefined) return undefined
  const quoted = directory.replace(/'/g, `'\\''`)
  return `cd -- '${quoted}'\r`
}

/**
 * 取 text 的尾部,最多 {@link SSH_CONTEXT_LIMIT} 个 UTF-16 码元。
 * 若切点正好落在代理对中间(emoji 等补充平面字符),整体后移一位,
 * 保证返回值里不会出现半个字符。
 */
function takeTail(text: string): string {
  if (text.length <= SSH_CONTEXT_LIMIT) return text
  let start = text.length - SSH_CONTEXT_LIMIT
  const code = text.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start += 1
  return text.slice(start)
}

/** 清洗 → 去不可读字符 → 截尾:唯一的一条规范化路径 */
function normalizeContextText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const text = stripAnsiToText(value.replace(ESC_WITH_INTERMEDIATES_RE, '').replace(ESC_TRAILING_PARTIAL_RE, '')).replace(UNREADABLE_RE, '')
  if (text.length === 0) return undefined
  return takeTail(text)
}

/**
 * 把一段原始终端输出收敛成“只含可读文本的有限尾部”。
 *
 * - 复用 {@link stripAnsiToText}:清掉 CSI/OSC/DCS/单字符转义、退格与回车覆盖,
 *   只留下可读文本,换行与制表符保留;
 * - 再剔除 DEL/C1 残留,并按 {@link SSH_CONTEXT_LIMIT} 截尾(不劈开代理对);
 * - 若 raw 里没有任何可读文本(例如只有清屏序列),退回 previous 的同样规范化
 *   尾部,避免上下文被一次重绘擦空;
 * - previous 也拿不到可读文本时返回 `undefined`。
 *
 * raw 被视为“当前输出的最新快照”(覆盖语义),不是增量拼接。
 */
export function captureSshContext(raw: string, previous?: string): string | undefined {
  return normalizeContextText(raw) ?? normalizeContextText(previous)
}

/** 只用于本机终端显示流：先取消旧转义状态并复位画面，再写纯文本历史与新连接分隔。 */
export function formatSshHistoryForTerminal(history: string): string | undefined {
  const text = captureSshContext(history)
  if (!text) return undefined
  return '\x18\x1bc[LyShell: 本机保存的 SSH 历史，仅供参考]\r\n' +
    text.replace(/\n/g, '\r\n') +
    '\r\n[LyShell: 历史结束，以下为本次新连接输出]\r\n'
}
