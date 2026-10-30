import koffi from 'koffi'

/** Windows Job Object 让内核持有整棵子进程树；最后一个 handle 关闭时自动终止成员。 */
export interface DshProcessJob {
  terminate(): boolean
  close(): boolean
  /**
   * Job 内仍在运行的进程数；查询失败返回 undefined。
   *
   * 关闭确认只能以“明确查到 0”为准：undefined 表示无法确认，不能当作空。
   */
  activeProcesses?(): number | undefined
}

const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const EXTENDED_LIMIT_INFORMATION_SIZE_X64 = 144
/**
 * JOBOBJECT_BASIC_ACCOUNTING_INFORMATION（JobObjectBasicAccountingInformation = 1）。
 * 4×LARGE_INTEGER 时间 → 32 字节，随后 TotalPageFaultCount(32)/TotalProcesses(36)/
 * ActiveProcesses(40)/TotalTerminatedProcesses(44)，结构共 48 字节。
 */
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
const BASIC_ACCOUNTING_INFORMATION_SIZE_X64 = 48
const ACTIVE_PROCESSES_OFFSET = 40
const FILETIME_UNIX_EPOCH = 116444736000000000n
/** 只在 Windows 调用。失败返回 null，由上层按已记录的 PID 安全回收。 */
export function attachDshProcessJob(pid: number, spawnedAt: number): DshProcessJob | null {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !Number.isInteger(pid) || pid <= 0) return null

  const kernel32 = koffi.load('kernel32.dll')
  const openProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)')
  const getProcessTimes = kernel32.func('int __stdcall GetProcessTimes(void *process, void *created, void *exited, void *kernel, void *user)')
  const createJob = kernel32.func('void * __stdcall CreateJobObjectW(void *security, void *name)')
  const setJobInfo = kernel32.func('int __stdcall SetInformationJobObject(void *job, int type, void *info, uint32_t size)')
  const assign = kernel32.func('int __stdcall AssignProcessToJobObject(void *job, void *process)')
  const terminateJob = kernel32.func('int __stdcall TerminateJobObject(void *job, uint32_t exitCode)')
  const queryJob = kernel32.func('int __stdcall QueryInformationJobObject(void *job, int infoClass, void *info, uint32_t size, void *returnLength)')
  const closeHandle = kernel32.func('int __stdcall CloseHandle(void *handle)')

  const processHandle = openProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (!processHandle) return null
  let job: bigint | null = null
  try {
    // OpenProcess 给的是内核句柄，核对创建时间后即使 PID 被复用也不会指向另一个进程。
    const created = Buffer.alloc(8)
    if (!getProcessTimes(processHandle, created, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) return null
    const createdAt = Number((created.readBigUInt64LE() - FILETIME_UNIX_EPOCH) / 10000n)
    if (!Number.isFinite(createdAt) || Math.abs(createdAt - spawnedAt) > 1000) return null

    job = createJob(null, null) as bigint | null
    if (!job) return null
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION.BasicLimitInformation.LimitFlags 位于 offset 16。
    const limits = Buffer.alloc(EXTENDED_LIMIT_INFORMATION_SIZE_X64)
    limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16)
    if (!setJobInfo(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits, limits.length)) return null
    if (!assign(job, processHandle)) return null

    const ownedJob = job
    job = null
    let closed = false
    return {
      terminate(): boolean {
        if (closed) return true
        return Boolean(terminateJob(ownedJob, 1))
      },
      close(): boolean {
        if (closed) return true
        closed = Boolean(closeHandle(ownedJob))
        return closed
      },
      activeProcesses(): number | undefined {
        if (closed) return undefined
        const info = Buffer.alloc(BASIC_ACCOUNTING_INFORMATION_SIZE_X64)
        const written = Buffer.alloc(4)
        if (!queryJob(ownedJob, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, info, info.length, written)) {
          return undefined
        }
        return info.readUInt32LE(ACTIVE_PROCESSES_OFFSET)
      }
    }
  } finally {
    closeHandle(processHandle)
    if (job) closeHandle(job)
  }
}
