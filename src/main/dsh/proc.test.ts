import { describe, it, expect, vi } from 'vitest'

// electron-log 在 Node 测试环境不存在，mock 掉（对齐 web.test.ts）
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))

import {
  DSH_WEB_COMMAND,
  DSH_WEB_SPAWN_ARGS,
  buildDshWebCmdline,
  parseWin32ProcessJson,
  parsePsOutput,
  tokenizeCmdline,
  isLyShellDshWebCmdline,
  isAnchoredProcess,
  isPidAlive,
  findOrphanDshWebPids,
  collectDescendantPids,
  killPidTree,
  sweepOrphanDshWeb,
  recoverRecordedPids,
  selectFirstRoundPids,
  parseProcessStartTime,
  readPidRecord,
  writePidRecord,
  type ProcInfo,
  type RecordedPid
} from './proc'

/** 实测抓到的 LyShell spawn 签名（npm shim 把 bin.js 拆成带引号的独立 token） */
const LYSHELL_DSH_WEB =
  '"node"   "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --port 0 --no-open'

/** 实测抓到的用户手动起的实例 —— 端口写死、参数顺序也不同，不该被清扫命中 */
const MANUAL_DSH_WEB =
  'D:\\software\\nodejs\\node.exe C:\\Users\\u\\AppData\\Roaming\\npm/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port 18123'

function proc(partial: Partial<ProcInfo> & { pid: number }): ProcInfo {
  return { ppid: 0, name: 'node.exe', cmdline: null, ...partial }
}

/** 可变存活表 + 记录每一次 taskkill/signature 调用的最小 deps 替身 */
function makeDeps(opts: {
  procs: ProcInfo[] | null | (() => Promise<ProcInfo[] | null>)
  alive?: Set<number>
  /** taskkill /T 的行为：默认只杀 root（模拟 /T 先杀根就断树） */
  onTreeKill?: (pid: number) => void
  /** 单 pid taskkill / SIGKILL 的行为：默认杀掉目标 */
  onKill?: (pid: number) => void
  /** 覆盖 lookupImageName 的返回值（主力树杀前的身份核对用）；未列出的 pid 回落到快照里的名字 */
  imageNames?: Record<number, string | null>
  /** 模拟 root 当前启动时刻；与 spawn 观察点不符时代表 PID 已复用。 */
  rootStartTime?: number | null
}): {
  deps: Parameters<typeof killPidTree>[2]
  alive: Set<number>
  treeKills: number[]
  singleKills: number[]
  listCalls: () => number
} {
  const alive = opts.alive ?? new Set<number>()
  const treeKills: number[] = []
  const singleKills: number[] = []
  let listCount = 0
  // 静态 procs 时拿它的名字当「当前镜像名」默认值（= 身份未变，核对放行）。
  // 动态进程表沿用上一次枚举结果，模拟树杀前的镜像名查询。
  const staticProcs = typeof opts.procs === 'function' || opts.procs === null ? [] : opts.procs
  let nameByPid = new Map(staticProcs.map((p) => [p.pid, p.name]))
  const deps = {
    ownedRootSpawnedAt: 1000,
    listProcesses: async () => {
      listCount++
      const current = typeof opts.procs === 'function' ? await opts.procs() : opts.procs
      if (current !== null) nameByPid = new Map(current.map((p) => [p.pid, p.name]))
      return current
    },
    isPidAlive: (p: number) => alive.has(p),
    lookupStartTime: async () => opts.rootStartTime === undefined ? 1000 : opts.rootStartTime,
    lookupImageName: async (pid: number) => {
      if (opts.imageNames && pid in opts.imageNames) return opts.imageNames[pid]
      return nameByPid.get(pid) ?? null
    },
    execFile: async (_file: string, args: string[]) => {
      if (args.includes('/T')) {
        const pid = Number(args[args.indexOf('/PID') + 1])
        treeKills.push(pid)
        if (opts.onTreeKill) opts.onTreeKill(pid)
        else alive.delete(pid)
        return ''
      }
      const pid = Number(args[args.indexOf('/PID') + 1])
      singleKills.push(pid)
      if (opts.onKill) opts.onKill(pid)
      else alive.delete(pid)
      return ''
    },
    signalPid: (pid: number) => {
      singleKills.push(pid)
      if (opts.onKill) opts.onKill(pid)
      else alive.delete(pid)
    },
    sleep: async () => {}
  }
  return { deps, alive, treeKills, singleKills, listCalls: () => listCount }
}

describe('parseWin32ProcessJson', () => {
  it('解析数组（多条进程）', () => {
    const json = JSON.stringify([
      { ProcessId: 100, ParentProcessId: 50, Name: 'node.exe', CommandLine: 'node a.js' },
      { ProcessId: 200, ParentProcessId: 100, Name: 'cmd.exe', CommandLine: null }
    ])
    expect(parseWin32ProcessJson(json)).toEqual([
      { pid: 100, ppid: 50, name: 'node.exe', cmdline: 'node a.js' },
      { pid: 200, ppid: 100, name: 'cmd.exe', cmdline: null }
    ])
  })

  it('单条结果时 PowerShell 不包数组 —— 也要能解析', () => {
    const json = JSON.stringify({ ProcessId: 7, ParentProcessId: 3, Name: 'a.exe', CommandLine: 'a' })
    expect(parseWin32ProcessJson(json)).toEqual([{ pid: 7, ppid: 3, name: 'a.exe', cmdline: 'a' }])
  })

  it('空结果（null / []）返回空表', () => {
    expect(parseWin32ProcessJson('null')).toEqual([])
    expect(parseWin32ProcessJson('[]')).toEqual([])
  })

  it('非法 JSON 返回 null —— 是「读不出」而不是「没有进程」，调用方不许当成功', () => {
    expect(parseWin32ProcessJson('not json')).toBeNull()
    expect(parseWin32ProcessJson('')).toBeNull()
  })

  it('CommandLine 里的换行/逗号/中文不会被切碎（这是 wmic CSV 的坑）', () => {
    const json = JSON.stringify([
      { ProcessId: 1, ParentProcessId: 0, Name: 'x.exe', CommandLine: 'a,b\n第二行' }
    ])
    expect(parseWin32ProcessJson(json)?.[0].cmdline).toBe('a,b\n第二行')
  })

  it('pid 非法/缺失的行丢弃；ppid 缺失或非正整数置 0', () => {
    const json = JSON.stringify([
      { ProcessId: 'x', ParentProcessId: 1, Name: 'a', CommandLine: 'a' },
      { Name: 'b', CommandLine: 'b' },
      { ProcessId: 5, Name: 'c', CommandLine: 'c' },
      { ProcessId: 6, ParentProcessId: -2, Name: 'd', CommandLine: 'd' }
    ])
    expect(parseWin32ProcessJson(json)).toEqual([
      { pid: 5, ppid: 0, name: 'c', cmdline: 'c' },
      { pid: 6, ppid: 0, name: 'd', cmdline: 'd' }
    ])
  })

  it('CommandLine 非字符串置 null（受保护进程读不到）', () => {
    const json = JSON.stringify([{ ProcessId: 1, ParentProcessId: 0, Name: 'a', CommandLine: 42 }])
    expect(parseWin32ProcessJson(json)?.[0].cmdline).toBeNull()
  })
})

describe('parsePsOutput', () => {
  it('解析 ps -eo pid=,ppid=,args= 的行', () => {
    const out = parsePsOutput('  1 0 /sbin/init\n  100 1 node /opt/dsh/lib/bin.js web --port 0 --no-open\n')
    expect(out).toEqual([
      { pid: 1, ppid: 0, name: 'init', cmdline: '/sbin/init' },
      { pid: 100, ppid: 1, name: 'node', cmdline: 'node /opt/dsh/lib/bin.js web --port 0 --no-open' }
    ])
  })

  it('name 取 args 首 token 的 basename（带路径、带引号）', () => {
    const out = parsePsOutput('  7 1 "C:\\Program Files\\nodejs\\node.exe" x.js\n')
    expect(out[0].name).toBe('node.exe')
  })

  it('坏行跳过、不抛', () => {
    expect(parsePsOutput('garbage\n\n  x 1 foo\n')).toEqual([])
    expect(parsePsOutput('')).toEqual([])
  })
})

describe('tokenizeCmdline', () => {
  it('按空白切分并折叠连续空白', () => {
    expect(tokenizeCmdline('  a   b\tc ')).toEqual(['a', 'b', 'c'])
  })

  it('双引号包裹段合成一个 token，引号去掉', () => {
    expect(tokenizeCmdline('"C:\\Program Files\\node.exe" -e "x y"')).toEqual([
      'C:\\Program Files\\node.exe',
      '-e',
      'x y'
    ])
  })

  it('空字符串返回空数组', () => {
    expect(tokenizeCmdline('')).toEqual([])
  })
})

