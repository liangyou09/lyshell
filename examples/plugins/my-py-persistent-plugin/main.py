# my-py-persistent-plugin: LyShell Python 常驻插件模板
#
# 激活时 host 会在本文件之前注入全局 `lyshell` 对象，本进程长期保持，
# 直到用户在 PluginPanel 禁用/卸载或 LyShell 退出。
#
# 注意：MVP 阶段 persistent python 插件仅支持 onStartup/* 激活一次；
# onCommand/onConnectionType 事件分发需后续实现。

import os
import time

print("[my-py-persistent-plugin] activating (pid={})".format(os.getpid()))

# 示例：每 5 秒打印一次会话数，持续运行。
try:
    while True:
        try:
            result = lyshell.list_sessions(includeAll=True)
            sessions = result.get("sessions", []) if isinstance(result, dict) else []
            print("[my-py-persistent-plugin] {} session(s)".format(len(sessions)))
        except Exception as e:
            print("[my-py-persistent-plugin] list_sessions error: {}".format(e))
        time.sleep(5)
except KeyboardInterrupt:
    pass

print("[my-py-persistent-plugin] deactivated")
