// LIVE material bank client.
// -------------------------------------------------------------------------
// Talks to the real material-bank service (separate repo; SQLite catalog +
// FTS/vector hybrid search, ~140k products) through the Vite proxy at
// /api/bank/* (the upstream sends no CORS headers — see vite.config.ts).
//
// The re-imagine panels try this first and fall back to the local mock/office
// banks when the service is unreachable, so the UI never breaks offline.

import { BANK_FOOTPRINT, type BankCategory } from './office'

/**
 * Where a price came from and how old it is — the bank's own `price` record.
 *
 * This is the fact that makes a bank number quotable: `basis` says what kind of
 * number it is (listed MRP vs a negotiated rate), `sourceUrl` is the page it was
 * read off, and `ageDays`/`stale` say whether it is still worth quoting. It is
 * passed through verbatim; nothing here is derived or defaulted into existence.
 */
export interface PriceProvenance {
  /** e.g. `listed_mrp` — the kind of price this is. */
  basis: string | null
  /** ISO timestamp the price was observed. */
  observedAt: string | null
  /** The supplier page the price was read from. */
  sourceUrl: string | null
  /** Days since `observedAt`, as the bank counted them. */
  ageDays: number | null
  /** The bank's own verdict on whether the observation has expired. */
  stale: boolean
}

/** One product as the re-imagine panels consume it. Prices are INR (the bank
 *  observes Indian distributor prices); `price` is null when the source
 *  publishes no price (spec-only supplier). */
export interface BankProduct {
  id: string // "bank:<catalog id>" — namespaced so bindings are traceable
  name: string
  vendor: string // brand
  supplier: string // supplier_domain
  price: number | null
  /** Non-null exactly when `price` is non-null — they come from one record. */
  provenance: PriceProvenance | null
  image: string | null
  category: string
}

/**
 * The bank's price field. It is NOT a number: priced rows carry a record whose
 * `price_inr` holds the money and whose siblings hold the provenance.
 *
 * Reading it as a number is why every live-bank price rendered as an em dash —
 * `formatINR` was handed an object, `Number.isFinite` said no, and the panel
 * reported "spec-only supplier" for products the bank had priced to the rupee.
 * The `?? r.price_inr` fallback below it never fired, because `r.price` was
 * truthy. Kept as a union rather than "fixed" to a number, because the bank
 * really does send both shapes and a narrower type would just move the lie.
 */
interface PriceRecord {
  price_inr?: number | null
  price_unit?: string | null
  basis?: string | null
  observed_at?: string | null
  source?: string | null
  source_url?: string | null
  stale?: boolean
  age_days?: number | null
}

interface MatchRow {
  id: number
  brand: string | null
  title: string
  category: string | null
  image_url: string | null
  supplier_domain: string | null
  price: number | PriceRecord | null
  price_inr?: number | null
  score?: number
}

const TIMEOUT_MS = 6000

/** Split the bank's `price` field into money + provenance. A bare number keeps
 *  working (older bank builds sent one) and simply carries no provenance. */
function readPrice(r: MatchRow): { price: number | null; provenance: PriceProvenance | null } {
  const p = r.price
  if (typeof p === 'number') return { price: Number.isFinite(p) ? p : null, provenance: null }
  if (p && typeof p === 'object') {
    const v = p.price_inr
    if (typeof v !== 'number' || !Number.isFinite(v)) return { price: null, provenance: null }
    return {
      price: v,
      provenance: {
        basis: p.basis ?? null,
        observedAt: p.observed_at ?? null,
        sourceUrl: p.source_url ?? null,
        ageDays: typeof p.age_days === 'number' ? p.age_days : null,
        stale: p.stale === true,
      },
    }
  }
  const flat = r.price_inr
  return {
    price: typeof flat === 'number' && Number.isFinite(flat) ? flat : null,
    provenance: null,
  }
}

function toProduct(r: MatchRow): BankProduct {
  const { price, provenance } = readPrice(r)
  return {
    id: `bank:${r.id}`,
    name: r.title,
    vendor: r.brand ?? 'Unknown',
    supplier: r.supplier_domain ?? '',
    price,
    provenance,
    image: r.image_url ?? null,
    category: r.category ?? '',
  }
}