describe('isLyShellDshWebCmdline', () => {
  it('命中实测的 npm shim 形态（带引号的 bin.js + web --port 0 --no-open）', () => {
    expect(isLyShellDshWebCmdline(LYSHELL_DSH_WEB)).toBe(true)
  })

  it('命中 dsh.cmd 直调形态', () => {
    expect(isLyShellDshWebCmdline('C:\\npm\\dsh.cmd web --port 0 --no-open')).toBe(true)
  })

  it('命中 Windows Job 启动门控的 cmd 包裹层', () => {
    expect(isLyShellDshWebCmdline('cmd.exe /d /s /c set /p LYSHELL_DSH_GATE= && dsh web --port 0 --no-open')).toBe(true)
  })

  it('命中 POSIX 软链形态', () => {
    expect(isLyShellDshWebCmdline('/usr/local/bin/dsh web --port 0 --no-open')).toBe(true)
  })

  it('支持 --port=0 的等号写法', () => {
    expect(isLyShellDshWebCmdline('dsh web --port=0 --no-open')).toBe(true)
  })

  it('不误杀手动起的实例（--port 18123，参数顺序也不同）', () => {
    expect(isLyShellDshWebCmdline(MANUAL_DSH_WEB)).toBe(false)
  })

  it('端口不是 0 一律不收', () => {
    expect(isLyShellDshWebCmdline('dsh web --port 8080 --no-open')).toBe(false)
    expect(isLyShellDshWebCmdline('dsh web --port=8080 --no-open')).toBe(false)
    expect(isLyShellDshWebCmdline('dsh web --port --no-open')).toBe(false)
    expect(isLyShellDshWebCmdline('dsh web --no-open')).toBe(false)
  })

  it('缺 --no-open（用户没抑制系统浏览器）不收', () => {
    expect(isLyShellDshWebCmdline('dsh web --port 0')).toBe(false)
  })

  it('缺 web 子命令不收', () => {
    expect(isLyShellDshWebCmdline('dsh --profile web --port 0 --no-open')).toBe(false)
    expect(isLyShellDshWebCmdline('dsh --profile=web --port 0 --no-open')).toBe(false)
    expect(isLyShellDshWebCmdline('node bin.js --port 0 --no-open')).toBe(false)
  })

  it('非 dsh 的同名签名不收（别误杀别的 node 程序）', () => {
    expect(isLyShellDshWebCmdline('node myserver.js web --port 0 --no-open')).toBe(false)
  })

  it('web 只出现在路径里不算子命令', () => {
    expect(isLyShellDshWebCmdline('node C:\\app\\web\\server.js --port 0 --no-open')).toBe(false)
  })

  it('空/null 不收', () => {
    expect(isLyShellDshWebCmdline('')).toBe(false)
    expect(isLyShellDshWebCmdline(null)).toBe(false)
    expect(isLyShellDshWebCmdline(undefined)).toBe(false)
    expect(isLyShellDshWebCmdline('   ')).toBe(false)
  })
})

describe('签名漂移防护（web.ts 的 spawn 参数 ↔ proc.ts 的 matcher 必须同源）', () => {
  it('由 DSH_WEB_SPAWN_ARGS 拼出的命令行必须被 matcher 命中', () => {
    expect(isLyShellDshWebCmdline(buildDshWebCmdline())).toBe(true)
  })

  it('shim 把 bin.js 拆成独立 token 的形态也要命中', () => {
    const shimStyle = `"node"   "C:\\x\\@deepseek-ai\\dsh\\lib\\bin.js" ${DSH_WEB_SPAWN_ARGS.join(' ')}`
    expect(isLyShellDshWebCmdline(shimStyle)).toBe(true)
  })

  it('DSH_WEB_SPAWN_ARGS 必须含 sweep 签名的两个支柱：--port 0 与 --no-open', () => {
    expect(DSH_WEB_COMMAND).toBe('dsh')
    expect(DSH_WEB_SPAWN_ARGS[0]).toBe('web')
    expect(DSH_WEB_SPAWN_ARGS).toContain('--no-open')
    expect(DSH_WEB_SPAWN_ARGS).toContain('0')
  })
})

describe('isAnchoredProcess', () => {
  it('父进程已不在表里 → 孤儿（实测遗留 dsh web 的形态：ppid 指向被 taskkill 的 cmd.exe）', () => {
    const p = proc({ pid: 100, ppid: 16376, cmdline: LYSHELL_DSH_WEB })
    expect(isAnchoredProcess(p, new Map([[100, p]]))).toBe(false)
  })

  it('父是存活的非 shell 进程 → 有人托管，不是孤儿', () => {
    const parent = proc({ pid: 10, ppid: 1, name: 'electron.exe' })
    const child = proc({ pid: 100, ppid: 10, cmdline: LYSHELL_DSH_WEB })
    const byPid = new Map([
      [10, parent],
      [100, child]
    ])
    expect(isAnchoredProcess(child, byPid)).toBe(true)
  })

  it('跳过 cmd.exe 包裹层看上一层：LyShell 还活着 → 不是孤儿', () => {
    const app = proc({ pid: 5, ppid: 1, name: 'LyShell.exe' })
    const shim = proc({ pid: 10, ppid: 5, name: 'cmd.exe' })
    const node = proc({ pid: 100, ppid: 10, cmdline: LYSHELL_DSH_WEB })
    const byPid = new Map([
      [5, app],
      [10, shim],
      [100, node]
    ])
    expect(isAnchoredProcess(node, byPid)).toBe(true)
  })

  it('cmd.exe 还在但它的父（Electron）已死 → 仍是孤儿（崩溃/强杀遗留形态）', () => {
    const shim = proc({ pid: 10, ppid: 28136, name: 'cmd.exe' })
    const node = proc({ pid: 100, ppid: 10, cmdline: LYSHELL_DSH_WEB })
    const byPid = new Map([
      [10, shim],
      [100, node]
    ])
    expect(isAnchoredProcess(node, byPid)).toBe(false)
  })

  it('PID 复用造成的环按「仍被活树挂着」保守处理，不死循环', () => {
    const a = proc({ pid: 1000, ppid: 1001, name: 'cmd.exe' })
    const b = proc({ pid: 1001, ppid: 1000, name: 'cmd.exe' })
    const node = proc({ pid: 100, ppid: 1000, cmdline: LYSHELL_DSH_WEB })
    const byPid = new Map([
      [1000, a],
      [1001, b],
      [100, node]
    ])
    expect(isAnchoredProcess(node, byPid)).toBe(true)
  })

  it('POSIX：父死后被 reparent 给 PID 1（init/launchd）→ 仍是孤儿，不是「挂在活根上」', () => {
    const init = proc({ pid: 1, ppid: 0, name: 'launchd' })
    const orphan = proc({ pid: 100, ppid: 1, cmdline: LYSHELL_DSH_WEB })
    const byPid = new Map([
      [1, init],
      [100, orphan]
    ])
    expect(isAnchoredProcess(orphan, byPid)).toBe(false)
  })

  it('POSIX：父链只剩 shell 包裹层、最终落到 PID 1（原父链已断）→ 孤儿', () => {
    const init = proc({ pid: 1, ppid: 0, name: 'init' })
    const sh = proc({ pid: 50, ppid: 1, name: 'sh' })
    const node = proc({ pid: 100, ppid: 50, cmdline: LYSHELL_DSH_WEB })
    const byPid = new Map([
      [1, init],
      [50, sh],
      [100, node]
    ])
    expect(isAnchoredProcess(node, byPid)).toBe(false)
  })

  it('POSIX：链上还挂着活着的 LyShell（非 shell 祖先）→ 不是孤儿，与 PID 1 无关', () => {
    const init = proc({ pid: 1, ppid: 0, name: 'systemd' })
    const app = proc({ pid: 9, ppid: 1, name: 'LyShell' })
    const node = proc({ pid: 100, ppid: 9, cmdline: LYSHELL_DSH_WEB })
    const byPid = new Map([
      [1, init],
      [9, app],
      [100, node]
    ])
    expect(isAnchoredProcess(node, byPid)).toBe(true)
  })
})

describe('findOrphanDshWebPids', () => {
  it('只收「签名命中 + 孤儿」：手动实例与有活根的实例都留下', () => {
    const liveApp = proc({ pid: 5, ppid: 1, name: 'LyShell.exe' })
    const liveShim = proc({ pid: 10, ppid: 5, name: 'cmd.exe' })
    const liveWeb = proc({ pid: 100, ppid: 10, cmdline: LYSHELL_DSH_WEB })
    const orphanWeb = proc({ pid: 200, ppid: 16376, cmdline: LYSHELL_DSH_WEB })
    const orphanShim = proc({ pid: 30, ppid: 28136, name: 'cmd.exe' })
    const orphanViaShim = proc({ pid: 300, ppid: 30, cmdline: LYSHELL_DSH_WEB })
    const manual = proc({ pid: 400, ppid: 32700, name: 'node.exe', cmdline: MANUAL_DSH_WEB })

    const pids = findOrphanDshWebPids([
      liveApp,
      liveShim,
      liveWeb,
      orphanWeb,
      orphanShim,
      orphanViaShim,
      manual
    ])
    expect(pids).toEqual([200, 300])
  })

  it('空表返回空数组', () => {
    expect(findOrphanDshWebPids([])).toEqual([])
  })
})

