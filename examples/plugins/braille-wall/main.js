// braille-wall: 跨终端 3D 线框立方体 demo 插件(node runtime, 远程 SSH 会话版)
//
// N 个已连接 SSH 会话各画一片竖切片,合成一个横跨所有终端的旋转线框立方体。
// 同步:stage-and-release。插件先把脚本发到所有会话,python 打印 READY 后阻塞读 stdin;
// 等所有 READY 到齐,插件同时向所有会话发一个触发字节,各 python 收到后立即开跑。
// 不依赖 NTP/时钟,跨机也同步(误差只剩触发字节到达的几十 ms)。
//
// 传输:render.py 经 base64 编码后用 quoted heredoc 写到远端临时文件,再让 python 读取执行。
// heredoc 体拆成 80 列一行,避开 busybox/ash 的单行输入限制;delimiter 用 base64 不含的 `_`。
// 为减少往返,把「关回显」和「写 heredoc」合并成一次 send_and_wait。
//
// 触发:onStartup(onCommand 在 UI 尚未接线)。安装并启用 = 在所有「停在 shell 提示符」
// 的已连接 SSH 会话上联动播放一遍。安全门:发前调 lyshell_wait_for_prompt,处于 vim/htop/
// 跑命令的会话跳过。会话顺序(list_sessions 返回序)即左->右 pane 序;日志打印 index<->
// sessionId 映射,用户按此排布 pane。要求各 pane 等宽(不等宽切片会错位,但立方体仍能转动)。
//
// 日志走 console.error(stderr):host-mgr 只把 host 的 stderr 转 electron-log。

const fs = require('fs')
const path = require('path')

const PROMPT_GATE_TIMEOUT_MS = 1500
const READY_TIMEOUT_MS = 10000
const TRIGGER_CHAR = 'g'
const HEREDOC_LINE_WIDTH = 80

let api
let activeSessionIds = []

