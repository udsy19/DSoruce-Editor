// The plan-quality checks themselves — ONE implementation, imported by both the
// board (`run-all.mjs`) and its sabotage round (`falsify.mjs`). A falsification
// that re-implemented the check would be proving a different thing than the one
// that ships.
//
// INDEPENDENCE. Every function here reads GEOMETRY PRIMITIVES only — component
// and zone coordinates. Deliberately never read:
//   * `circulation()`'s summary (`min_corridor_width`, `pct_corridors_below_min`)
//     — the core's own account of the quality of what the core produced;
//   * `Program.cluster_cols` — what the packer INTENDED, not what it did;
//   * `zone.component_ids` — the core's own grouping answer, which is what PQ1
//     exists to check independently;
//   * `zone.label`, `component.label`, `seats`, `decision`, `wall.generated`.
// `falsify.mjs` corrupts and then DELETES each of those and asserts the verdict
// is unchanged.
//
// ONE DEPENDENCY IS STATED, NOT HIDDEN: PQ2 selects rooms by `zone.zone_type`,
// excluding Circulation/Workspace/Core. That is producer metadata the gate
// currently trusts rather than validates. Its direction of trust is safe —
// corrupting a room's type can only REMOVE pairs from consideration, making the
// gate more permissive, never falsely accusing — but a genuine dead sliver
// beside a mistyped zone would be missed. Closing that needs enclosure
// re-derived from wall geometry; it is recorded as open in the ledger.

/** Generated partition thickness (m): `layout/emit.rs::PARTITION_T = 0.1`;
 *  glazed fronts `GLAZING_T = 0.05`. A gap between two room interiors at or
 *  below this is ONE SHARED WALL — correct architecture, never a defect. The
 *  slack covers a 0.1 partition meeting a 0.05 glazed front, plus float error. */
export const WALL_MAX_M = 0.155

/** Minimum width (m) of a gap a person can use. The mission's §1.1.3 puts
 *  secondary aisles at 1.1–1.2 m; NBC 2016 puts egress corridors at 1.5. This
 *  uses the SECONDARY figure — the most generous defensible floor, so a failure
 *  here cannot be argued down as an over-strict threshold. */
export const WALK_MIN_M = 1.1

/** Neighbourhood size bounds (desks). Mission §1.1.2: "clusters of ~6–12". */
export const CLUSTER_MIN = 6
export const CLUSTER_MAX = 12

const rectOf = (z) => (z.shape && z.shape.kind === 'Rect' ? z.shape : null)

/** Footprint of a component as an axis-aligned rect, honouring rotation by
 *  swapping w/h on quarter turns. Coordinates only. */
export function footprint(c) {
  const q = Math.round((c.rotation ?? 0) / (Math.PI / 2)) % 2
  const w = q === 0 ? c.w : c.h
  const h = q === 0 ? c.h : c.w
  return { x: c.x - w / 2, y: c.y - h / 2, w, h }
}

/** Edge-to-edge gap between two rects; 0 when they touch or overlap. */
export function rectGap(a, b) {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)))
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)))
  return Math.hypot(dx, dy)
}

/** Gap between two axis-aligned rects across the face they SHARE. Returns null
 *  when they intersect (overlap on both axes) or are diagonal to each other
 *  (overlap on neither) — in both cases there is no face gap to classify. */
export function faceGap(a, b) {
  const ovX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const ovY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (ovX > 0.05 && ovY > 0.05) return null
  if (ovY > 0.05) return { gap: Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w), span: ovY, axis: 'X' }
  if (ovX > 0.05) return { gap: Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h), span: ovX, axis: 'Y' }
  return null
}

/**
 * PQ1 — desks read as neighbourhoods.
 *
 * PROPERTY: an open field is legible when it reads as bounded neighbourhoods,
 * not one undifferentiated mat. Operationally: partition the desks into
 * connected components where two desks are connected iff the gap between their
 * footprints is BELOW the walkable aisle minimum. A cluster is then precisely a
 * group you cannot walk into the middle of — which is what a neighbourhood is —
 * and the partition is computed from coordinates alone.
 */
export function pq1(state) {
  const desks = (state.components ?? []).filter((c) => c.category === 'Desk' && !c.reference)
  const fps = desks.map(footprint)
  const n = fps.length
  const parent = [...Array(n).keys()]
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[a] = b }

  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (rectGap(fps[i], fps[j]) < WALK_MIN_M - 1e-9) union(i, j)

  const groups = new Map()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(i)
  }
  const sizes = [...groups.values()].map((g) => g.length).sort((a, b) => b - a)
  const offenders = sizes.filter((s) => s < CLUSTER_MIN || s > CLUSTER_MAX)

  return {
    ok: n > 0 && offenders.length === 0,
    checks: n,
    sizes,
    detail:
      `${n} desks -> ${sizes.length} neighbourhood(s) [${sizes.join(', ')}]; ` +
      `${offenders.length} outside ${CLUSTER_MIN}-${CLUSTER_MAX}`,
  }
}

/**
 * PQ2 — every gap between two rooms is a shared wall or a usable passage.
 *
 * PROPERTY: anything in between is floor that is paid for, billed in the area
 * rollup, and can never be occupied or walked through.
 *
 * This is the shape question a scalar could not answer. `min_corridor_width`
 * reported 0.30 m with 50.1% of cells "below minimum", which reads as a
 * circulation catastrophe; the table shows nine truly dead slivers plus three
 * merely sub-standard gaps, while the six 0.10 m readings are shared partitions
 * and entirely correct. A gate on the scalar would have been mostly wrong and
 * unfixable.
 */
export function pq2(state) {
  const rooms = (state.zones ?? [])
    .filter((z) => !['Circulation', 'Workspace', 'Core'].includes(z.zone_type))
    .map((z) => ({ z, r: rectOf(z) }))
    .filter((o) => o.r)

  const rows = []
  let checks = 0
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const g = faceGap(rooms[i].r, rooms[j].r)
      if (!g || g.gap < 0) continue
      checks++
      if (g.gap > WALL_MAX_M && g.gap < WALK_MIN_M) {
        rows.push({
          gap: g.gap,
          area: g.gap * g.span,
          // `label` is for the human reading the failure, never for the verdict.
          a: rooms[i].z.label || `zone ${rooms[i].z.id}`,
          b: rooms[j].z.label || `zone ${rooms[j].z.id}`,
        })
      }
    }
  }
  rows.sort((p, q) => p.gap - q.gap)
  const dead = rows.reduce((s, x) => s + x.area, 0)

  return {
    ok: rows.length === 0,
    checks,
    rows,
    detail:
      rows.length === 0
        ? `${checks} room-pair faces, none in the sub-minimum band (${WALL_MAX_M}, ${WALK_MIN_M}) m`
        : `${rows.length} sub-minimum gap(s), ${dead.toFixed(2)} m2: ` +
          rows.map((s) => `${s.gap.toFixed(2)}m ${s.a}|${s.b}`).join(', '),
  }
}