describe('collectDescendantPids', () => {
  it('按 ppid 收全子孙（含孙、不含 root），跨代多分支', () => {
    // 1 → 2 → 4, 1 → 3, 2 → 5, 99（无关）
    const procs = [
      proc({ pid: 2, ppid: 1 }),
      proc({ pid: 3, ppid: 1 }),
      proc({ pid: 4, ppid: 2 }),
      proc({ pid: 5, ppid: 2 }),
      proc({ pid: 99, ppid: 0 })
    ]
    expect(collectDescendantPids(procs, 1).sort((a, b) => a - b)).toEqual([2, 3, 4, 5])
  })

  it('无子孙返回空数组', () => {
    expect(collectDescendantPids([proc({ pid: 1, ppid: 0 })], 1)).toEqual([])
  })

  it('PID 复用造成的环不死循环、不重复收录', () => {
    const procs = [proc({ pid: 2, ppid: 1 }), proc({ pid: 1, ppid: 2 })]
    expect(collectDescendantPids(procs, 1)).toEqual([2])
  })
})

describe('isPidAlive', () => {
  it('EPERM（在但无权限）算存活', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('kill EPERM') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    })
    try {
      expect(isPidAlive(12345)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('ESRCH 算不在', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException
      err.code = 'ESRCH'
      throw err
    })
    try {
      expect(isPidAlive(12345)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('不抛（信号 0 探测成功）算在', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true as unknown as never)
    try {
      expect(isPidAlive(12345)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('selectFirstRoundPids', () => {
  const before = new Map([
    [10, { name: 'cmd.exe' }],
    [100, { name: 'node.exe' }],
    [200, { name: 'node.exe' }]
  ])

  it('名字一致 → 放行', () => {
    expect(
      selectFirstRoundPids({
        candidates: [10, 100],
        rootPid: 10,
        beforeById: before,
        liveNameByPid: new Map([
          [10, 'cmd.exe'],
          [100, 'node.exe']
        ])
      })
    ).toEqual([10, 100])
  })

  it('名字被复用成别的镜像 → 不动手', () => {
    expect(
      selectFirstRoundPids({
        candidates: [10, 100],
        rootPid: 10,
        beforeById: before,
        liveNameByPid: new Map([
          [10, 'explorer.exe'],
          [100, 'node.exe']
        ])
      })
    ).toEqual([100])
  })

  it('查不到名字：孤儿清扫没有进程句柄，root 与子孙都不盲杀', () => {
    expect(
      selectFirstRoundPids({
        candidates: [10, 100, 200],
        rootPid: 10,
        beforeById: before,
        liveNameByPid: new Map([
          [10, null],
          [100, null],
          [200, null]
        ])
      })
    ).toEqual([])
  })

  it('管理器曾持有 root 进程句柄但查不到名字时不盲杀', () => {
    expect(selectFirstRoundPids({
      candidates: [10, 100],
      rootPid: 10,
      beforeById: before,
      liveNameByPid: new Map([[10, null], [100, null]])
    })).toEqual([])
  })

  it('快照里没身份记录：孤儿清扫不凭裸 root pid 动手', () => {
    expect(
      selectFirstRoundPids({
        candidates: [10, 100],
        rootPid: 10,
        beforeById: new Map(),
        liveNameByPid: new Map([
          [10, 'cmd.exe'],
          [100, 'node.exe']
        ])
      })
    ).toEqual([])
  })

  it('没查过的 pid（liveName 缺失）不当「查不到」处理，直接跳过', () => {
    expect(
      selectFirstRoundPids({
        candidates: [10, 100],
        rootPid: 10,
        beforeById: before,
        liveNameByPid: new Map([[10, 'cmd.exe']])
      })
    ).toEqual([10])
  })

  it('名字大小写不敏感（tasklist 与 Win32_Process 的大小写可能不一致）', () => {
    expect(
      selectFirstRoundPids({
        candidates: [10],
        rootPid: 10,
        beforeById: new Map([[10, { name: 'Cmd.Exe' }]]),
        liveNameByPid: new Map([[10, 'cmd.exe']])
      })
    ).toEqual([10])
  })
})

describe('killPidTree', () => {
  const tree: ProcInfo[] = [
    proc({ pid: 10, ppid: 5, name: 'cmd.exe', cmdline: 'cmd' }),
    proc({ pid: 100, ppid: 10, name: 'node.exe', cmdline: LYSHELL_DSH_WEB }),
    proc({ pid: 200, ppid: 100, name: 'node.exe', cmdline: LYSHELL_DSH_WEB })
  ]

  it('taskkill /T 一击全灭 → killed', async () => {
    const { deps, alive, treeKills, singleKills } = makeDeps({
      procs: tree,
      alive: new Set([10, 100, 200]),
      // /T 走完整棵树：root + 子孙一起没
      onTreeKill: () => {
        alive.clear()
      }
    })
    const result = await killPidTree(10, undefined, deps)
    expect(result.status).toBe('killed')
    expect(treeKills).toEqual([10])
    expect(singleKills).toEqual([])
  })

  it('根先死 → 按名单补刀子孙（taskkill /T 断树是主场景）', async () => {
    const { deps, alive, treeKills, singleKills } = makeDeps({
      procs: tree,
      alive: new Set([10, 100, 200]),
      // /T 先杀掉 root 就断树：node 孙进程全漏
      onTreeKill: (pid) => {
        alive.delete(pid)
      }
    })
    const result = await killPidTree(10, undefined, deps)
    expect(result.status).toBe('killed')
    expect(treeKills).toEqual([10])
    // 两个漏网的子孙都要补刀
    expect(singleKills.sort((a, b) => a - b)).toEqual([100, 200])
  })

  it('枚举失败时不凭历史 PID 树杀，也不报告成功', async () => {
    const { deps, alive, treeKills, singleKills } = makeDeps({
      procs: null,
      alive: new Set([10, 100]),
      onTreeKill: (pid) => {
        alive.delete(pid)  // root 死了，但名单根本没拿到
      }
    })
    const result = await killPidTree(10, undefined, deps)
    expect(result.status).toBe('unverified')
    if (result.status === 'unverified') expect(result.message).toContain('identity unverified')
    expect(treeKills).toEqual([])
    // 没有名单就无从补刀
    expect(singleKills).toEqual([])
  })

  it('补刀前核对身份：PID 复用成别的进程就不动手', async () => {
    let call = 0
    const { deps, alive, singleKills } = makeDeps({
      procs: async () => {
        call++
        if (call === 1) return tree
        // 补刀前的核对快照：100 已被复用成 explorer.exe
        return [
          proc({ pid: 10, ppid: 5, name: 'cmd.exe', cmdline: 'cmd' }),
          proc({ pid: 100, ppid: 1, name: 'explorer.exe', cmdline: null }),
          proc({ pid: 200, ppid: 100, name: 'node.exe', cmdline: LYSHELL_DSH_WEB })
        ]
      },
      alive: new Set([10, 100, 200]),
      onTreeKill: (pid) => {
        alive.delete(pid)
      }
    })
    const result = await killPidTree(10, undefined, deps)
    expect(result.status).toBe('survivors')
    if (result.status === 'survivors') expect(result.pids).toEqual([100])
    // 100 是别人的进程，一动不能动；200 身份一致可以补
    expect(singleKills).toContain(200)
    expect(singleKills).not.toContain(100)
  })

  it('补刀前核对快照也拿不到 → 不盲杀，报 unverified', async () => {
    let call = 0
    const { deps, alive, singleKills } = makeDeps({
      procs: async () => {
        call++
        return call === 1 ? tree : null
      },
      alive: new Set([10, 100, 200]),
      onTreeKill: (pid) => {
        alive.delete(pid)
      }
    })
    const result = await killPidTree(10, undefined, deps)
    expect(result.status).toBe('unverified')
    expect(singleKills).toEqual([])
  })

  it('复用调用方的快照：传了 snapshot 就不再为收子孙名单重复枚举', async () => {
    const alive = new Set<number>([10, 100, 200])
    let lists = 0
    const d = {
      ownedRootSpawnedAt: 1000,
      lookupStartTime: async () => 1000,
      lookupImageName: async () => 'cmd.exe',
      listProcesses: async () => {
        lists++
        return tree
      },
      isPidAlive: (p: number) => alive.has(p),
      execFile: async () => {
        alive.clear()  // /T 一击全灭 → 不触发补刀前的核对枚举
        return ''
      },
      signalPid: () => {},
      sleep: async () => {}
    }
    const result = await killPidTree(10, tree, d)
    expect(result.status).toBe('killed')
    expect(lists).toBe(0)  // 一次都不该枚举：名单是调用方给的
  })

  it('targets 带上身份，供失败时留档给 recoverRecordedPids', async () => {
    const { deps, alive } = makeDeps({
      procs: tree,
      alive: new Set([10, 100, 200]),
      onTreeKill: (pid) => {
        alive.delete(pid)
      }
    })
    const result = await killPidTree(10, undefined, deps)
    expect(result.targets.map((t) => t.pid).sort((a, b) => a - b)).toEqual([10, 100, 200])
    expect(result.targets.find((t) => t.pid === 100)?.name).toBe('node.exe')
    expect(result.targets.find((t) => t.pid === 100)?.cmdline).toBe(LYSHELL_DSH_WEB)
  })

  it('预算不足以核对身份 → 不凭历史 PID 发树杀', async () => {
    const timeouts: number[] = []
    let lists = 0
    const alive = new Set([10])
    const result = await killPidTree(10, undefined, {
      ownedRootSpawnedAt: 1000,
      listProcesses: async () => {
        lists++
        return tree
      },
      isPidAlive: (p) => alive.has(p),
      execFile: async (_f: string, _a: string[], opts: { timeout: number }) => {
        timeouts.push(opts.timeout)
        alive.clear()  // /T 一击全灭
        return ''
      },
      signalPid: () => {},
      sleep: async () => {},
      now: () => 0,
      deadline: 200  // 预算已不足一步的下限
    })
    expect(lists).toBe(0)  // 枚举整步被跳过（省下的是一整步，超预算的量才收得住）
    expect(timeouts).toEqual([])
    expect(result.status).toBe('unverified')
    if (result.status === 'unverified') expect(result.message).toContain('identity unverified')
  })

  it('枚举耗尽预算后跳过身份核对，也不发主力树杀', async () => {
    let clock = 0
    let imageLookups = 0
    const timeouts: number[] = []
    const alive = new Set([10])
    const result = await killPidTree(10, undefined, {
      ownedRootSpawnedAt: 1000,
      listProcesses: async () => {
        clock = 2400  // 2.5s 预算只剩 100ms
        return tree
      },
      isPidAlive: (p) => alive.has(p),
      lookupImageName: async () => {
        imageLookups++
        clock += 1500
        return 'cmd.exe'
      },
      execFile: async (_file, _args, opts) => {
        timeouts.push(opts.timeout)
        clock += opts.timeout
        alive.clear()
        return ''
      },
      signalPid: () => {},
      now: () => clock,
      deadline: 2500
    })
    expect(imageLookups).toBe(0)
    expect(timeouts).toEqual([])
    expect(clock).toBeLessThan(4500)  // 退出路径的 deadline + 2s 余量
    expect(result.status).toBe('unverified')
  })

  it('预算在主力树杀之后耗尽 → 不再开补刀轮次，带 targets 返回 unverified（交留档兜底）', async () => {
    let lists = 0
    let clock = 0
    const alive = new Set([10, 100, 200])
    const result = await killPidTree(10, undefined, {
      ownedRootSpawnedAt: 1000,
      lookupStartTime: async () => 1000,
      lookupImageName: async () => 'cmd.exe',
      listProcesses: async () => {
        lists++
        return tree
      },
      isPidAlive: (p) => alive.has(p),
      execFile: async () => {
        clock = 5000  // 树杀发出去之后预算正好到点
        return ''     // 且一个都没杀掉
      },
      signalPid: () => {},
      sleep: async () => {},
      now: () => clock,
      deadline: 5000
    })
    expect(result.status).toBe('unverified')
    if (result.status === 'unverified') expect(result.message).toContain('budget exhausted')
    expect(lists).toBe(1)  // 只枚举了收子孙名单那一次；补刀前的核对枚举被预算挡掉
    expect(result.targets.map((t) => t.pid).sort((a, b) => a - b)).toEqual([10, 100, 200])
  })

  it('补刀前的核对枚举把最后预算吃掉 → 一个补刀都不发（守住调用方的等待余量）', async () => {
    let clock = 0
    let lists = 0
    const singleKills: number[] = []
    const alive = new Set([10, 100, 200])
    const result = await killPidTree(10, undefined, {
      listProcesses: async () => {
        lists++
        if (lists === 2) clock = 2000  // 补刀前的核对枚举自己把最后的预算用光
        return tree
      },
      isPidAlive: (p) => alive.has(p),
      lookupImageName: async (pid: number) => tree.find((t) => t.pid === pid)?.name ?? null,
      execFile: async (_f: string, args: string[]) => {
        if (args.includes('/T')) {
          clock = 1900  // 主力树杀没杀掉任何东西，预算只剩 100ms
          return ''
        }
        const pid = Number(args[args.indexOf('/PID') + 1])
        singleKills.push(pid)
        alive.delete(pid)
        return ''
      },
      signalPid: () => {},
      sleep: async () => {},
      now: () => clock,
      deadline: 2000
    })
    expect(lists).toBe(2)  // 主枚举 + 补刀前的核对枚举
    expect(singleKills).toEqual([])
    expect(result.status).toBe('unverified')
    if (result.status === 'unverified') {
      expect(result.message).toContain('budget exhausted before mop-up')
    }
  })

  it('主力树杀前核对身份：root 已被复用成别的镜像 → 连 taskkill /T 都不发', async () => {
    let call = 0
    const { deps, alive, treeKills, singleKills } = makeDeps({
      // 主枚举时 root 还是 cmd.exe；核对/补刀再看已经是被复用的 explorer.exe
      procs: async () => {
        call++
        if (call === 1) return tree
        return [
          proc({ pid: 10, ppid: 5, name: 'explorer.exe', cmdline: null }),
          proc({ pid: 100, ppid: 1, name: 'node.exe', cmdline: LYSHELL_DSH_WEB }),
          proc({ pid: 200, ppid: 100, name: 'node.exe', cmdline: LYSHELL_DSH_WEB })
        ]
      },
      alive: new Set([10, 100, 200]),
      imageNames: { 10: 'explorer.exe', 100: 'node.exe', 200: 'node.exe' }
    })
    const result = await killPidTree(10, undefined, deps)
    // root 是别人的进程：主力树杀（/T 会把它整棵活树拖下水）一个字节都不许发
    expect(treeKills).toEqual([])
    // root 未确认时整轮收手，子孙也不按同一份旧快照补刀
    expect(singleKills).toEqual([])
    expect(alive.has(10)).toBe(true)
    expect(result.status).toBe('unverified')
  })

  it('root 镜像名相同但启动时刻已变 → 不对复用 PID 发 taskkill /T', async () => {
    const { deps, treeKills } = makeDeps({
      procs: tree,
      alive: new Set([10, 100, 200]),
      rootStartTime: 5000
    })
    const result = await killPidTree(10, undefined, deps)
    expect(treeKills).toEqual([])
    expect(result.status).toBe('unverified')
  })

  it('root 启动时刻查不到 → 不凭持有过的 PID 发 taskkill /T', async () => {
    const { deps, treeKills } = makeDeps({
      procs: tree,
      alive: new Set([10, 100, 200]),
      rootStartTime: null
    })
    const result = await killPidTree(10, undefined, deps)
    expect(treeKills).toEqual([])
    expect(result.status).toBe('unverified')
  })

  it('主力树杀前核对身份：名字和启动时刻一致才放行 taskkill /T', async () => {
    const { deps, treeKills } = makeDeps({
      procs: tree,
      alive: new Set([10, 100, 200]),
      imageNames: { 10: 'cmd.exe', 100: 'node.exe', 200: 'node.exe' },
      onTreeKill: () => {
        /* 一个都不杀，只断言 /T 发出去了 */
      }
    })
    await killPidTree(10, undefined, deps)
    expect(treeKills).toEqual([10])
  })

  it('POSIX：主力树杀前的身份核对并发执行（串行的话 1.5s 下限 × N 会把 deadline 拖穿 N 步）', async () => {
    const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'posix', configurable: true })
    try {
      const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
      let inFlight = 0
      let peak = 0
      const alive = new Set([10, 100, 200])
      const result = await killPidTree(10, tree, {
        isPidAlive: (p) => alive.has(p),
        listProcesses: async () => {
          throw new Error('should not enumerate: snapshot given')
        },
        lookupImageName: async (pid: number) => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await wait(20)
          inFlight--
          return tree.find((t) => t.pid === pid)?.name ?? null
        },
        signalPid: (p) => {
          alive.delete(p)
        },
        sleep: async () => {},
        now: () => 0,
        deadline: 5000
      })
      // 3 个候选（root + 两个子孙）同时在查 —— 串行实现 peak 只会是 1
      expect(peak).toBe(3)
      expect(result.status).toBe('killed')
    } finally {
      if (platformDesc) Object.defineProperty(process, 'platform', platformDesc)
    }
  })
})

describe('sweepOrphanDshWeb', () => {
  it('孤儿 root 的镜像名查询失败时不发 taskkill，也不进入第二轮补刀', async () => {
    const orphan = proc({ pid: 200, ppid: 16376, name: 'node.exe', cmdline: LYSHELL_DSH_WEB })
    const kills: number[] = []
    const result = await sweepOrphanDshWeb({
      listProcesses: async () => [orphan],
      isPidAlive: () => true,
      lookupStartTime: async () => 1000,
      lookupImageName: async () => null,
      execFile: async (_file, args) => {
        kills.push(Number(args[args.indexOf('/PID') + 1]))
        return ''
      },
      signalPid: (pid) => { kills.push(pid) },
      sleep: async () => {}
    })
    expect(result).toEqual([])
    expect(kills).toEqual([])
  })

  it('只收「签名命中 + 孤儿」，动手前重读快照与启动时刻', async () => {
    const liveApp = proc({ pid: 5, ppid: 1, name: 'LyShell.exe' })
    const liveShim = proc({ pid: 10, ppid: 5, name: 'cmd.exe' })
    const liveWeb = proc({ pid: 100, ppid: 10, cmdline: LYSHELL_DSH_WEB })
    const orphanWeb = proc({ pid: 200, ppid: 16376, cmdline: LYSHELL_DSH_WEB })
    const manual = proc({ pid: 400, ppid: 32700, name: 'node.exe', cmdline: MANUAL_DSH_WEB })
    const snapshot = [liveApp, liveShim, liveWeb, orphanWeb, manual]

    let lists = 0
    const alive = new Set([5, 10, 100, 200, 400])
    const treeKills: number[] = []
    const result = await sweepOrphanDshWeb({
      listProcesses: async () => {
        lists++
        return snapshot
      },
      isPidAlive: (p) => alive.has(p),
      lookupStartTime: async () => 1000,
      lookupImageName: async (pid: number) => snapshot.find((t) => t.pid === pid)?.name ?? null,
      execFile: async (_f, args) => {
        const pid = Number(args[args.indexOf('/PID') + 1])
        treeKills.push(pid)
        alive.delete(pid)
        return ''
      },
      signalPid: (p) => {
        alive.delete(p)
      },
      sleep: async () => {}
    })
    expect(result).toEqual([200])
    // 初始名单 + 动手前的身份核对；树杀复用核对后的快照。
    expect(lists).toBe(2)
    // 手动实例、有活根的实例都不动
    expect(treeKills).toEqual([200])
  })

  it('孤儿快照中的 PID 被同名正常进程复用时不树杀', async () => {
    const orphan = proc({ pid: 200, ppid: 16376, name: 'node.exe', cmdline: LYSHELL_DSH_WEB })
    const normal = proc({ pid: 200, ppid: 5, name: 'node.exe', cmdline: 'node app.js' })
    let lists = 0
    const kills: number[] = []
    const result = await sweepOrphanDshWeb({
      listProcesses: async () => (++lists === 1 ? [orphan] : [normal]),
      lookupStartTime: async () => 1000,
      lookupImageName: async () => 'node.exe',
      isPidAlive: () => true,
      execFile: async (_file, args) => {
        kills.push(Number(args[args.indexOf('/PID') + 1]))
        return ''
      }
    })
    expect(result).toEqual([])
    expect(kills).toEqual([])
  })

  it('孤儿最后一次核对后启动时刻改变时仍不树杀', async () => {
    const orphan = proc({ pid: 200, ppid: 16376, name: 'node.exe', cmdline: LYSHELL_DSH_WEB })
    let starts = 0
    const kills: number[] = []
    const result = await sweepOrphanDshWeb({
      listProcesses: async () => [orphan],
      lookupStartTime: async () => ++starts === 3 ? 2000 : 1000,
      lookupImageName: async () => 'node.exe',
      isPidAlive: () => true,
      execFile: async (_file, args) => {
        kills.push(Number(args[args.indexOf('/PID') + 1]))
        return ''
      }
    })
    expect(result).toEqual([])
    expect(kills).toEqual([])
  })

  it('枚举失败 → 静默 no-op 是不够的：返回空并由调用方走 recoverRecordedPids 兜底', async () => {
    const result = await sweepOrphanDshWeb({
      listProcesses: async () => null,
      isPidAlive: () => true,
      execFile: async () => {
        throw new Error('should not kill anything')
      },
      signalPid: () => {
        throw new Error('should not kill anything')
      },
      sleep: async () => {}
    })
    expect(result).toEqual([])
  })
})

describe('recoverRecordedPids（留档恢复路径）', () => {
  /** 现格式：我们自己 spawn 的 root（带归属标记） */
  const entry = (pid: number, name = 'cmd.exe'): RecordedPid => ({
    pid,
    name,
    cmdline: null,
    recordedAt: 1,
    kind: 'root'
  })

  /** 旧格式：没有 kind —— 无法区分 root 与从进程表推导出来的子孙 pid */
  const legacyEntry = (pid: number, name = 'cmd.exe'): RecordedPid => ({
    pid,
    name,
    cmdline: null,
    recordedAt: 1
  })

  /** 一条「进程启动早于留档」的时间证据（正常形态） */
  const startedBefore = (pid: number, byMs = 60_000): Record<number, number> => ({ [pid]: 1 - byMs })

  const SIG_CMDLINE = 'node /usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 0 --no-open'

  /** 只剩签名这条证据时，命令行证据还要求「无人托管的遗留物」：给一份父链已断的快照 */
  const orphanSnapshot = (pid: number, cmdline = SIG_CMDLINE): ProcInfo[] =>
    [proc({ pid, ppid: 16376, name: 'node', cmdline })]

  const orphanCmdSnapshot = (pid: number): ProcInfo[] =>
    [proc({ pid, ppid: 16376, name: 'cmd.exe', cmdline: 'cmd /d /s /c dsh web --port 0 --no-open' })]

  function makeRecoverDeps(opts: {
    alive: Set<number>
    imageNames: Record<number, string | null>
    treeKills?: number[]
    /** 进程表快照（「留档没镜像名」/「记录已死」时的证据源）；默认 null = 读不出 */
    snapshot?: ProcInfo[] | null
    /** 直接给命令行的第一证据源；不给则回落快照 */
    cmdline?: (pid: number) => Promise<string | null>
    /** 进程启动时刻（判 PID 复用的硬证据）；不列出的 pid 视为查不到 */
    startTimes?: Record<number, number>
  }): { deps: Parameters<typeof recoverRecordedPids>[1]; treeKills: number[] } {
    const treeKills = opts.treeKills ?? []
    const deps = {
      isPidAlive: (p: number) => opts.alive.has(p),
      listProcesses: async () => opts.snapshot ?? null,
      lookupStartTime: async (pid: number) => opts.startTimes?.[pid] ?? null,
      ...(opts.cmdline ? { lookupCmdline: opts.cmdline } : {}),
      execFile: async (_f: string, args: string[]) => {
        if (args[0] === '/FI') {
          // tasklist 核对镜像名
          const pid = Number(String(args[1]).replace('PID eq ', ''))
          const name = opts.imageNames[pid]
          return name ? `"${name}","${pid}","Console","1","1 K"` : 'INFO: No tasks...'
        }
        const pid = Number(args[args.indexOf('/PID') + 1])
        treeKills.push(pid)
        opts.alive.delete(pid)
        return ''
      },
      signalPid: (p: number) => {
        treeKills.push(p)
        opts.alive.delete(p)
      }
    }
    return { deps, treeKills }
  }

  it('镜像名、命令行与孤儿状态均核对通过 → taskkill /T 收掉', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'cmd.exe' },
      startTimes: startedBefore(42),
      snapshot: orphanCmdSnapshot(42)
    })
    expect(await recoverRecordedPids([entry(42, 'cmd.exe')], deps)).toEqual({ killed: [42], dropped: [] })
    expect(treeKills).toEqual([42])
  })

  it('杀掉 root 但 taskkill /T 漏掉 node 子孙 → 记录保留（root 不进 killed，下次按 ppid 找回）', async () => {
    // makeRecoverDeps 的 taskkill 只杀目标 pid 本身 —— 正是「/T 先杀 root 就断树」的形态
    const procs: ProcInfo[] = [
      ...orphanCmdSnapshot(42),
      proc({ pid: 43, ppid: 42, name: 'node.exe', cmdline: LYSHELL_DSH_WEB })
    ]
    const alive = new Set([42, 43])
    const treeKills: number[] = []
    const result = await recoverRecordedPids([entry(42, 'cmd.exe')], {
      isPidAlive: (p) => alive.has(p),
      listProcesses: async () => procs,
      lookupStartTime: async () => 1 - 60_000,
      execFile: async (_f: string, args: string[]) => {
        if (args[0] === '/FI') return `"cmd.exe","42","Console","1","1 K"`
        const pid = Number(args[args.indexOf('/PID') + 1])
        treeKills.push(pid)
        if (pid === 42) alive.delete(pid)  // root 杀掉了，子孙 43 漏了；补刀也杀不动
        return ''
      },
      signalPid: () => {}
    })
    // 43 没清掉 → root 这条唯一的线索必须留着：既不进 killed 也不进 dropped
    expect(result).toEqual({ killed: [], dropped: [] })
    expect(treeKills).toEqual([42, 43])  // 试过了
  })

  it('杀掉 root 且漏网子孙被收回 → killed 含 root 与子孙，可以清档', async () => {
    const procs: ProcInfo[] = [
      ...orphanCmdSnapshot(42),
      proc({ pid: 43, ppid: 42, name: 'node.exe', cmdline: LYSHELL_DSH_WEB })
    ]
    const alive = new Set([42, 43])
    const treeKills: number[] = []
    const result = await recoverRecordedPids([entry(42, 'cmd.exe')], {
      isPidAlive: (p) => alive.has(p),
      listProcesses: async () => procs,
      lookupStartTime: async () => 1 - 60_000,
      execFile: async (_f: string, args: string[]) => {
        if (args[0] === '/FI') return `"cmd.exe","42","Console","1","1 K"`
        const pid = Number(args[args.indexOf('/PID') + 1])
        treeKills.push(pid)
        alive.delete(pid)  // root 与子孙都杀得掉
        return ''
      },
      signalPid: () => {}
    })
    expect(result).toEqual({ killed: [43, 42], dropped: [] })
    expect(treeKills).toEqual([42, 43])
  })

  it('PID 复用成别的镜像名 → 不动手，并且把这条记录清掉（留着下次复用成同名就是误杀）', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'explorer.exe' },
      snapshot: []  // 空表 = 确认旧 root 没有存活子孙，线索用尽才清档
    })
    expect(await recoverRecordedPids([entry(42, 'cmd.exe')], deps)).toEqual({ killed: [], dropped: [42] })
    expect(treeKills).toEqual([])
  })

  it('查询失败但进程仍活着 → 保留记录（tasklist/ps 超时也会返回 null，不能当成 PID 复用清掉）', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: null }
    })
    expect(await recoverRecordedPids([entry(42, 'cmd.exe')], deps)).toEqual({ killed: [], dropped: [] })
    expect(treeKills).toEqual([])
  })

  it('镜像名查询期间 root 死亡且无存活子孙 → 才清档（不能一见 name=null 就 dropped）', async () => {
    const alive = new Set([42])
    const result = await recoverRecordedPids([entry(42, 'cmd.exe')], {
      isPidAlive: (p) => alive.has(p),
      listProcesses: async () => [],
      lookupStartTime: async () => 1 - 60_000,
      execFile: async (_f: string, args: string[]) => {
        if (args[0] === '/FI') {
          alive.delete(42)  // 查询期间 root 正好死了
          return 'INFO: No tasks...'
        }
        throw new Error('should not kill anything')
      },
      signalPid: () => {
        throw new Error('should not kill anything')
      }
    })
    // 走的是「死者收尾」那条路：确认没有存活子孙后才清档
    expect(result).toEqual({ killed: [], dropped: [42] })
  })

  it('镜像名查询期间 root 死亡但子孙还活着 → 先收子孙，清不干净就保留记录', async () => {
    const procs: ProcInfo[] = [
      proc({ pid: 42, ppid: 16376, name: 'cmd.exe', cmdline: 'cmd' }),
      proc({ pid: 43, ppid: 42, name: 'node.exe', cmdline: LYSHELL_DSH_WEB })
    ]
    const alive = new Set([42, 43])
    const treeKills: number[] = []
    const result = await recoverRecordedPids([entry(42, 'cmd.exe')], {
      isPidAlive: (p) => alive.has(p),
      listProcesses: async () => procs,
      lookupStartTime: async () => 1 - 60_000,
      execFile: async (_f: string, args: string[]) => {
        if (args[0] === '/FI') {
          alive.delete(42)  // 查询期间 root 正好死了
          return 'INFO: No tasks...'
        }
        const pid = Number(args[args.indexOf('/PID') + 1])
        treeKills.push(pid)
        alive.delete(pid)  // 子孙收得掉
        return ''
      },
      signalPid: () => {}
    })
    // 43 是签名命中的存活子孙：收掉后整条线索用尽，root 才可以清档
    expect(result).toEqual({ killed: [43], dropped: [42] })
    expect(treeKills).toEqual([43])
  })

  it('镜像名查询期间 root 死亡但子孙杀不掉 → 记录保留（与「进来就已死」同一保守口径）', async () => {
    const procs: ProcInfo[] = [
      proc({ pid: 42, ppid: 16376, name: 'cmd.exe', cmdline: 'cmd' }),
      proc({ pid: 43, ppid: 42, name: 'node.exe', cmdline: LYSHELL_DSH_WEB })
    ]
    const alive = new Set([42, 43])
    const treeKills: number[] = []
    const result = await recoverRecordedPids([entry(42, 'cmd.exe')], {
      isPidAlive: (p) => alive.has(p),
      listProcesses: async () => procs,
      lookupStartTime: async () => 1 - 60_000,
      execFile: async (_f: string, args: string[]) => {
        if (args[0] === '/FI') {
          alive.delete(42)
          return 'INFO: No tasks...'
        }
        treeKills.push(Number(args[args.indexOf('/PID') + 1]))
        return ''  // 杀不动
      },
      signalPid: () => {}
    })
    expect(result).toEqual({ killed: [], dropped: [] })
  })

  it('进程已不在且快照可读 → 记录清掉', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set(),
      imageNames: {},
      snapshot: []
    })
    expect(await recoverRecordedPids([entry(42, 'cmd.exe')], deps)).toEqual({ killed: [], dropped: [42] })
    expect(treeKills).toEqual([])
  })

  it('记录已死但存活子孙签名命中 → 按 ppid 找回并收掉（枚举失败时只留下 root 的那条线索）', async () => {
    const procs: ProcInfo[] = [
      proc({ pid: 42, ppid: 16376, name: 'cmd.exe', cmdline: 'cmd' }),  // 记录里的 root，已死
      proc({ pid: 43, ppid: 42, name: 'node.exe', cmdline: LYSHELL_DSH_WEB }),
      proc({ pid: 44, ppid: 42, name: 'node.exe', cmdline: 'node /srv/other/server.js' })
    ]
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([43, 44]),
      imageNames: {},
      snapshot: procs
    })
    expect(await recoverRecordedPids([entry(42, 'cmd.exe')], deps)).toEqual({ killed: [43], dropped: [42] })
    expect(treeKills).toEqual([43])  // 44 命令行不命中签名 → 不动
  })

  it('记录已死且快照读不出（WMI 不可用）→ 清不掉，root 记录保留给下次启动', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([43]),
      imageNames: {},
      snapshot: null
    })
    expect(await recoverRecordedPids([entry(42, 'cmd.exe')], deps)).toEqual({ killed: [], dropped: [] })
    expect(treeKills).toEqual([])
  })

  it('记录已死、快照可读但查无存活子孙 → 清档（线索已用尽）', async () => {
    const procs: ProcInfo[] = [proc({ pid: 43, ppid: 42, name: 'node.exe', cmdline: 'node /srv/other.js' })]
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([43]),
      imageNames: {},
      snapshot: procs
    })
    expect(await recoverRecordedPids([entry(42, 'cmd.exe')], deps)).toEqual({ killed: [], dropped: [42] })
    expect(treeKills).toEqual([])
  })

  it('记录已死、子孙签名命中但杀不掉 → root 记录保留（下次接着收）', async () => {
    const procs: ProcInfo[] = [
      proc({ pid: 42, ppid: 16376, name: 'cmd.exe', cmdline: 'cmd' }),
      proc({ pid: 43, ppid: 42, name: 'node.exe', cmdline: LYSHELL_DSH_WEB })
    ]
    const killCalls: number[] = []
    const alive = new Set([43])
    const result = await recoverRecordedPids([entry(42, 'cmd.exe')], {
      isPidAlive: (p) => alive.has(p),
      listProcesses: async () => procs,
      lookupStartTime: async () => null,
      execFile: async (_f: string, args: string[]) => {
        killCalls.push(Number(args[args.indexOf('/PID') + 1]))
        return ''  // 杀不动：进程仍在
      },
      signalPid: () => {}
    })
    expect(result).toEqual({ killed: [], dropped: [] })
    expect(killCalls).toEqual([43])  // 试过了，但没杀掉 → 线索必须留着
  })

  it('PID 复用硬判据：进程启动晚于留档 → 不动手，记录清掉', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'cmd.exe' },  // 名字还一样，正是最危险的形态
      startTimes: { 42: entry(42).recordedAt + 60_000 },
      snapshot: []  // 复用确证也要先确认旧 root 没有存活子孙
    })
    expect(await recoverRecordedPids([entry(42, 'cmd.exe')], deps)).toEqual({ killed: [], dropped: [42] })
    expect(treeKills).toEqual([])
  })

  it('同名 PID 在留档后 1 秒内复用且仍由活进程托管 → 时间接近也不授权树杀', async () => {
    const procs: ProcInfo[] = [
      proc({ pid: 5, ppid: 1, name: 'LyShell.exe' }),
      proc({ pid: 42, ppid: 5, name: 'cmd.exe', cmdline: 'cmd /d /s /c dsh web --port 0 --no-open' })
    ]
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([5, 42]),
      imageNames: { 42: 'cmd.exe' },
      startTimes: { 42: entry(42).recordedAt + 1000 },
      snapshot: procs
    })
    expect(await recoverRecordedPids([entry(42)], deps)).toEqual({ killed: [], dropped: [] })
    expect(treeKills).toEqual([])
  })

  it('进程启动早于留档，但只有镜像名证据 → 保留不动手', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'cmd.exe' },
      startTimes: { 42: entry(42).recordedAt - 60_000 },
      snapshot: []
    })
    expect(await recoverRecordedPids([entry(42, 'cmd.exe')], deps)).toEqual({ killed: [], dropped: [] })
    expect(treeKills).toEqual([])
  })

  it('recordedAt 缺失/非法（<=0）→ 不启用时间判据，按「无时间证据」处理（不误判为复用）', async () => {
    const noTime: RecordedPid = { pid: 42, name: 'node.exe', cmdline: null, recordedAt: 0, kind: 'root' }
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'node.exe' },
      startTimes: { 42: Date.now() },  // 时间查询成功，但没有基准可比
      snapshot: orphanSnapshot(42),
      cmdline: async () => SIG_CMDLINE
    })
    expect(await recoverRecordedPids([noTime], deps)).toEqual({ killed: [42], dropped: [] })
    expect(treeKills).toEqual([42])
  })

  it('查不到启动时刻、也拿不到命令行 → 保留不动手：单凭镜像名杀同名复用进程就是误杀', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'cmd.exe' },
      startTimes: {}  // 一律查不到
    })
    expect(await recoverRecordedPids([entry(42, 'cmd.exe')], deps)).toEqual({ killed: [], dropped: [] })
    expect(treeKills).toEqual([])
  })

  it('查不到启动时刻，但命令行命中签名 → 用命令行这条硬证据回收', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'node.exe' },
      snapshot: orphanSnapshot(42),
      cmdline: async () => SIG_CMDLINE
    })
    expect(await recoverRecordedPids([entry(42, 'node.exe')], deps)).toEqual({ killed: [42], dropped: [] })
    expect(treeKills).toEqual([42])
  })

  it('命令行命中签名、但还挂在活进程树上（本会话新起的子孙被复用了这个 pid）→ 不动手', async () => {
    const procs: ProcInfo[] = [
      proc({ pid: 5, ppid: 1, name: 'LyShell.exe' }),
      proc({ pid: 10, ppid: 5, name: 'cmd.exe' }),
      proc({ pid: 42, ppid: 10, name: 'node.exe', cmdline: SIG_CMDLINE })
    ]
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([5, 10, 42]),
      imageNames: { 42: 'node.exe' },
      snapshot: procs,
      cmdline: async () => SIG_CMDLINE
    })
    expect(await recoverRecordedPids([entry(42, 'node.exe')], deps)).toEqual({ killed: [], dropped: [] })
    expect(treeKills).toEqual([])
  })

  it('旧格式记录（kind 缺失）+ 签名命中 + 孤儿确认 → 照样回收（不因无归属标记永久滞留）', async () => {
    // 证据强度与 sweepOrphanDshWeb 对「无档进程」动手的口径一致：签名命中 + 父链已断。
    // 留着不收的话，升级前的旧档在启动时刻也查不到时永远无法回收，孤儿一直占着会话锁。
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'node.exe' },
      snapshot: orphanSnapshot(42),
      cmdline: async () => 'node /usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 0 --no-open'
    })
    expect(await recoverRecordedPids([legacyEntry(42, 'node.exe')], deps)).toEqual({ killed: [42], dropped: [] })
    expect(treeKills).toEqual([42])
  })

  it('旧格式记录签名命中但仍挂在活进程树上 → 不动手（孤儿确认这条不能少）', async () => {
    // 旧档里的 pid 被本会话（或别的活实例）的新 dsh 树复用时，命令行同样命中签名 ——
    // 挂在活树上就是「有人托管」，与 sweepOrphanDshWeb 同一口径：不动。
    const procs: ProcInfo[] = [
      proc({ pid: 5, ppid: 1, name: 'LyShell.exe' }),
      proc({ pid: 10, ppid: 5, name: 'cmd.exe' }),
      proc({ pid: 42, ppid: 10, name: 'node.exe', cmdline: SIG_CMDLINE })
    ]
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([5, 10, 42]),
      imageNames: { 42: 'node.exe' },
      snapshot: procs,
      cmdline: async () => SIG_CMDLINE
    })
    expect(await recoverRecordedPids([legacyEntry(42, 'node.exe')], deps)).toEqual({ killed: [], dropped: [] })
    expect(treeKills).toEqual([])
  })

  it('旧格式记录签名命中但快照读不出（孤儿状态无法确认）→ 保留不动手', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'node.exe' },
      cmdline: async () => SIG_CMDLINE
    })
    expect(await recoverRecordedPids([legacyEntry(42, 'node.exe')], deps)).toEqual({ killed: [], dropped: [] })
    expect(treeKills).toEqual([])
  })

  it('记录已死、存活子孙命令行读不到 → 不算清干净，root 记录保留（线索不能丢）', async () => {
    // 受保护进程读不出命令行：既不能确认是 DSH，也不能排除 —— 若照旧跳过还标 complete，
    // root 记录被清掉，这个漏网子孙下次启动就再无线索可循。
    const procs: ProcInfo[] = [
      proc({ pid: 42, ppid: 16376, name: 'cmd.exe', cmdline: 'cmd' }),  // 记录里的 root，已死
      proc({ pid: 43, ppid: 42, name: 'node.exe', cmdline: null })
    ]
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([43]),
      imageNames: {},
      snapshot: procs
    })
    expect(await recoverRecordedPids([entry(42, 'cmd.exe')], deps)).toEqual({ killed: [], dropped: [] })
    expect(treeKills).toEqual([])
  })

  it('旧格式记录 + 启动时刻证据 + 签名与孤儿确认 → 可正常回收', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'cmd.exe' },
      startTimes: startedBefore(42),
      snapshot: orphanCmdSnapshot(42)
    })
    expect(await recoverRecordedPids([legacyEntry(42, 'cmd.exe')], deps)).toEqual({ killed: [42], dropped: [] })
    expect(treeKills).toEqual([42])
  })

  it('旧格式记录被新进程树复用（启动晚于记录）→ 判定复用，清档不误杀', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'cmd.exe' },
      startTimes: { 42: 1 + 60_000 },
      snapshot: []
    })
    expect(await recoverRecordedPids([legacyEntry(42, 'cmd.exe')], deps)).toEqual({ killed: [], dropped: [42] })
    expect(treeKills).toEqual([])
  })

  it('isProtectedPid 命中的记录完全不动（本会话刚 spawn 的进程，旧 pid 被复用也不能碰）', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'node.exe' }
    })
    const withProtection = { ...deps, isProtectedPid: (pid: number) => pid === 42 }
    expect(await recoverRecordedPids([entry(42, 'node.exe')], withProtection)).toEqual({
      killed: [],
      dropped: []
    })
    expect(treeKills).toEqual([])
  })

  it('留档 name 为空且两处都拿不到命令行 → 不动手也不清档（下次启动 WMI 也许就恢复了）', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'node' },
      snapshot: null
    })
    expect(await recoverRecordedPids([entry(42, '')], deps)).toEqual({ killed: [], dropped: [] })
    expect(treeKills).toEqual([])
  })

  it('留档 name 为空但命令行命中 dsh web 签名且是遗留孤儿 → 回收（POSIX 形态：真实镜像是 node）', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'node' },
      snapshot: orphanSnapshot(42),
      cmdline: async () => SIG_CMDLINE
    })
    expect(await recoverRecordedPids([entry(42, '')], deps)).toEqual({ killed: [42], dropped: [] })
    expect(treeKills).toEqual([42])
  })

  it('留档 name 为空时改用进程表快照里的命令行作证据（Windows 上 ps 拿不到，只能靠快照）', async () => {
    const pid = 42
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([pid]),
      imageNames: { [pid]: 'node.exe' },
      snapshot: [
        {
          pid,
          ppid: 1,
          name: 'node.exe',
          cmdline: '"node" "C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --port 0 --no-open'
        }
      ]
    })
    expect(await recoverRecordedPids([entry(pid, '')], deps)).toEqual({ killed: [pid], dropped: [] })
    expect(treeKills).toEqual([pid])
  })

  it('留档 name 为空且命令行是别的 node 程序（PID 复用）→ 不动手，记录清掉', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'node' },
      cmdline: async () => 'node /srv/other-app/server.js --port 0 --no-open',
      snapshot: []
    })
    expect(await recoverRecordedPids([entry(42, '')], deps)).toEqual({ killed: [], dropped: [42] })
    expect(treeKills).toEqual([])
  })

  it('root PID 被活进程复用时不按旧 ppid 误杀它新托管的 dsh web', async () => {
    // 旧 root（cmd.exe）死了、pid 42 被活进程复用；43 是它新托管的 dsh web。
    // 相同签名和 ppid 不足以证明 43 属于旧 root。
    const procs: ProcInfo[] = [
      proc({ pid: 42, ppid: 1, name: 'explorer.exe', cmdline: null }),  // 复用者，不是我们的
      proc({ pid: 43, ppid: 42, name: 'node.exe', cmdline: LYSHELL_DSH_WEB })
    ]
    const alive = new Set([42, 43])
    const treeKills: number[] = []
    const result = await recoverRecordedPids([entry(42, 'cmd.exe')], {
      isPidAlive: (p) => alive.has(p),
      listProcesses: async () => procs,
      lookupStartTime: async () => entry(42).recordedAt + 60_000,  // 启动晚于记录 = 复用
      execFile: async (_f: string, args: string[]) => {
        if (args[0] === '/FI') return `"explorer.exe","42","Console","1","1 K"`
        const pid = Number(args[args.indexOf('/PID') + 1])
        treeKills.push(pid)
        alive.delete(pid)
        return ''
      },
      signalPid: () => {}
    })
    expect(result).toEqual({ killed: [], dropped: [] })
    expect(treeKills).toEqual([])
    expect(alive.has(42)).toBe(true)
    expect(alive.has(43)).toBe(true)
  })

  it('子孙 PID 在首次快照后被复用 → 树杀前的重查拦住旧命令行', async () => {
    const before: ProcInfo[] = [
      ...orphanCmdSnapshot(42),
      proc({ pid: 43, ppid: 42, name: 'node.exe', cmdline: LYSHELL_DSH_WEB })
    ]
    const after: ProcInfo[] = [
      ...orphanCmdSnapshot(42),
      proc({ pid: 43, ppid: 42, name: 'explorer.exe', cmdline: 'explorer.exe' })
    ]
    let snapshots = 0
    const kills: number[] = []
    const result = await recoverRecordedPids([entry(42)], {
      isPidAlive: (pid) => pid === 43,
      listProcesses: async () => ++snapshots === 1 ? before : after,
      lookupStartTime: async () => null,
      execFile: async (_file, args) => {
        kills.push(Number(args[args.indexOf('/PID') + 1]))
        return ''
      },
      signalPid: () => {}
    })
    expect(snapshots).toBe(2)
    expect(kills).toEqual([])
    expect(result).toEqual({ killed: [], dropped: [] })
  })

  it('子孙 PID 复用成同名同命令行 → 启动时间晚于快照也会被拦下', async () => {
    const procs: ProcInfo[] = [
      ...orphanCmdSnapshot(42),
      proc({ pid: 43, ppid: 42, name: 'node.exe', cmdline: LYSHELL_DSH_WEB })
    ]
    const kills: number[] = []
    const result = await recoverRecordedPids([entry(42)], {
      isPidAlive: (pid) => pid === 43,
      listProcesses: async () => procs,
      lookupStartTime: async () => 11_000,
      now: () => 10_000,  // 快照读完时旧 pid 还在；新同名进程在此后出生
      execFile: async (_file, args) => {
        kills.push(Number(args[args.indexOf('/PID') + 1]))
        return ''
      },
      signalPid: () => {}
    })
    expect(kills).toEqual([])
    expect(result).toEqual({ killed: [], dropped: [] })
  })

  it('复用确证但进程表读不出 → 无法确认旧 root 的子孙死净，记录保留（线索不能丢）', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'explorer.exe' }  // snapshot 缺省 = null（WMI 不可用）
    })
    expect(await recoverRecordedPids([entry(42, 'cmd.exe')], deps)).toEqual({ killed: [], dropped: [] })
    expect(treeKills).toEqual([])
  })

  it('启动时刻在容差内 → 仍须命令行和孤儿门槛放行', async () => {
    // recordedAt = 1，启动时间晚 3s；可能是慢 spawn 的真身，也可能是复用进程。
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'node.exe' },
      startTimes: { 42: entry(42).recordedAt + 3000 },
      snapshot: orphanSnapshot(42),
      cmdline: async () => SIG_CMDLINE
    })
    expect(await recoverRecordedPids([entry(42, 'node.exe')], deps)).toEqual({ killed: [42], dropped: [] })
    expect(treeKills).toEqual([42])
  })

  it('启动时刻在容差内且命令行证据拿不到 → 保留不动手', async () => {
    const { deps, treeKills } = makeRecoverDeps({
      alive: new Set([42]),
      imageNames: { 42: 'cmd.exe' },  // 名字一样也拦不住误杀，必须靠门槛补证据
      startTimes: { 42: entry(42).recordedAt + 3000 }  // snapshot 缺省 = null，命令行也拿不到
    })
    expect(await recoverRecordedPids([entry(42, 'cmd.exe')], deps)).toEqual({ killed: [], dropped: [] })
    expect(treeKills).toEqual([])
  })
})