function randomToken() {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * 读 render.py,归一化行尾后转 base64。
 */
function readScriptBase64() {
  const src = fs.readFileSync(path.join(__dirname, 'render.py'), 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return Buffer.from(src).toString('base64')
}

/**
 * 生成两段式命令:
 *  1. 关回显,紧接着用 quoted heredoc 把 base64 写入 /tmp/.lyshell-bw-xxx.b64
 *  2. python 解码执行;退出后恢复回显/PS2 并删临时文件
 */
function buildStageCommands(encodedScript, index, total) {
  const token = randomToken()
  const tmp = `/tmp/.lyshell-bw-${token}.b64`
  const delim = '__LYSHELL_BW_EOF__'

  const lines = []
  for (let i = 0; i < encodedScript.length; i += HEREDOC_LINE_WIDTH) {
    lines.push(encodedScript.slice(i, i + HEREDOC_LINE_WIDTH))
  }

  // 第一段:先执行 stty -echo(只回显这一短行),紧接着读 heredoc。
  // shell 按行处理,等 stty 生效后再读 heredoc,因此 heredoc 体不会被回显。
  const stage1 =
    `__ps2=$PS2; stty -echo 2>/dev/null; PS2=''\n` +
    `cat > ${tmp} <<'${delim}'\n` +
    lines.join('\n') +
    `\n${delim}`

  const stage2 =
    `INDEX=${index} TOTAL=${total} python3 -u -c "import base64; exec(base64.b64decode(open('${tmp}').read()))"; PS2=$__ps2; stty echo 2>/dev/null; rm -f ${tmp}`

  return [stage1, stage2]
}

async function gateSession(sessionId, index, total) {
  const gate = await api.call('lyshell_wait_for_prompt', {
    sessionId,
    timeoutMs: PROMPT_GATE_TIMEOUT_MS
  })
  if (!gate.patternMatched) {
    console.error(`[braille-wall] skip ${sessionId} (pane${index}): 未确认停在 shell 提示符(可能在 vim/htop/跑命令)`)
    return false
  }
  return true
}

/**
 * 重置终端状态:发 Ctrl+C 中断可能残留的 python,再恢复回显和 PS2。
 * 用于 activate 开头(清理上次残留)和 deactivate(优雅退出)。
 */
async function resetSession(sessionId, index) {
  try {
    await api.call('lyshell_send_input', {
      sessionId,
      text: '\x03stty echo 2>/dev/null; PS2=$__ps2',
      autoNewline: true
    })
    console.error(`[braille-wall] pane${index} reset sent`)
  } catch (e) {
    console.error(`[braille-wall] pane${index} reset 失败:`, e?.message || e)
  }
}

async function restoreEcho(sessionId, index) {
  try {
    await api.call('lyshell_send_input', {
      sessionId,
      text: `PS2=$__ps2; stty echo 2>/dev/null`,
      autoNewline: true
    })
  } catch (e) {
    console.error(`[braille-wall] pane${index} 恢复回显失败:`, e?.message || e)
  }
}

async function stageSession(sessionId, commands, index) {
  try {
    // 第一段:关回显 + heredoc 写文件。等提示符回来即表示 cat 完成。
    await api.call('lyshell_send_and_wait', {
      sessionId,
      text: commands[0],
      waitForPattern: '[$#>%]\\s*$',
      waitMs: 300,
      idleMs: 200,
      maxWaitMs: 10000
    })

    // 第二段:运行 python 并等待 READY marker
    const result = await api.call('lyshell_send_and_wait', {
      sessionId,
      text: commands[1],
      waitForPattern: 'LYSHELL_WALL_READY',
      waitMs: 200,
      idleMs: 100,
      maxWaitMs: READY_TIMEOUT_MS
    })
    if (!result.patternMatched) {
      console.error(`[braille-wall] pane${index} ${sessionId}: 未收到 READY marker`)
      return false
    }
    console.error(`[braille-wall] pane${index} ready`)
    return true
  } catch (e) {
    console.error(`[braille-wall] pane${index} ${sessionId} stage 出错:`, e?.message || e)
    await restoreEcho(sessionId, index)
    return false
  }
}

async function sendTrigger(sessionId, index) {
  // 终端在 canonical 模式下会缓冲单行输入,只发 'g' 不会立即送到 python。
  // 补一个换行让 line discipline 立刻投递;python 只读第一个字节即可。
  await api.call('lyshell_send_input', { sessionId, text: TRIGGER_CHAR, autoNewline: true })
  console.error(`[braille-wall] trigger sent to pane${index}`)
}

async function activate(pluginApi) {
  api = pluginApi
  console.error(`[braille-wall] activated (caps: ${[...api.grantedCapabilities].join(', ')})`)

  try {
    const { sessions = [] } = await api.call('lyshell_list_sessions', { terminalStatus: true })
    const ssh = sessions.filter((s) => s.type === 'ssh' && s.status === 'connected')
    if (ssh.length === 0) {
      console.error('[braille-wall] 没有已连接的 SSH 会话 -- 先连若干个再启用本插件')
      return
    }
    const total = ssh.length
    console.error(`[braille-wall] ${total} 个已连接 SSH 会话,按序作 pane0..pane${total - 1}(左->右):`)
    ssh.forEach((s, i) => console.error(`[braille-wall]   pane${i} -> ${s.id} (${s.name || s.host || ''})`))

    // 记住 sessionId,deactivate 时做清理
    activeSessionIds = ssh.map((s, i) => ({ sessionId: s.id, index: i }))

    // Phase 0: 先重置终端状态(清可能残留的 python/恢复回显),给 gate 一个干净环境
    await Promise.all(
      ssh.map((s, i) =>
        resetSession(s.id, i).catch((e) => {
          console.error(`[braille-wall] pane${i} ${s.id} reset 出错:`, e?.message || e)
        })
      )
    )
    // 给 reset 命令一点执行时间
    await new Promise((r) => setTimeout(r, 500))

    const encodedScript = readScriptBase64()
    const commandSets = ssh.map((s, i) => buildStageCommands(encodedScript, i, total))

    // Phase 1: 确认所有会话都停在提示符
    const gated = await Promise.all(
      ssh.map((s, i) =>
        gateSession(s.id, i, total).catch((e) => {
          console.error(`[braille-wall] pane${i} ${s.id} gate 出错:`, e?.message || e)
          return false
        })
      )
    )

    // Phase 2: 并发 staged 到所有会话,每会话内两段顺序执行,第二段等待 READY
    const ready = await Promise.all(
      ssh.map((s, i) =>
        gated[i]
          ? stageSession(s.id, commandSets[i], i).catch((e) => {
              console.error(`[braille-wall] pane${i} ${s.id} stage 出错:`, e?.message || e)
              return false
            })
          : Promise.resolve(false)
      )
    )

    if (!ready.every((r) => r)) {
      console.error('[braille-wall] 未所有 pane 就绪,取消触发')
      return
    }

    // Phase 3: 同时向所有会话发触发字节
    console.error('[braille-wall] all ready, sending triggers simultaneously')
    await Promise.all(
      ssh.map((s, i) =>
        sendTrigger(s.id, i).catch((e) => {
          console.error(`[braille-wall] pane${i} ${s.id} 触发失败:`, e?.message || e)
        })
      )
    )
  } catch (e) {
    console.error('[braille-wall] activate error:', e?.message || e)
  }
}

async function deactivate() {
  console.error('[braille-wall] deactivating...')
  if (api && activeSessionIds.length > 0) {
    await Promise.all(
      activeSessionIds.map(({ sessionId, index }) =>
        resetSession(sessionId, index).catch((e) => {
          console.error(`[braille-wall] pane${index} ${sessionId} deactivate reset 失败:`, e?.message || e)
        })
      )
    )
  }
  activeSessionIds = []
  console.error('[braille-wall] deactivated')
}

module.exports = { activate, deactivate }
