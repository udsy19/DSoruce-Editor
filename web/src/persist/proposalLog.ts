// Tier-3 LLM proposal corpus — the evidentiary tier for branch 4b (ADR 0005).
//
// A validator tested only against failures WE imagined scores well and says
// little about the failures Claude actually produces. Three tiers exist, and a
// claim grades by the tier it was validated on:
//
//   1  hand-authored bad proposals   build-time, ADVISORY only
//   2  harness-elicited across briefs genuine Claude distribution, labeled
//   3  live-session, gated, w/ outcome  EVIDENTIARY  <- this file
//
// Note the discipline differs from the plate calibration log on purpose. That
// log needed evidence of human TRUST, so automated rows were poison. This corpus
// needs coverage of Claude's actual output DISTRIBUTION — automation is not the
// contaminant here, unlabeled provenance is. So tier is recorded rather than
// automation excluded, and only tier 3 additionally requires a real session.
//
// The outcome label is free ground truth: `ai/refine.ts` already computes whether
// an adjustment improved the fixed-weight yardstick and reverts it if not.

import { dbPut, dbGetAll, dbDel } from './db'
import { isRealSession } from './plateLog'

export const PROPOSAL_LOG_SCHEMA = 1

export type ProposalTier = 'hand-authored' | 'harness-elicited' | 'live-session'

export interface ProposalLogEntry {
  at: string
  schema?: number
  tier: ProposalTier
  /** Which pipeline produced it. */
  source: 'refine' | 'designer'
  /** The proposal as the LLM emitted it, before any clamping or repair. */
  proposal: unknown
  /** What the proposal was responding to, for reproducibility. */
  context?: { plateAreaM2?: number; headcount?: number; brief?: string }
  /**
   * What happened to it. `scored-below-base` is the refine loop's own verdict
   * and is ground truth we get for free — a proposal that made the yardstick
   * worse is a labelled bad proposal without anyone judging it.
   */
  outcome: 'applied' | 'reverted' | 'scored-below-base' | 'rejected-by-clamp' | 'pending'
  /** Yardstick before/after, when the refine loop measured them. */
  scoreBefore?: number
  scoreAfter?: number
}

/** Record a proposal. Tier 3 additionally requires a real (human) session. */
export async function logProposal(entry: ProposalLogEntry): Promise<void> {
  if (entry.tier === 'live-session' && !isRealSession()) return
  try {
    await dbPut('proposalLog', { ...entry, schema: PROPOSAL_LOG_SCHEMA })
  } catch {
    /* telemetry must never break a design run */
  }
}

export async function listProposals(tier?: ProposalTier): Promise<ProposalLogEntry[]> {
  try {
    const all = (await dbGetAll('proposalLog')) as ProposalLogEntry[]
    const trusted = all.filter((r) => (r.schema ?? 0) >= PROPOSAL_LOG_SCHEMA)
    if (trusted.length !== all.length) {
      for (const r of all) if ((r.schema ?? 0) < PROPOSAL_LOG_SCHEMA) await dbDel('proposalLog', r.at)
    }
    return tier ? trusted.filter((r) => r.tier === tier) : trusted
  } catch {
    return []
  }
}

/** Corpus size per tier — 4b's claims must be sized to this. */
export async function corpusSizes(): Promise<Record<ProposalTier, number>> {
  const all = await listProposals()
  return {
    'hand-authored': all.filter((r) => r.tier === 'hand-authored').length,
    'harness-elicited': all.filter((r) => r.tier === 'harness-elicited').length,
    'live-session': all.filter((r) => r.tier === 'live-session').length,
  }
}

export async function exportProposalLog(): Promise<string> {
  const rows = await listProposals()
  return JSON.stringify(
    { format: 'dsource-proposal-log', version: PROPOSAL_LOG_SCHEMA, exportedAt: new Date().toISOString(), rows },
    null,
    2,
  )
}
