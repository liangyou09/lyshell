/**
 * 脱敏日志中可能出现的密钥/令牌，防止经 electron-log 落盘泄漏。
 *
 * 当前覆盖 exec/Python-TCP 传输路径的一次性握手 token：Python server 把
 * `===NOVASHELL_TOKEN:<hex>===` 经 SSH stdout（加密）回传 Worker，Worker 解析后
 * 用于隧道握手。若 Worker 把原始 stdout 行打日志（如 `Shell: ${line}`），token
 * 会随 electron-log 明文落盘。在 Worker 的 `log()` 闸口统一脱敏，确保 token
 * 不以任何日志形式离开 Worker 进程。
 */
export function redactSecrets(s: string): string {
  return s.replace(/===NOVASHELL_TOKEN:[0-9a-fA-F]+===/g, '===NOVASHELL_TOKEN:***REDACTED***===')
}
