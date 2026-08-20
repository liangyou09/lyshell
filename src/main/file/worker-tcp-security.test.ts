import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 这些测试锁定 exec/Python-TCP 传输路径的安全不变量（round-5 🔴 修复）：
// 文件流量必须走 SSH direct-tcpip 隧道（forwardOut），Python server 仅绑定 127.0.0.1，
// 且有一次 token 握手防同主机抢连。任何回退为 0.0.0.0 明文裸 TCP 的改动都会被这里拦下。
//
// Worker 在 worker_threads 里跑、依赖真实 SSH，无法单测运行时行为；
// 但这些不变量都是「生成的 Python 脚本 + TS 直连代码」的直接文本，源码文本即行为，
// 因此用源码扫描锁定。

const readSource = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf-8').replace(/\r\n/g, '\n')
const DL = readSource('src/main/file/download-worker.ts')
const UL = readSource('src/main/file/upload-worker.ts')
const SFTP = readSource('src/main/file/sftp.ts')
const DL_MANAGER = readSource('src/main/file/download-worker-manager.ts')
const UL_MANAGER = readSource('src/main/file/upload-worker-manager.ts')

describe('exec/Python-TCP 传输安全不变量', () => {
  for (const [name, src] of [['download-worker', DL], ['upload-worker', UL]] as const) {
    describe(name, () => {
      it('Python server 绑定 127.0.0.1，不再绑定 0.0.0.0', () => {
        expect(src).toContain('server.bind(("127.0.0.1", 0))')
        expect(src).not.toContain('server.bind(("0.0.0.0"')
      })

      it('使用 SSH direct-tcpip 隧道（forwardOut），不用裸 TCP', () => {
        expect(src).toContain('client.forwardOut(')
        expect(src).not.toContain('net.connect(')
        expect(src).not.toContain('new net.Socket()')
        expect(src).not.toMatch(/import \* as net from 'net'/)
      })

      it('有一次 token 握手防同主机抢连劫持', () => {
        // server 生成 token 经 SSH stdout 回传
        expect(src).toContain('===LYSHELL_TOKEN:')
        expect(src).toContain('token_hex = os.urandom(32).hex()')
        // accept 循环：收到错误 token 不放行，继续 accept 下一个连接
        expect(src).toContain('while conn is None')
        expect(src).toContain('hmac.compare_digest')
      })
    })
  }

  it('download-worker 错误路径有 fd 清理（资源泄漏修复）', () => {
    // closeFd 至少在 success / tunnel error / forwardOut 失败 / 超时 路径被调用
    expect(DL).toContain('const closeFd =')
    const calls = DL.match(/closeFd\(\)/g)
    expect(calls?.length).toBeGreaterThanOrEqual(3)
  })

  it('download-worker 仅在 finishDownload 最终确认后发送 complete', () => {
    const execBody = DL.slice(DL.indexOf('function downloadViaExecPython('))
    const finishBody = execBody.slice(execBody.indexOf('function finishDownload()'))
    expect(execBody.match(/type: 'complete'/g)).toHaveLength(1)
    expect(finishBody).toContain("sendMessage({ type: 'complete'")
    expect(execBody).not.toContain('scheduleSuccessfulFinish')
    expect(execBody).toContain("if (!settled)")
    expect(execBody).toContain("failDownload(new Error('Download timeout'))")
    expect(DL).toContain('remoteDone = true')
    expect(DL).toContain('commandStream?.end()')
    expect(DL).toContain('clearTimeout(timeoutTimer)')
    expect(DL).toContain('timeoutTimer.unref?.()')
  })

  it('download-worker 数据接收完成即调用 finishDownload 收敛（防 DONE 先于数据到达的竞态）', () => {
    // LYSHELL_DONE 走 exec stdout、文件数据走 SSH 隧道，两条流独立；DONE 可能先于最后数据到达，
    // 此时 finishDownload 因 !transferComplete && remoteDone 早退。数据置 transferComplete 后必须再调
    // finishDownload() 发出 complete，否则 exec close 也早退时 complete 永不发出，最终被超时判定失败。
    const normalStart = DL.indexOf('if (transferred >= expectedSize)')
    expect(normalStart).toBeGreaterThan(-1)
    const normalBlock = DL.slice(normalStart, DL.indexOf('break', normalStart))
    expect(normalBlock).toContain('transferComplete = true')
    expect(normalBlock).toContain('finishDownload()')

    // 0 字节路径同样须收敛（header 走隧道、DONE 走 exec stdout，后者可能先于 header 处理到达）
    const zeroStart = DL.indexOf('if (expectedSize === 0)')
    const zeroBlock = DL.slice(zeroStart, DL.indexOf('break', zeroStart))
    expect(zeroBlock).toContain('transferComplete = true')
    expect(zeroBlock).toContain('finishDownload()')
  })

  it('download shell/exec 建立失败统一由 failDownload 发送单个 error', () => {
    expect(DL).toContain('failDownload(err, `Shell error: ${err.message}`)')
    expect(DL).toContain('failDownload(err, `Exec error: ${err.message}`)')
    expect(DL).not.toContain("sendMessage({ type: 'error', taskId, sessionId, error: err.message })\n        failDownload(err)")
  })

  it('download/upload exec command stream 都监听 error 并进入统一清理', () => {
    expect(DL).toContain('failDownload(err, `Exec stream error: ${err.message}`)')
    expect(UL).toContain('`Exec stream error: ${err.message}`')
    for (const src of [DL, UL]) {
      const execBody = src.slice(src.indexOf('function executeWithExec('), src.indexOf('function connectToPython('))
      expect(execBody).toContain("stream.on('error', (err: Error) => {")
    }
    expect(UL).toContain("stream.on('close', () => {")
    expect(UL).toContain('if (uploadResolved) return')
  })

  it('oneshot activate 超时进入 shutdown，迟到 spawn 会立即终止', () => {
    const runner = fs.readFileSync(path.join(process.cwd(), 'src/main/plugin-host/oneshot.ts'), 'utf-8')
    expect(runner).toContain('finally {\n    shuttingDown = true\n    await cleanup()')
    expect(runner).toContain('if (shuttingDown) {')
  })

  it('upload-worker 删除了空操作的 TCP data 处理器（死代码清理）', () => {
    // 旧实现有 tcpClient.on('data', () => { /* 注释 */ })；上传方向 server 不回传数据，该处理器是死代码
    expect(UL).not.toContain('tcpClient.on(\'data\'')
  })

  it('log() 经 redactSecrets 闸口脱敏，一次性握手 token 不进日志', () => {
    // worker 把原始 shell/exec stdout 行打日志（如 `Shell: ${line}`），其中含
    // ===LYSHELL_TOKEN:<hex>===；log() 必须经 redactSecrets 脱敏，防 electron-log 落盘。
    for (const src of [DL, UL]) {
      expect(src).toContain("import { redactSecrets } from './redact'")
      expect(src).toMatch(/message:\s*redactSecrets\(message\)/)
    }
  })

  it('upload-worker 成功/失败会清理整体超时 timer，timer 不单独保持线程存活', () => {
    expect(UL).toContain('clearTimeout(timeoutTimer)')
    expect(UL).toContain('timeoutTimer.unref?.()')
    expect(UL).toContain('const timeoutTimer = setTimeout(')
  })

  it('upload-worker 顶层入口成功/失败均 process.exit（与下载侧一致，防异常后 Worker 不退出）', () => {
    // 缺 process.exit 时，顶层异常或资源未自然关闭会让 Worker 线程残留；管理器靠 exit 事件回收，
    // 不退出 = 永久挂起。下载侧已有 exit(0/1)，上传须一致。
    const entry = UL.slice(UL.indexOf('// Worker 入口'))
    expect(entry).toContain('process.exit(0)')
    expect(entry).toContain('process.exit(1)')
    // catch 不重发 error：各失败路径已在 reject 前发唯一终态消息，catch 只日志+退出，
    // 避免 manager 收到两条 error 把同一失败报两次给渲染进程。
    const catchBody = entry.slice(entry.indexOf('.catch('))
    expect(catchBody).not.toContain("type: 'error'")
  })

  it('upload-worker shell 脚本写入异常路径发终态 error 再 reject（catch 不兜底重发）', () => {
    // 该 catch 原先直接 reject 未发 error，是唯一无终态消息的 reject 路径；
    // 入口 catch 不再兜底后，此路径必须自发 error，否则 manager 只能报 "exited with code 1" 丢失原因。
    const timerStart = UL.indexOf('shellScriptTimer = setTimeout(')
    const timerBlock = UL.slice(timerStart, UL.indexOf('shellScriptTimer.unref?.()', timerStart) + 'shellScriptTimer.unref?.()'.length)
    const writeCatch = timerBlock.slice(timerBlock.lastIndexOf('} catch (error) {'))
    expect(writeCatch).toContain("type: 'error'")
    expect(writeCatch).toContain('reject(error as Error)')
  })

  it('upload-worker 本地文件缺失发 error 后 throw（走 catch exit(1)，不走成功 return）', () => {
    // 原 return 会让入口 .then exit(0)：错误却以成功码退出，且 manager 日志误报 completed。
    const start = UL.indexOf('if (!fs.existsSync(localPath))')
    expect(start).toBeGreaterThan(-1)
    const block = UL.slice(start, UL.indexOf('// 建立 SSH 连接', start))
    expect(block).toContain("throw new Error('Local file not found')")
    expect(block).not.toMatch(/^\s*return\s*$/m)
  })

  it('shell 延迟写 timer 在终态清理，写入前检查完成态并监听 stream error', () => {
    for (const src of [DL, UL]) {
      expect(src).toContain('let shellScriptTimer:')
      expect(src).toContain('clearShellScriptTimer()')
      expect(src).toContain("stream.on('error', (err: Error) => {")
      expect(src).toContain('shellScriptTimer.unref?.()')
    }
    expect(DL).toContain('if (settled) return')
    expect(UL).toContain('if (uploadResolved) return')
  })

  it('远端 Python accept 循环有总 deadline', () => {
    for (const src of [DL, UL]) {
      expect(src).toContain('accept_deadline = time.monotonic() + 60')
      expect(src).toContain('server.settimeout(1)')
      expect(src).toContain('except socket.timeout:')
    }
    expect(DL).toContain('raise TimeoutError("download connection deadline exceeded")')
    expect(UL).toContain('raise TimeoutError("upload connection deadline exceeded")')
  })

  it('SFTP mkdir 模糊 failure 仅在 stat 确认目录后忽略', () => {
    for (const src of [SFTP, UL]) {
      expect(src).toContain('sftp.stat(cur,')
      expect(src).toContain('attrs?.isDirectory()')
      expect(src).toContain('reject(err)')
    }
  })

  it('worker 无终态消息退出时无论 code 是否为 0 都 reject', () => {
    expect(DL_MANAGER).toContain('Download worker exited without a terminal message')
    expect(UL_MANAGER).toContain('Upload worker exited without a terminal message')
    for (const src of [DL_MANAGER, UL_MANAGER]) {
      expect(src).toContain("worker.on('exit', (code) => {")
      expect(src).toContain('if (!settled)')
      expect(src).toContain('reject(error)')
      expect(src.indexOf('reject(error)')).toBeGreaterThan(src.indexOf("worker.on('exit'"))
    }
  })
})
