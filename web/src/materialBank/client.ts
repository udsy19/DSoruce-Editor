// LIVE material bank client.
// -------------------------------------------------------------------------
// Talks to the real material-bank service (separate repo; SQLite catalog +
// FTS/vector hybrid search, ~140k products) through the Vite proxy at
// /api/bank/* (the upstream sends no CORS headers — see vite.config.ts).
//
// The re-imagine panels try this first and fall back to the local mock/office
// banks when the service is unreachable, so the UI never breaks offline.

/** One product as the re-imagine panels consume it. Prices are INR (the bank
 *  observes Indian distributor prices); `price` is null when the source
 *  publishes no price (spec-only supplier). */
export interface BankProduct {
  id: string // "bank:<catalog id>" — namespaced so bindings are traceable
  name: string
  vendor: string // brand
  supplier: string // supplier_domain
  price: number | null
  image: string | null
  category: string
}

interface MatchRow {
  id: number
  brand: string | null
  title: string
  category: string | null
  image_url: string | null
  supplier_domain: string | null
  price: number | null
  price_inr?: number | null
  score?: number
}

const TIMEOUT_MS = 6000

function toProduct(r: MatchRow): BankProduct {
  return {
    id: `bank:${r.id}`,
    name: r.title,
    vendor: r.brand ?? 'Unknown',
    supplier: r.supplier_domain ?? '',
    price: r.price ?? r.price_inr ?? null,
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

/** ₹-formatted price, or an em-dash for spec-only products. Non-finite
 *  values (some bank rows carry NaN prices) render as spec-only too. */
export function formatINR(price: number | null): string {
  if (price == null || !Number.isFinite(price)) return '—'
  return `₹${Math.round(price).toLocaleString('en-IN')}`
}
