// The ONE action that produces the whole deliverable pack (gate G10).
//
// It lives in the shell rather than inside the editor's Export menu for two
// reasons: it is the product's headline output (a designer should never have to
// find six buttons for it), and it must exist EXACTLY ONCE in the document —
// the gate asserts that `[data-testid="export-deliverable-pack"]` is
// unambiguous. The Export menu's old "Deliverable pack" item was deleted in the
// same change rather than left as a second way to do the identical thing.
//
// The pack takes minutes (the walkthrough alone is 1290 frames), so this is
// also the progress UI: every stage reports through `PackProgressFn` and the
// panel below renders it live. Nothing here blocks the main thread on its own —
// the renderers yield between frames/stills.

import { useRef, useState } from 'react'
import type { EditorController } from '../App'
import { Icon } from '../ui/icons'
import {
  PACK_STAGES,
  packOverall,
  type DeliverablePackResult,
  type PackProgress,
  type PackStageId,
} from '../export/deliverablePack'

type Phase = 'idle' | 'running' | 'done' | 'error'

export function DeliverablePackAction({
  ensureEditor,
}: {
  /** Mounts the editor if it is not already (the landing route never has it)
   *  and resolves with its controller. */
  ensureEditor: () => Promise<EditorController>
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  // One row per stage: they run concurrently (the server renders the video
  // while this tab builds the workbook and the stills), so there is no single
  // "current" stage to point at.
  const [stages, setStages] = useState<Map<PackStageId, PackProgress>>(new Map())
  const [result, setResult] = useState<DeliverablePackResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  // Guards the double-click: one pack at a time, ever.
  const busy = useRef(false)

  const run = async (): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setPhase('running')
    setCollapsed(false)
    setResult(null)
    setError(null)
    setStages(new Map())
    try {
      const editor = await ensureEditor()
      const out = await editor.deliverablePack((p) =>
        setStages((prev) => new Map(prev).set(p.stage, p)),
      )
      setResult(out)
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    } finally {
      busy.current = false
    }
  }

  const overall = packOverall(stages)
  const stageState = (id: PackStageId): string => {
    const f = stages.get(id)?.fraction ?? 0
    if (phase === 'done' || f >= 1) return 'done'
    return stages.has(id) ? 'active' : 'todo'
  }
  // The most recently reported stage drives the one-line detail under the list.
  const latest = [...stages.values()].pop() ?? null

  return (
    <div className={`pack-dock${phase === 'running' && !collapsed ? ' open' : ''}`}>
      <button
        className={`pack-btn${phase === 'running' ? ' busy' : ''}`}
        data-testid="export-deliverable-pack"
        onClick={() => void run()}
        disabled={phase === 'running'}
        title="Quantity takeoff · plan · room renders · walkthrough video · share link — one action"
        aria-busy={phase === 'running'}
      >
        <Icon name="layers" size={14} />
        {phase === 'running' ? `Building pack… ${Math.round(overall * 100)}%` : 'Deliverable pack'}
      </button>

      {phase === 'running' && (
        <div className="pack-panel" role="status" aria-live="polite" data-testid="pack-progress">
          <div className="pack-panel-head">
            <span>Deliverable pack</span>
            <button className="pack-collapse" onClick={() => setCollapsed((c) => !c)}>
              {collapsed ? 'Show' : 'Hide'}
            </button>
          </div>
          <div className="pack-bar">
            <div className="pack-bar-fill" style={{ width: `${Math.round(overall * 100)}%` }} />
          </div>
          {!collapsed && (
            <ol className="pack-stages">
              {PACK_STAGES.map((s) => {
                const p = stages.get(s.id)
                return (
                  <li key={s.id} className={`pack-stage ${stageState(s.id)}`}>
                    <span className="pack-stage-name">{s.label}</span>
                    {p && (
                      <span className="pack-stage-note">
                        {p.note ?? `${Math.round(p.fraction * 100)}%`}
                      </span>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
          {!collapsed && latest && <div className="pack-detail">{latest.label}</div>}
        </div>
      )}

      {phase === 'done' && result && (
        <div className="pack-panel" role="status" data-testid="pack-done">
          <div className="pack-panel-head">
            <span>Pack ready</span>
            <button className="pack-collapse" onClick={() => setPhase('idle')}>
              Dismiss
            </button>
          </div>
          <div className="pack-detail">
            {result.kind === 'server'
              ? `${result.files.length} artifacts written to ${result.where}`
              : `Downloaded ${result.where} (${(result.bytes / 1024 / 1024).toFixed(1)} MB)`}
            {result.videoBytes > 0 &&
              ` · walkthrough ${(result.videoBytes / 1024 / 1024).toFixed(1)} MB (${
                result.videoBy === 'server' ? 'server render' : 'in-browser encode'
              })`}
          </div>
          {result.shareUrl && (
            <a className="pack-link" href={result.shareUrl} target="_blank" rel="noreferrer">
              Open the 3D share link
            </a>
          )}
        </div>
      )}

      {phase === 'error' && (
        <div className="pack-panel error" role="alert" data-testid="pack-error">
          <div className="pack-panel-head">
            <span>Pack failed</span>
            <button className="pack-collapse" onClick={() => setPhase('idle')}>
              Dismiss
            </button>
          </div>
          <div className="pack-detail">{error}</div>
        </div>
      )}
    </div>
  )
}
