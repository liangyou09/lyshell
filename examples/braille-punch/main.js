// braille-punch: 第一人称 3D 出拳动画 demo 插件（node runtime, 远程 SSH 会话版）
//
// 与 braille-wave 同构:把随插件附带的 render.py 经 shell heredoc 管进远程
// `python3 -u -` 的 stdin(定界符加引号 <<'TAG' 禁展开,本体逐字传入),远程不落盘脚本。
// render.py 零反斜杠,send_input 的转义处理器对本体是 no-op。
//
// 触发:onStartup。安装并启用 = 在所有「停在 shell 提示符」的已连接 SSH 会话上各放一遍。
// 安全门:发前调 lyshell_wait_for_prompt,处于 vim/htop/跑命令的会话跳过。
//
// 日志走 console.error(stderr):host-mgr 只把 host 的 stderr 转 electron-log。

const fs = require('fs')
const path = require('path')

const HEREDOC_TAG = 'LYSHELL_PUNCH'
const PROMPT_GATE_TIMEOUT_MS = 1500

let api

function readScript() {
  const p = path.join(__dirname, 'render.py')
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * 把 PS2/echo 还原(; PS2=$__ps2; stty echo)和 python 放同一命令列表(接 <<'TAG' 之后用 ; 串),
 * shell 跑完整条只发一个提示符 -- 否则还原命令单独成行会多出一个提示符(演示完两个提示符)。
 * stty -echo + PS2='' 让本体不回显;清屏交给 render.py 退出时发 ANSI ESC[2J(不依赖 clear
 * 二进制)。整串零反斜杠,send_input 转义处理器 no-op。末行 TAG 末字符可打印触发 autoNewline。
 */
function buildHeredoc(script) {
  const pre = `__ps2=$PS2; stty -echo 2>/dev/null; PS2=''; `
  const cmd = `python3 -u - <<'${HEREDOC_TAG}'; PS2=$__ps2; stty echo 2>/dev/null`
  return `${pre}${cmd}\n${script}\n${HEREDOC_TAG}`
}

async function playOnSession(sessionId, heredoc) {
  const gate = await api.call('lyshell_wait_for_prompt', {
    sessionId,
    timeoutMs: PROMPT_GATE_TIMEOUT_MS
  })
  if (!gate.patternMatched) {
    console.error(
      `[braille-punch] skip ${sessionId}: 未确认停在 shell 提示符(可能在 vim/htop/跑命令),免得把 heredoc 打进去`
    )
    return
  }
  await api.call('lyshell_send_input', { sessionId, text: heredoc })
  console.error(`[braille-punch] launched on ${sessionId}`)
}

async function activate(pluginApi) {
  api = pluginApi
  console.error(`[braille-punch] activated (caps: ${[...api.grantedCapabilities].join(', ')})`)

  try {
    const { sessions = [] } = await api.call('lyshell_list_sessions', { terminalStatus: true })
    const ssh = sessions.filter((s) => s.type === 'ssh' && s.status === 'connected')
    if (ssh.length === 0) {
      console.error('[braille-punch] 没有已连接的 SSH 会话 -- 先连一个再启用本插件')
      return
    }
    console.error(`[braille-punch] ${ssh.length} 个已连接 SSH 会话,逐个过提示符门后放出拳动画`)

    const heredoc = buildHeredoc(readScript())
    await Promise.all(
      ssh.map((s) =>
        playOnSession(s.id, heredoc).catch((e) => {
          console.error(`[braille-punch] ${s.id} 出错:`, e?.message || e)
        })
      )
    )
  } catch (e) {
    console.error('[braille-punch] activate error:', e?.message || e)
  }
}

function deactivate() {
  console.error('[braille-punch] deactivated')
}

module.exports = { activate, deactivate }
