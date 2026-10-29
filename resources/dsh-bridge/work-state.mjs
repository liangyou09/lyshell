// 持久记录只保存数据；审批 promise、凭据和待执行 prompt 都不能跨进程恢复。
export const newNativeState = owner => ({ owner, sessionId: null, lastTask: null,
  sessions: new Map(), tasks: new Map(), requests: new Map(), retired: new Map(), submissions: new Map(),
  approvals: new Map(), output: [], pending: 0, disconnecting: false, viewRevision: 0,
  tail: Promise.resolve() })

const terminal = state => ['completed', 'failed', 'cancelled'].includes(state)
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128
const bad = () => { throw new Error('journal/invalid-state') }

export function saveNativeState(journal, state) {
  if (!journal) return
  const records = [...new Set([...state.tasks.values(), ...state.requests.values(),
    ...[...state.sessions.values()].map(row => row.current).filter(Boolean), state.lastTask].filter(Boolean))]
  const ref = record => record ? record.task.attemptId ?? record.task.taskId : null
  journal.save(state.owner, { schema: 1, sessionId: state.sessionId, lastTask: ref(state.lastTask),
    sessions: [...state.sessions.values()].map(row => ({ sessionId: row.sessionId, workspace: row.workspace,
      executionSessionId: row.executionSessionId ?? row.sessionId, current: ref(row.current) })),
    records: records.map(record => ({ task: record.task, digest: record.digest, accepted: record.accepted,
      floor: record.floor, eventSeq: record.eventSeq, turn: record.turn, seq: record.seq,
      transcript: record.transcript, truncated: record.truncated })),
    tasks: [...state.tasks].map(([key, record]) => [key, ref(record)]),
    requests: [...state.requests].map(([key, record]) => [key, ref(record)]), retired: [...state.retired] })
}

export function loadNativeStates(journal) {
  const states = new Map(), sessions = new Set()
  if (!journal) return { states, sessions }
  for (const { owner, value } of journal.loadAll()) {
    if (!value || value.schema !== 1 || !Array.isArray(value.sessions) || value.sessions.length > 64 ||
      !Array.isArray(value.records) || value.records.length > 321 || !Array.isArray(value.tasks) ||
      value.tasks.length > 321 || !Array.isArray(value.requests) || value.requests.length > 256 ||
      value.retired !== undefined && (!Array.isArray(value.retired) || value.retired.length > 10000)) bad()
    const state = newNativeState(owner), records = new Map()
    let outputCount = 0
    for (const saved of value.records) {
      const task = saved?.task, ref = task?.attemptId ?? task?.taskId
      if (!id(ref) || !id(task?.taskId) || !id(task?.sessionId) || !id(task?.requestId) || records.has(ref) ||
        !['accepted', 'running', 'unconfirmed', 'completed', 'failed', 'cancelled'].includes(task.state) ||
        !/^[a-f0-9]{64}$/.test(saved.digest) || typeof saved.accepted !== 'boolean' ||
        !Number.isSafeInteger(saved.floor) || !Number.isSafeInteger(saved.eventSeq) ||
        !(saved.turn === null || Number.isSafeInteger(saved.turn)) || !Number.isSafeInteger(saved.seq) ||
        !Array.isArray(saved.transcript) || saved.transcript.length > 256) bad()
      const record = { ...saved, task: { ...task }, owner: state, approvals: new Map() }
      if (!terminal(task.state)) {
        record.task.lastConfirmedState = task.lastConfirmedState ?? task.state
        record.task.state = 'unconfirmed'
        record.task.recoveryRequired = true
        record.task.interruptedAt ??= Date.now()
      }
      for (const entry of record.transcript) {
        if (!entry || entry.taskId !== task.taskId || entry.sessionId !== task.sessionId ||
          typeof entry.text !== 'string' || entry.text.length > 512 || !Number.isSafeInteger(entry.seq)) bad()
        state.output.push({ record, entry }); outputCount++
      }
      records.set(ref, record)
    }
    if (outputCount > 256) bad()
    for (const saved of value.sessions) {
      if (!id(saved?.sessionId) || sessions.has(saved.sessionId) || saved.executionSessionId !== undefined && !id(saved.executionSessionId) || typeof saved.workspace !== 'string' ||
        saved.workspace.length > 2048 || state.sessions.has(saved.sessionId)) bad()
      const current = saved.current === null ? null : records.get(saved.current)
      if (saved.current !== null && (!current || current.task.sessionId !== saved.sessionId)) bad()
      state.sessions.set(saved.sessionId, { ...saved, current, pending: false })
      sessions.add(saved.sessionId)
    }
    for (const [key, ref] of value.tasks) {
      const record = records.get(ref)
      if (!record || key !== record.task.taskId || !state.sessions.has(record.task.sessionId) || state.tasks.has(key)) bad()
      state.tasks.set(key, record)
    }
    for (const [key, ref] of value.requests) {
      const record = records.get(ref)
      if (!record || key !== record.task.requestId || state.requests.has(key)) bad()
      state.requests.set(key, record)
    }
    for (const [key, saved] of value.retired ?? []) {
      if (!id(key) || !saved || !id(saved.task?.taskId) || !id(saved.task?.sessionId) || saved.task.requestId !== key ||
        !terminal(saved.task.state) || !/^[a-f0-9]{64}$/.test(saved.digest) || state.requests.has(key) || state.retired.has(key)) bad()
      state.retired.set(key, saved)
    }
    state.sessionId = value.sessionId
    state.lastTask = value.lastTask === null ? null : records.get(value.lastTask)
    if (state.sessionId !== null && !state.sessions.has(state.sessionId) || value.lastTask !== null && !state.lastTask) bad()
    state.output.sort((a, b) => a.entry.at - b.entry.at)
    states.set(owner, state)
  }
  const sessionOwners = new Map([...states].flatMap(([owner, state]) => [...state.sessions.keys()].map(id => [id, owner])))
  for (const [owner, state] of states) for (const record of [...state.tasks.values(), ...state.requests.values(), ...state.retired.values()]) {
    const execution = record.task.executionSessionId ?? record.task.sessionId
    if (!id(execution) || sessionOwners.has(execution) && sessionOwners.get(execution) !== owner) bad()
    sessionOwners.set(execution, owner); sessions.add(execution)
  }
  return { states, sessions }
}
