import { FormEvent, useEffect, useRef, useState } from 'react'
import { EditorCanvas } from '../editor/EditorCanvas'
import { useAgent, Msg } from './useAgent'
import { PreviewDiff, ToolCall } from './contract'
import { Icon } from '../ui/icons'

export function AgentPanel({ ec, onClose }: { ec: EditorCanvas; onClose: () => void }) {
  const { messages, busy, canUndo, send, approve, reject, undo } = useAgent(ec)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 1e9 })
  }, [messages])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    send(input)
    setInput('')
  }

  return (
    <div className="agent" data-testid="agent-panel">
      <div className="agent-head">
        <span className="agent-title">
          <Icon name="sparkles" size={15} /> Assistant
        </span>
        <div className="agent-head-actions">
          {canUndo && (
            <button className="agent-undo" onClick={undo} data-testid="ai-undo">
              Undo
            </button>
          )}
          <button className="agent-close" onClick={onClose} aria-label="Close assistant">
            ×
          </button>
        </div>
      </div>

      <div className="agent-scroll" ref={scrollRef}>
        {messages.map((m) => (
          <Message key={m.id} m={m} onOption={(o) => send(o)} onApprove={approve} onReject={reject} />
        ))}
        {busy && (
          <div className="agent-msg assistant">
            <span className="agent-typing">thinking…</span>
          </div>
        )}
      </div>

      <form className="agent-input" onSubmit={submit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask me to change the plan…"
          data-testid="ai-input"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()} data-testid="ai-send">
          <Icon name="caret" size={16} />
        </button>
      </form>
    </div>
  )
}

function Message({
  m,
  onOption,
  onApprove,
  onReject,
}: {
  m: Msg
  onOption: (o: string) => void
  onApprove: (id: number, calls: ToolCall[]) => void
  onReject: (id: number) => void
}) {
  if (m.role === 'user') return <div className="agent-msg user">{m.text}</div>
  if (m.role === 'assistant') return <div className="agent-msg assistant">{m.text}</div>
  if (m.role === 'clarify')
    return (
      <div className="agent-msg assistant">
        {m.text}
        <div className="agent-chips">
          {m.options.map((o, i) => (
            <button key={i} className="agent-chip" onClick={() => onOption(o)}>
              {o}
            </button>
          ))}
        </div>
      </div>
    )
  return (
    <div className="agent-msg assistant">
      {m.text}
      <ConsequenceCard diff={m.diff} />
      {m.status === 'pending' ? (
        <div className="agent-actions">
          <button className="agent-approve" onClick={() => onApprove(m.id, m.calls)} data-testid="ai-approve">
            Apply
          </button>
          <button className="agent-reject" onClick={() => onReject(m.id)} data-testid="ai-reject">
            Discard
          </button>
        </div>
      ) : (
        <div className={`agent-status ${m.status}`}>
          {m.status === 'applied' ? '✓ Applied' : 'Discarded'}
        </div>
      )}
    </div>
  )
}

function ConsequenceCard({ diff }: { diff: PreviewDiff }) {
  return (
    <div className="cons-card">
      <div className="cons-eyebrow">If applied</div>
      <div className="cons-deltas">
        {diff.deltas.map((d, i) => (
          <div className="cons-row" key={i}>
            <span className="cons-label">{d.label}</span>
            <span className="cons-vals num">
              <span className="cons-before">{d.before}</span>
              <span className={`cons-arrow ${d.dir} ${d.valence}`}>
                {d.dir === 'up' ? '↑' : d.dir === 'down' ? '↓' : '='}
              </span>
              <span className={`cons-after ${d.valence}`}>{d.after}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="cons-notes">
        {diff.consequences.map((c, i) => (
          <div key={i} className={`cons-note ${c.severity}`}>
            {c.text}
          </div>
        ))}
      </div>
    </div>
  )
}
