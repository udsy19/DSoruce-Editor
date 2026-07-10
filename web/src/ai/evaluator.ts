import type { Candidate, Program } from '../editor/EditorCanvas'

/**
 * Claude-in-the-loop soft-goal evaluator (the vision's "judge the aesthetic
 * goals a metric can't"). Takes the autonomous search's top-K candidates and
 * asks Claude — via the key-holding /api/claude dev proxy — to judge layout
 * coherence: cluster regularity, meeting-room placement, corridor legibility,
 * dead zones. One request judges the WHOLE batch, so every candidate the
 * gallery shows carries its own verdict — not just the top scorer.
 *
 * Gated by design: the `hardTarget` acts as a batch worth-it check — if NOT
 * ONE candidate clears it, the whole batch is too weak to spend tokens on and
 * we return null. Once it's worth running, every candidate is judged. No key,
 * or any failure, also → null; the UI treats null as "no AI ranking" and shows
 * a uniform (empty) state across all cards.
 */

export interface SoftVerdict {
  seed: number
  /** Soft-quality judgement, 0–100. */
  score: number
  /** One-line critique, ≤140 chars. */
  verdict: string
}

export interface EvalResult {
  verdicts: SoftVerdict[]
  model: string
}

const SYSTEM_PROMPT = `You are an expert office test-fit critic. You review generated office floor-plan candidates — each already scored on hard numeric metrics (capacity, adjacency, circulation, density) — and judge the SOFT qualities a metric cannot capture:
- desk-cluster regularity: even, rational grids vs ragged or orphaned clusters
- meeting-room placement: rooms at the plate edge or grouped in a band are good; rooms blocking natural flow or stranded mid-floor are bad
- corridor legibility: a clear, continuous circulation spine vs dog-legs and pinch points
- dead zones: unusable leftover pockets of floor area

Each option is described by its seed, hard scores, desk count and (when available) a coarse plan sketch. Judge each option independently on soft quality alone — do not simply restate the hard scores.

Respond with STRICT JSON only — a bare array, no markdown fences, no prose:
[{"seed": <number>, "score": <0-100 integer>, "verdict": "<one sentence, max 140 chars>"}]
Include exactly one entry per option, using each option's seed.`

let availability: Promise<boolean> | null = null

/** Whether the /api/claude proxy has a key. Cached for the session. */
export function evaluatorAvailable(): Promise<boolean> {
  if (!availability) {
    availability = fetch('/api/claude')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !!(d as { configured?: boolean } | null)?.configured)
      .catch(() => false)
  }
  return availability
}

/** Hard-constraint gate: which candidates clear the target (batch worth-it check). */
export function gateCandidates(candidates: Candidate[], hardTarget: number): Candidate[] {
  return candidates.filter((c) => c.score.total >= hardTarget)
}

/**
 * Judge EVERY candidate in ONE Claude request so the whole gallery is annotated
 * consistently — not just the top scorer. `hardTarget` only decides whether the
 * batch is worth any tokens at all (at least one candidate must clear it).
 * `summaries` (keyed by seed) lets the orchestrator pass richer per-candidate
 * text — e.g. an ASCII occupancy sketch — derived while each candidate's
 * snapshot was live; we never restore snapshots here (that would mutate the
 * live document).
 */
export async function evaluateCandidates(
  candidates: Candidate[],
  program: Program,
  hardTarget: number,
  summaries?: Record<number, string>,
): Promise<EvalResult | null> {
  if (candidates.length === 0) return null
  // Worth spending tokens only if at least one candidate clears the hard gate —
  // but once it is, judge all displayed candidates, not only the passing ones.
  if (gateCandidates(candidates, hardTarget).length === 0) return null
  if (!(await evaluatorAvailable())) return null

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 20_000)
  try {
    const resp = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildPrompt(candidates, program, summaries) }],
        max_tokens: 1024,
      }),
      signal: controller.signal,
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as {
      model?: string
      content?: { type: string; text?: string }[]
    }
    const text = (data.content ?? []).find((b) => b.type === 'text')?.text ?? ''
    const known = new Set(candidates.map((c) => c.seed))
    const verdicts = parseVerdicts(text).filter((v) => known.has(v.seed))
    if (verdicts.length === 0) return null
    return { verdicts, model: data.model ?? 'claude' }
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

function buildPrompt(
  candidates: Candidate[],
  program: Program,
  summaries?: Record<number, string>,
): string {
  const lines: string[] = [
    `Program: ${program.desks} desks in ${program.cluster_cols}-column clusters, ${program.meeting_rooms} meeting rooms, target corridor ${program.target_corridor_m}m.`,
    `${candidates.length} candidate layout(s) to judge:`,
  ]
  candidates.forEach((c, i) => {
    const s = c.score
    lines.push(
      '',
      `Option ${String.fromCharCode(65 + (i % 26))} (${c.strategy} strategy, seed ${c.seed}): total ${s.total.toFixed(1)} — capacity ${s.capacity.toFixed(0)}, adjacency ${s.adjacency.toFixed(0)}, circulation ${s.circulation.toFixed(0)}, density ${s.density.toFixed(0)}; ${s.placed_desks} desks placed.`,
    )
    const extra = summaries?.[c.seed]
    if (extra) lines.push(extra)
  })
  return lines.join('\n')
}

/**
 * Parse the model's reply into SoftVerdict[]. Robust to code fences,
 * surrounding prose, extra keys, and malformed rows (dropped).
 */
export function parseVerdicts(text: string): SoftVerdict[] {
  const stripped = text.replace(/```(?:json)?/gi, '').trim()
  const start = stripped.indexOf('[')
  const end = stripped.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let rows: unknown
  try {
    rows = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: SoftVerdict[] = []
  const seen = new Set<number>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const seed = typeof r.seed === 'number' ? r.seed : NaN
    const score = typeof r.score === 'number' ? r.score : NaN
    const verdict = typeof r.verdict === 'string' ? r.verdict.trim() : ''
    if (!Number.isFinite(seed) || !Number.isFinite(score) || !verdict) continue
    if (seen.has(seed)) continue
    seen.add(seed)
    out.push({
      seed,
      score: Math.max(0, Math.min(100, Math.round(score))),
      verdict: verdict.length > 140 ? `${verdict.slice(0, 139)}…` : verdict,
    })
  }
  return out
}
