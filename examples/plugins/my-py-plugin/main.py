# my-py-plugin: LyShell Python 插件模板
#
# 激活时 host 会在本文件之前注入全局 `lyshell` 对象(标准库 urllib/json 实现,
# 经本地 HTTP 回连主进程,plugin token 已注入 env)。本文件只写业务逻辑。
#
# lyshell 方法速查(详见 src/main/python/engine.ts 的 LYSHELL_API):
#   lyshell.list_sessions(**filters)         列会话(includeAll/type/tag/search/terminalStatus/...)
#   lyshell.read_output(session_id, lines)   读终端最近输出(ANSI 已剥离)
#   lyshell.send_and_wait(text, session_id)  发输入并等输出(autoNewline 默认补 \n 提交)
#   lyshell.send(text, session_id)           发原始输入(支持 \n \x03 \x1a \t)
#   lyshell.execute(cmd, session_id)         独立 exec 通道跑命令(不继承交互 PTY 的 cwd)
#   lyshell.wait_for(pattern, session_id)    不发输入,等模式出现
#   lyshell.get_current_session() / set_session(sid)  默认会话
#
# 会话解析顺序:显式 session_id 参数 > set_session > env LYSHELL_SESSION_ID,皆空抛错。

print("[my-py-plugin] activating")

# 1) 发现会话:默认只返回 connected/pinned,includeAll=true 拿全部
result = lyshell.list_sessions(includeAll=True)
sessions = result.get("sessions", []) if isinstance(result, dict) else []
print("[my-py-plugin] {} session(s) total".format(len(sessions)))

connected = [s for s in sessions if s.get("status") == "connected"]
print("[my-py-plugin] {} connected".format(len(connected)))

# 2) 有连着的会话就在第一个上演示读 + 写;没有就只列会话(不报错)
if connected:
    target = connected[0]
    sid = target["id"]
    print("[my-py-plugin] target: {} [{}]".format(target.get("name"), target.get("type")))

    # 读最近输出
    out = lyshell.read_output(session_id=sid, lines=10)
    lines = (out.get("output") or "").strip().splitlines() if isinstance(out, dict) else []
    print("[my-py-plugin] last line: {}".format(lines[-1] if lines else "(empty)"))

    # 发命令并等输出;set_session 后可省 session_id
    lyshell.set_session(sid)
    r = lyshell.send_and_wait("echo hello-from-my-py-plugin")
    clean = (r.get("cleanOutput") or "").strip() if isinstance(r, dict) else ""
    print("[my-py-plugin] send_and_wait -> {}".format(clean))
else:
    print("[my-py-plugin] no connected session; skipping read/write demo")

print("[my-py-plugin] activated")
