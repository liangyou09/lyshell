// braille-zongzhu: 终端 Braille 点阵「铁山靠」/「打篮球」动画 demo 插件
//
// 与 braille-punch/braille-wave 同构:把随插件附带的 render.py 经 shell heredoc
// 管进远程 `python3 -u -` 的 stdin(定界符加引号 <<'TAG' 禁展开,本体逐字传入),
// 远程不落盘脚本。
//
// 触发:onStartup。安装并启用 = 在所有「停在 shell 提示符」的已连接 SSH 会话上各放一遍。
// 安全门:发前调 lyshell_wait_for_prompt,处于 vim/htop/跑命令的会话跳过。
//
// 模式:修改本文件顶部的 MODE 常量即可切换。render.py 接收 MODE 环境变量:
//   tieshankao - 铁山靠(侧身顶肩,默认)
//   basketball - 打篮球(运球/举球)
//   both       - 两种动作各放 6 秒自动切换
//
// 日志走 console.error(stderr):host-mgr 只把 host 的 stderr 转 electron-log。

const fs = require('fs')
const path = require('path')

const HEREDOC_TAG = 'LYSHELL_ZONGZHU'
const PROMPT_GATE_TIMEOUT_MS = 1500
const MODE = 'basketball' // <-- 改成 'tieshankao' 或 'both'

let api

function readScript() {
  const p = path.join(__dirname, 'render.py')
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * 组装 heredoc。把 PS2/echo 还原和 python 放同一命令列表,只发一个提示符。
 * stty -echo + PS2='' 让 heredoc 体不回显;清屏交给 render.py 退出时发 ANSI。
 * 整串零反斜杠,send_input 转义处理器 no-op。
 */
function buildHeredoc(script, mode) {
  const pre = `__ps2=$PS2; stty -echo 2>/dev/null; PS2=''; `
  const cmd = `MODE=${mode} python3 -u - <<'${HEREDOC_TAG}'; PS2=$__ps2; stty echo 2>/dev/null`
  return `${pre}${cmd}\n${script}\n${HEREDOC_TAG}`
}

async function playOnSession(sessionId, heredoc, mode) {
  const gate = await api.call('lyshell_wait_for_prompt', {
    sessionId,
    timeoutMs: PROMPT_GATE_TIMEOUT_MS
  })
  if (!gate.patternMatched) {
    console.error(
      `[braille-zongzhu] skip ${sessionId}: 未确认停在 shell 提示符(可能在 vim/htop/跑命令),免得把 heredoc 打进去`
    )
    return
  }
  await api.call('lyshell_send_input', { sessionId, text: heredoc })
  console.error(`[braille-zongzhu] launched ${mode} on ${sessionId}`)
}

async function activate(pluginApi) {
  api = pluginApi
  console.error(`[braille-zongzhu] activated (caps: ${[...api.grantedCapabilities].join(', ')})`)

  try {
    const mode = ['tieshankao', 'basketball', 'both'].includes(MODE) ? MODE : 'tieshankao'

    const { sessions = [] } = await api.call('lyshell_list_sessions', { terminalStatus: true })
    const ssh = sessions.filter((s) => s.type === 'ssh' && s.status === 'connected')
    if (ssh.length === 0) {
      console.error('[braille-zongzhu] 没有已连接的 SSH 会话 -- 先连一个再启用本插件')
      return
    }
    console.error(`[braille-zongzhu] ${ssh.length} 个已连接 SSH 会话,逐个过提示符门后播放 ${mode}`)

    const heredoc = buildHeredoc(readScript(), mode)
    await Promise.all(
      ssh.map((s) =>
        playOnSession(s.id, heredoc, mode).catch((e) => {
          console.error(`[braille-zongzhu] ${s.id} 出错:`, e?.message || e)
        })
      )
    )
  } catch (e) {
    console.error('[braille-zongzhu] activate error:', e?.message || e)
  }
}

function deactivate() {
  console.error('[braille-zongzhu] deactivated')
}

module.exports = { activate, deactivate }
