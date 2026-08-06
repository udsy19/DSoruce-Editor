// LibreDWG JSON → DXF text, the fallback conversion path.
//
// `dwg2dxf` is the primary DWG→DXF converter, and on some real files it simply
// cannot finish: across a 24-file corpus it segfaulted on two (`…_AC.dwg`,
// `…_AF.dwg`) and silently truncated a third (`Apartment-1.dwg`, which exits 0
// having written no ENTITIES section — see dwgVerify.ts). Those three files
// were unopenable.
//
// LibreDWG's *other* front end, `dwgread -O JSON`, reads all three without
// complaint: Apartment-1 alone yields 3,418 LINEs, 1,598 ARCs and 518
// LWPOLYLINEs where the DXF path yielded nothing. The DWG reading is the same
// library; only the writer differs, and it is the DXF writer that crashes.
//
// So this module re-emits that JSON as DXF text and hands it to the EXISTING
// `parseDrawing`. It deliberately does not build a `Drawing` directly: unit
// inference, block flattening, category assignment and the dominant-cluster
// filter all live in dxf.ts, and a second path into `Drawing` would be a second
// derivation to keep in sync. This is a transcoder, not an importer.
//
// Pure — no Node APIs — so both `/api/dwg` implementations can use it.

/** A LibreDWG handle: [code, size, value, absref]. The last element is the id. */
type Handle = number[]

interface JsonObject {
  entity?: string
  object?: string
  handle?: Handle
  name?: string
  layer?: Handle
  entities?: Handle[]
  [k: string]: unknown
}

interface DwgJson {
  HEADER?: Record<string, unknown>
  OBJECTS?: JsonObject[]
}

const ref = (h: unknown): number | null =>
  Array.isArray(h) && h.length > 0 ? Number(h[h.length - 1]) : null

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const xy = (v: unknown): [number, number] | null => {
  if (!Array.isArray(v) || v.length < 2) return null
  const x = Number(v[0])
  const y = Number(v[1])
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
}

const DEG = 180 / Math.PI

/** Accumulates DXF group-code/value pairs. */
class DxfWriter {
  private out: string[] = []
  pair(code: number | string, value: string | number): void {
    this.out.push(String(code), String(value))
  }
  text(): string {
    return this.out.join('\n')
  }
}

/**
 * Re-emit LibreDWG JSON as DXF text.
 *
 * Covers the entity types that carry plan geometry. Anything else is skipped
 * rather than guessed at — an entity we cannot faithfully transcribe is better
 * absent than wrong, and `parseDrawing` already tolerates gaps.
 */
