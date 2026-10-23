import { useEffect, useRef, useState } from 'react'
import type { McpConfirmationData, McpConfirmationReply, McpConfirmationRequest } from '@shared/mcp-confirmation'

function Icon({ kind, size = 16 }: { kind: 'warning' | 'check' | 'copy' | 'close'; size?: number }): JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'warning' ? <><path d="m10.3 3.8-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></> : kind === 'check' ? <path d="m5 12 4 4L19 6" /> : kind === 'copy' ? <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></> : <path d="m6 6 12 12M18 6 6 18" />}
  </svg>
}

const labels = {
  zh: { session: '目标会话', operation: '操作', source: '请求来源', command: '完整命令', content: '操作内容', copy: '复制', copied: '已复制', copyFailed: '复制失败，请选择内容手动复制', reject: '拒绝', allow: '允许一次', close: '关闭并拒绝', hint: '仅批准这一次请求', rules: '需要确认的原因', unavailable: '此请求已失效，请关闭窗口后重新发起。', noTarget: '未指定会话', characters: '字符' },
  en: { session: 'Target session', operation: 'Operation', source: 'Requested by', command: 'Full command', content: 'Operation content', copy: 'Copy', copied: 'Copied', copyFailed: 'Copy failed. Select the content to copy manually.', reject: 'Reject', allow: 'Allow once', close: 'Close and reject', hint: 'Approval applies to this request only', rules: 'Why confirmation is needed', unavailable: 'This request is no longer available. Close this window and try again.', noTarget: 'No session specified', characters: 'characters' }
}

export default function McpConfirmationView({ data, onRequest }: {
  data: McpConfirmationData
  onRequest: (request: McpConfirmationRequest) => Promise<McpConfirmationReply>
}): JSX.Element {
  const text = labels[data.locale]
  const rejectRef = useRef<HTMLButtonElement>(null)
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [expired, setExpired] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    let mounted = true
    void onRequest({ kind: 'ready' }).then(result => {
      if (!mounted) return
      if (result === true) { setReady(true); rejectRef.current?.focus() }
      else setExpired(true)
    }).catch(() => { if (mounted) setExpired(true) })
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); void onRequest({ kind: 'reject' }).catch(() => undefined) }
    }
    window.addEventListener('keydown', onKey)
    return () => { mounted = false; window.removeEventListener('keydown', onKey) }
  }, [onRequest])
  const decide = async (kind: 'reject' | 'allow'): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try { if (await onRequest({ kind }) !== true) setExpired(true) }
    catch { setExpired(true) }
    finally { pending.current = false; setBusy(false) }
  }
  const copy = async (): Promise<void> => {
    try { setCopyState(await onRequest({ kind: 'copy' }) === true ? 'copied' : 'failed') }
    catch { setCopyState('failed') }
  }
  return <section className="mcp-confirmation" role="dialog" aria-modal="true" aria-labelledby="mcp-confirm-title" aria-describedby="mcp-confirm-description">
    <header className="mcp-confirm-heading">
      <Icon kind="warning" size={22} />
      <h1 id="mcp-confirm-title">{data.title}</h1>
      <button type="button" className="mcp-confirm-close" aria-label={text.close} onClick={() => { void decide('reject') }}><Icon kind="close" size={17} /></button>
    </header>
    <div className="mcp-confirm-body">
      <p className="mcp-confirm-description" id="mcp-confirm-description">{data.message}</p>
      <dl className="mcp-confirm-context">
        <div><dt>{text.session}</dt><dd>{data.targets.length ? data.targets.map((target, i) => <span className="mcp-confirm-target" key={i}><bdi>{target.name}</bdi>{target.type && <span className="mcp-confirm-protocol">{target.type.toUpperCase()}</span>}</span>) : text.noTarget}</dd></div>
        <div><dt>{text.operation}</dt><dd><bdi dir="ltr">{data.operation}</bdi></dd></div>
        <div><dt>{text.source}</dt><dd><bdi>{data.source}</bdi></dd></div>
      </dl>
      {!!data.rules?.length && <section className="mcp-confirm-risks" aria-label={text.rules}>
        <h2>{text.rules}</h2>
        <ul>{data.rules.map(rule => <li key={rule.name}>
          <div className="mcp-confirm-risk-heading"><strong>{rule.description}</strong><code>{rule.name}</code></div>
          <pre dir="ltr">{rule.snippet}</pre>
        </li>)}</ul>
      </section>}
      <section className="mcp-confirm-command" aria-labelledby="mcp-confirm-command-title">
        <div className="mcp-confirm-command-heading">
          <h2 id="mcp-confirm-command-title">{data.contentKind === 'command' ? text.command : text.content}</h2>
          <span className="mcp-confirm-count">{data.content.length.toLocaleString(data.locale)} {text.characters}</span>
          <button type="button" onClick={() => { void copy() }} disabled={!ready || expired}>
            <Icon kind={copyState === 'copied' ? 'check' : 'copy'} size={14} />{copyState === 'copied' ? text.copied : text.copy}
          </button>
        </div>
        <pre className="mcp-confirm-code" dir="ltr" tabIndex={0}><code>{data.content}</code></pre>
      </section>
      <span className="mcp-confirm-status" role="status">{copyState === 'copied' ? text.copied : copyState === 'failed' ? text.copyFailed : ''}</span>
      {expired && <p role="alert" className="mcp-confirm-error">{text.unavailable}</p>}
    </div>
    <footer className="mcp-confirm-actions">
      <span>{text.hint}</span>
      <button type="button" ref={rejectRef} disabled={busy} onClick={() => { void decide('reject') }}>{text.reject}</button>
      <button type="button" className="mcp-confirm-allow" disabled={busy || !ready || expired} onClick={() => { void decide('allow') }}>{text.allow}</button>
    </footer>
  </section>
}