/** Semantic search against the live bank. Throws on network/HTTP failure —
 *  callers catch and fall back to the local bank. */
export async function searchBankLive(query: string, limit = 12): Promise<BankProduct[]> {
  const ctrl = new AbortController()
  const t = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`/api/bank/match?q=${encodeURIComponent(query)}`, {
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`bank ${res.status}`)
    const data = (await res.json()) as { results?: MatchRow[] }
    return (data.results ?? []).slice(0, limit).map(toProduct)
  } finally {
    window.clearTimeout(t)
  }
}

/** Default bank query per document component category — what a designer would
 *  type to re-imagine that element. Imported furniture searches by its real
 *  product name instead (far more specific). */
const CATEGORY_QUERY: Record<string, string> = {
  Desk: 'office desk workstation',
  Chair: 'ergonomic office task chair',
  Table: 'meeting conference table',
  MeetingRoom: 'acoustic meeting pod partition',
  FallCeiling: 'false ceiling acoustic panel',
  Sofa: 'office lounge sofa',
  Storage: 'office storage cabinet',
  Door: 'interior office door',
  Window: 'office glass partition window',
  Column: 'column cladding panel',
}

export function bankQueryFor(category: string): string {
  return CATEGORY_QUERY[category] ?? `office ${category.toLowerCase()}`
}

/**
 * A browsable shelf of the bank — the unit the editor's library panel lists and
 * places from.
 *
 * Three facts have to travel together for a product to become a component on
 * the plan: what to ASK the bank (`query`), what the placed object IS to the
 * document (`docCategory`, the core's category string), and how big it is
 * (`footprint`). The footprint is NOT invented here: it is read from
 * `BANK_FOOTPRINT`, the same table the imported-plan place palette stamps with,
 * so a desk placed from the library and a desk placed from the import palette
 * are the same size by construction rather than by two lists agreeing.
 *
 * The bank publishes no dimensions (`size_mm` is null on every row observed), so
 * a placed item carries the shelf's standard footprint and the panel says so.
 */
export interface BankShelf {
  key: BankCategory
  label: string
  /** The core category string `Editor.add_component` is called with. */
  docCategory: string
  /** What to ask the live bank for this shelf. */
  query: string
}

export const BANK_SHELVES: BankShelf[] = [
  { key: 'desk', label: 'Desks', docCategory: 'Desk', query: 'office desk workstation' },
  { key: 'task-chair', label: 'Task chairs', docCategory: 'Chair', query: 'ergonomic office task chair' },
  { key: 'workstation-bench', label: 'Benches', docCategory: 'Desk', query: 'linear workstation bench system' },
  { key: 'meeting-table', label: 'Meeting tables', docCategory: 'Table', query: 'meeting conference table' },
  { key: 'lounge', label: 'Lounge', docCategory: 'Sofa', query: 'office lounge sofa' },
  { key: 'storage', label: 'Storage', docCategory: 'Storage', query: 'office storage cabinet' },
  { key: 'partition', label: 'Partitions', docCategory: 'Partition', query: 'acoustic office partition screen' },
  { key: 'planter', label: 'Planters', docCategory: 'Planter', query: 'office planter pot indoor' },
]

/** The standard footprint [w, h] in metres this shelf stamps. */
export const shelfFootprint = (s: BankShelf): [number, number] => BANK_FOOTPRINT[s.key]

/**
 * One line of price provenance, for the shelf card: what kind of price it is and
 * how old the observation is. Returns null when the bank sent no record — an
 * absent provenance is stated as absent, never filled in with a plausible one.
 */
export function priceProvenanceLine(p: PriceProvenance | null): string | null {
  if (!p) return null
  const parts: string[] = []
  if (p.basis) parts.push(p.basis.replace(/_/g, ' '))
  if (p.ageDays != null) parts.push(p.stale ? `${p.ageDays}d — stale` : `observed ${p.ageDays}d ago`)
  else if (p.stale) parts.push('stale')
  return parts.length ? parts.join(' · ') : null
}

/** ₹-formatted price, or an em-dash for spec-only products. Non-finite
 *  values (some bank rows carry NaN prices) render as spec-only too. */
export function formatINR(price: number | null): string {
  if (price == null || !Number.isFinite(price)) return '—'
  return `₹${Math.round(price).toLocaleString('en-IN')}`
}