export function dwgJsonToDxf(input: unknown): string {
  const doc = (input ?? {}) as DwgJson
  const objects = Array.isArray(doc.OBJECTS) ? doc.OBJECTS : []

  // --- resolve handles -------------------------------------------------
  const layerName = new Map<number, string>()
  const blockName = new Map<number, string>()
  const byHandle = new Map<number, JsonObject>()
  for (const o of objects) {
    const h = ref(o.handle)
    if (h == null) continue
    byHandle.set(h, o)
    if (o.object === 'LAYER' && typeof o.name === 'string') layerName.set(h, o.name)
    if (o.object === 'BLOCK_HEADER' && typeof o.name === 'string') blockName.set(h, o.name)
  }

  const layerOf = (o: JsonObject): string => {
    const h = ref(o.layer)
    return (h != null && layerName.get(h)) || '0'
  }

  // Which entities belong to model space, and which to a block definition.
  // Anything owned by a paper-space or block header is emitted inside BLOCKS,
  // so INSERT resolution in dxf.ts still works.
  const modelSpaceEntities = new Set<number>()
  const blockEntities = new Map<string, number[]>()
  for (const o of objects) {
    if (o.object !== 'BLOCK_HEADER') continue
    const name = typeof o.name === 'string' ? o.name : ''
    const handles = (Array.isArray(o.entities) ? o.entities : [])
      .map(ref)
      .filter((h): h is number => h != null)
    if (/^\*model_space$/i.test(name)) {
      for (const h of handles) modelSpaceEntities.add(h)
    } else if (name && !/^\*paper_space/i.test(name)) {
      blockEntities.set(name, handles)
    }
  }

  const w = new DxfWriter()

  // --- HEADER ----------------------------------------------------------
  w.pair(0, 'SECTION')
  w.pair(2, 'HEADER')
  const insunits = doc.HEADER?.INSUNITS
  if (insunits != null && Number.isFinite(Number(insunits))) {
    w.pair(9, '$INSUNITS')
    w.pair(70, Math.trunc(Number(insunits)))
  }
  w.pair(0, 'ENDSEC')

  // --- TABLES (layers) -------------------------------------------------
  w.pair(0, 'SECTION')
  w.pair(2, 'TABLES')
  w.pair(0, 'TABLE')
  w.pair(2, 'LAYER')
  for (const name of new Set(layerName.values())) {
    w.pair(0, 'LAYER')
    w.pair(2, name)
    w.pair(70, 0)
  }
  w.pair(0, 'ENDTAB')
  w.pair(0, 'ENDSEC')

  /** Emit one entity's DXF, or nothing if we cannot transcribe it faithfully. */
  const writeEntity = (o: JsonObject): void => {
    const layer = layerOf(o)
    switch (o.entity) {
      case 'LINE': {
        const a = xy(o.start)
        const b = xy(o.end)
        if (!a || !b) return
        w.pair(0, 'LINE')
        w.pair(8, layer)
        w.pair(10, a[0])
        w.pair(20, a[1])
        w.pair(11, b[0])
        w.pair(21, b[1])
        return
      }
      case 'ARC': {
        const c = xy(o.center)
        const r = num(o.radius, -1)
        if (!c || r <= 0) return
        w.pair(0, 'ARC')
        w.pair(8, layer)
        w.pair(10, c[0])
        w.pair(20, c[1])
        w.pair(40, r)
        // DXF wants degrees; LibreDWG JSON stores radians.
        w.pair(50, num(o.start_angle) * DEG)
        w.pair(51, num(o.end_angle) * DEG)
        return
      }
      case 'CIRCLE': {
        const c = xy(o.center)
        const r = num(o.radius, -1)
        if (!c || r <= 0) return
        w.pair(0, 'CIRCLE')
        w.pair(8, layer)
        w.pair(10, c[0])
        w.pair(20, c[1])
        w.pair(40, r)
        return
      }
      case 'LWPOLYLINE': {
        const pts = Array.isArray(o.points) ? o.points.map(xy) : []
        const good = pts.filter((p): p is [number, number] => p != null)
        if (good.length < 2) return
        const bulges = Array.isArray(o.bulges) ? o.bulges : []
        // flag bit 0 = closed
        const closed = (num(o.flag) & 1) === 1
        w.pair(0, 'LWPOLYLINE')
        w.pair(8, layer)
        w.pair(90, good.length)
        w.pair(70, closed ? 1 : 0)
        good.forEach((p, i) => {
          w.pair(10, p[0])
          w.pair(20, p[1])
          const b = num(bulges[i])
          if (b !== 0) w.pair(42, b)
        })
        return
      }
      case 'POLYLINE_2D':
      case 'POLYLINE_LWPOLYLINE':
      case 'POLYLINE': {
        // LibreDWG expands 2D polylines into owned VERTEX objects.
        const verts = (Array.isArray(o.vertex) ? (o.vertex as Handle[]) : [])
          .map(ref)
          .map((h) => (h == null ? null : byHandle.get(h)))
          .map((v) => (v ? xy(v.point) : null))
          .filter((p): p is [number, number] => p != null)
        if (verts.length < 2) return
        const closed = (num(o.flag) & 1) === 1
        w.pair(0, 'LWPOLYLINE')
        w.pair(8, layer)
        w.pair(90, verts.length)
        w.pair(70, closed ? 1 : 0)
        for (const p of verts) {
          w.pair(10, p[0])
          w.pair(20, p[1])
        }
        return
      }
      case 'INSERT': {
        const p = xy(o.ins_pt)
        const bh = ref(o.block_header)
        const name = bh != null ? blockName.get(bh) : null
        if (!p || !name) return
        const scale = Array.isArray(o.scale) ? o.scale : []
        w.pair(0, 'INSERT')
        w.pair(8, layer)
        w.pair(2, name)
        w.pair(10, p[0])
        w.pair(20, p[1])
        const sx = num(scale[0], 1) || 1
        const sy = num(scale[1], 1) || 1
        if (sx !== 1) w.pair(41, sx)
        if (sy !== 1) w.pair(42, sy)
        const rot = num(o.rotation)
        if (rot !== 0) w.pair(50, rot * DEG)
        return
      }
      case 'TEXT':
      case 'MTEXT': {
        const p = xy(o.ins_pt)
        const value = typeof o.text_value === 'string' ? o.text_value : ''
        if (!p || !value) return
        w.pair(0, 'TEXT')
        w.pair(8, layer)
        w.pair(10, p[0])
        w.pair(20, p[1])
        w.pair(40, num(o.height, 1) || 1)
        w.pair(1, value.replace(/\r?\n/g, ' '))
        return
      }
      default:
        return
    }
  }

  // --- BLOCKS ----------------------------------------------------------
  w.pair(0, 'SECTION')
  w.pair(2, 'BLOCKS')
  for (const [name, handles] of blockEntities) {
    w.pair(0, 'BLOCK')
    w.pair(8, '0')
    w.pair(2, name)
    w.pair(10, 0)
    w.pair(20, 0)
    for (const h of handles) {
      const o = byHandle.get(h)
      if (o?.entity) writeEntity(o)
    }
    w.pair(0, 'ENDBLK')
  }
  w.pair(0, 'ENDSEC')

  // --- ENTITIES --------------------------------------------------------
  w.pair(0, 'SECTION')
  w.pair(2, 'ENTITIES')
  // Prefer the model-space ownership list. Some files (the ones that crash the
  // DXF writer) have a damaged block table and list nothing — fall back to
  // every entity not claimed by a block definition, so a broken owner list
  // costs us placement, never the geometry itself.
  const claimed = new Set<number>()
  for (const handles of blockEntities.values()) for (const h of handles) claimed.add(h)
  const useOwnership = modelSpaceEntities.size > 0
  for (const o of objects) {
    if (!o.entity) continue
    const h = ref(o.handle)
    if (h == null) continue
    if (useOwnership ? !modelSpaceEntities.has(h) : claimed.has(h)) continue
    writeEntity(o)
  }
  w.pair(0, 'ENDSEC')

  w.pair(0, 'EOF')
  return w.text()
}
