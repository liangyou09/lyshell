import { TERMINAL_ENCODINGS } from './constants'
import { ConnectionType } from './types'
import type { SessionConfig } from './types'

/**
 * 净化 terminal.encoding：编码值不在 TERMINAL_ENCODINGS 白名单时回落 utf-8。
 *
 * 收口消费者是 repository（load 时兜历史盘数据、saveSession 时兜新写入 —— 内存 map
 * 恒为合法值，SESSION_GET/LIST、MCP list_sessions、复用路径全部只面对干净数据）；
 * IPC 入口（create/update/connect）在信任边界上各自再调一次 —— 临时会话（空 id）
 * 不经 repository 直连 createSession，必须先净化。编码是可选语义字段，静默回落比打回
 * 整次保存友好（name/type 等必填项仍走 assert 报错）。
 * terminal 的形状不在此处保证（可为任意 JSON）：真值原语（字符串等）直接放过 ——
 * 净化器自己先抛 TypeError 就本末倒置了；下游全是 terminal?.encoding || 'utf-8'
 * 的容错读取，原语形状与改动前一样被吞掉。对对象才检查/回填，
 * 非法值（undefined/数字/off-whitelist 字符串）一律归位 utf-8。
 */
export function sanitizeSessionEncoding(config: SessionConfig): void {
  const terminal = config.terminal
  if (!terminal || typeof terminal !== 'object') return
  // local 恒归一 utf-8：ConPTY 无编码概念（LocalConnector 不建解码流、setEncoding 空实现），
  // local+gbk 之类的存值是与运行时约束矛盾的脏数据（导入历史文件 / updateSession 整包
  // 写入都可能带进来）。UI 入口（SessionDialog 提交）与 MCP 入口（create_session 校验）
  // 各自挡了一道，这里在收口处统一兜底 —— 状态栏读数、MCP set_session_encoding 对 local
  // 全都按 utf-8 处理，存盘值也必须一致
  if (config.type === ConnectionType.LOCAL) {
    terminal.encoding = 'utf-8'
    return
  }
  if (!TERMINAL_ENCODINGS.includes(terminal.encoding)) {
    terminal.encoding = 'utf-8'
  }
}