describe('parseProcessStartTime', () => {
  it('解析 PowerShell 的 ISO 串（带 Z）', () => {
    expect(parseProcessStartTime('2024-01-02T03:04:05.6789012Z')).toBe(Date.parse('2024-01-02T03:04:05.678Z'))
  })

  it('解析 ps -o lstart= 的格式', () => {
    const text = 'Tue Jan  2 03:04:05 2024'
    expect(parseProcessStartTime(text)).toBe(Date.parse(text))
  })

  it('空串 / 垃圾输入返回 null（调用方按「无法判定」处理，不启用时间判据）', () => {
    expect(parseProcessStartTime('')).toBeNull()
    expect(parseProcessStartTime('   ')).toBeNull()
    expect(parseProcessStartTime('not a date')).toBeNull()
  })
})

describe('pid 留档读写', () => {
  it('round-trip；坏文件 / 不存在当空档', async () => {
    const { promises: fsp } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const path = join(tmpdir(), `dsh-web-pids-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
    try {
      expect(await readPidRecord(path)).toEqual([])

      const entries: RecordedPid[] = [
        { pid: 1, name: 'cmd.exe', cmdline: null, recordedAt: 100 },
        { pid: 2, name: 'node.exe', cmdline: 'x', recordedAt: 200 }
      ]
      await writePidRecord(path, entries)
      expect(await readPidRecord(path)).toEqual(entries)

      await fsp.writeFile(path, 'not json', 'utf8')
      expect(await readPidRecord(path)).toEqual([])

      // 坏行丢弃，好行保留
      await writePidRecord(path, entries)
      const raw = JSON.parse(await fsp.readFile(path, 'utf8')) as unknown[]
      await fsp.writeFile(
        path,
        JSON.stringify([...raw, { pid: -3 }, { pid: 'x' }, null]),
        'utf8'
      )
      expect(await readPidRecord(path)).toEqual(entries)
    } finally {
      await fsp.rm(path, { force: true })
    }
  })

  it('原子写：写入后不留 .tmp；rename 失败时 .tmp 被清理（崩溃恢复档不能有半截文件）', async () => {
    const { promises: fsp } = await import('fs')
    const { existsSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const path = join(tmpdir(), `dsh-web-pids-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
    try {
      await writePidRecord(path, [{ pid: 1, name: 'a', cmdline: null, recordedAt: 1 }])
      expect(existsSync(path)).toBe(true)
      expect(existsSync(`${path}.tmp`)).toBe(false)

      // 用目录占住目标路径让 rename 必败（.tmp 写得进、盖不过目录）
      await fsp.rm(path, { force: true })
      await fsp.mkdir(path)
      await expect(writePidRecord(path, [])).rejects.toThrow()
      expect(existsSync(`${path}.tmp`)).toBe(false)
    } finally {
      await fsp.rm(path, { recursive: true, force: true })
      await fsp.rm(`${path}.tmp`, { force: true })
    }
  })
})
