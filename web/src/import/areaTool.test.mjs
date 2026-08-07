// Regression guards for the area-select TOOL (the interaction, not the filter —
// `area.test.mjs` covers `restrictDrawing`). Run from web/:
//   node src/import/areaTool.test.mjs
//
// WHY A SEPARATE HARNESS. Four shipped defects (W5a) all lived in the pointer
// state machine and none was reachable from a pure-function test:
//   1. `handleUp` treated any press that landed on a handle as a drag commit and
//      returned, so clicking the first vertex never closed the ring and the
//      second press of a double-click was swallowed — `handleDblClick`'s
//      unconditional pop then ate a REAL corner and a 4-corner lasso committed
//      as a triangle: the "diagonal chord across the plate".
//   2. a vertex drag died after ONE mousemove, because the owner's
//      `setArea(polygon)` echo nulls `areaDragVertex`; the next move fell
//      through to the PAN branch and dragged the whole plan.
//   3. with a ring committed, the armed tool accepted no canvas input at all —
//      no new ring, no vertex insert (workflow.md §3.1 specifies an edge insert).
//   4. and once (3) was fixed, the same echo erased the first vertex of the new
//      ring, reproducing the triangle from the other end.
//
// THE HARNESS ITSELF WAS THE FOURTH BUG'S ONLY WITNESS, AND IT LIED FIRST. Its
// first version dispatched a gesture's events back to back in one turn of the
// event loop. The owner's echo therefore landed only after the whole gesture,
// all guards went green, and the real browser then produced a triangle from the
// same four clicks. Every dispatch now yields the loop, because in a browser
// every event is a separate task and the echo lands BETWEEN them.
//
// INDEPENDENCE (.claude/rules/gate-independence.md). The guard never reads
// `scene.area` — the producer's own account of the ring. Ground truth is the
// list of screen points THIS FILE clicked; the measurement is the polygon the
// renderer actually strokes, recovered from the 2D-context path ops. A ring that
// is stored correctly but drawn with a chord fails here, which is the defect the
// user saw.
//
// The DOM stub registers listeners exactly as `DrawingCanvas.attach()` asks for
// them and replays the browser's real event sequence (mousedown → mousemove* →
// mouseup, and down/up/down/up/dblclick for a double-click), so the code under
// test is driven through its OWN listeners, not by calling handlers directly.
//
// @covers: web/src/import/drawingInput.ts
// @covers: web/src/import/DrawingCanvas.ts

import assert from 'node:assert/strict'
import { bundleImport, sampleDrawing } from './sampleDrawing.mjs'

// ---- DOM stub ---------------------------------------------------------------

/** Recording 2D context: every path op is appended to `ops` so a test can
 *  recover the polygons the renderer actually drew. */
function makeCtx() {
  const ops = []
  const ctx = {
    ops,
    canvas: null,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    globalAlpha: 1,
    lineCap: '',
    lineJoin: '',
    textAlign: '',
    textBaseline: '',
    imageSmoothingEnabled: true,
    save: () => ops.push(['save']),
    restore: () => ops.push(['restore']),
    beginPath: () => ops.push(['beginPath']),
    closePath: () => ops.push(['closePath']),
    moveTo: (x, y) => ops.push(['moveTo', x, y]),
    lineTo: (x, y) => ops.push(['lineTo', x, y]),
    rect: (x, y, w, h) => ops.push(['rect', x, y, w, h]),
    arc: (x, y, r) => ops.push(['arc', x, y, r]),
    fill: (rule) => ops.push(['fill', rule]),
    stroke: () => ops.push(['stroke']),
    fillRect: (x, y, w, h) => ops.push(['fillRect', x, y, w, h]),
    strokeRect: (x, y, w, h) => ops.push(['strokeRect', x, y, w, h]),
    fillText: (t, x, y) => ops.push(['fillText', t, x, y]),
    drawImage: () => ops.push(['drawImage']),
    // Not used by the area overlay, but the real sample plan's furniture
    // symbols reach for them; a missing method reads as a broken feature.
    arcTo: (...a) => ops.push(['arcTo', ...a]),
    ellipse: (...a) => ops.push(['ellipse', ...a]),
    bezierCurveTo: (...a) => ops.push(['bezierCurveTo', ...a]),
    quadraticCurveTo: (...a) => ops.push(['quadraticCurveTo', ...a]),
    roundRect: (...a) => ops.push(['roundRect', ...a]),
    clip: () => ops.push(['clip']),
    scale: (x, y) => ops.push(['scale', x, y]),
    setLineDash: (d) => ops.push(['setLineDash', (d || []).join(',')]),
    setTransform: (...a) => ops.push(['setTransform', ...a]),
    translate: (x, y) => ops.push(['translate', x, y]),
    rotate: (a) => ops.push(['rotate', a]),
    measureText: (t) => ({ width: t.length * 6 }),
  }
  return ctx
}

/** A canvas + window pair with real listener registries. */
function makeDom(w = 900, h = 700) {
  const reg = { canvas: new Map(), window: new Map() }
  const add = (m) => (type, fn) => {
    if (!m.has(type)) m.set(type, [])
    m.get(type).push(fn)
  }
  const ctx = makeCtx()
  const parent = { getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }) }
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    parentElement: parent,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    addEventListener: add(reg.canvas),
    removeEventListener: () => {},
  }
  ctx.canvas = canvas
  globalThis.window = {
    devicePixelRatio: 1,
    addEventListener: add(reg.window),
    removeEventListener: () => {},
  }
  globalThis.ResizeObserver = undefined
  const fire = (target, type, ev) => {
    for (const fn of reg[target].get(type) ?? []) fn(ev)
  }
  return { canvas, ctx, fire }
}

/** One turn of the event loop — long enough for React to flush a state update
 *  and run the `[areaPolygon]` effect that echoes the ring back. */
const flush = () => new Promise((r) => setTimeout(r, 0))

/**
 * Replays the browser's event sequences against the registered listeners.
 *
 * EVERY dispatch is awaited through a full turn of the event loop, because in a
 * browser every one of these is a separate TASK and React's echo lands BETWEEN
 * them. The first version of this driver fired a gesture's events back to back
 * in one turn; the echo therefore arrived only after the whole gesture, the
 * guards went green, and the browser then produced a triangle from the same
 * four clicks. A synchronous driver is not a model of a browser, it is a model
 * of an app with no owner.
 */
function driver(dom) {
  const ev = (x, y) => ({
    clientX: x,
    clientY: y,
    preventDefault() {},
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
  })
  const fire = async (target, type, e) => {
    dom.fire(target, type, e)
    await flush()
  }
  const down = (x, y) => fire('canvas', 'mousedown', ev(x, y))
  const move = (x, y) => fire('window', 'mousemove', ev(x, y))
  const up = (x, y) => fire('window', 'mouseup', ev(x, y))
  return {
    down,
    move,
    up,
    /** mousedown → mouseup at one point, as a plain click does. */
    async click(x, y) {
      await down(x, y)
      await up(x, y)
    },
    /** The real DOM double-click: two full click cycles, then `dblclick`.
     *  Verified against Chrome via CDP — `mousedown/up detail=1`,
     *  `mousedown/up detail=2`, then `dblclick`. */
    async dblclick(x, y) {
      await down(x, y)
      await up(x, y)
      await down(x, y)
      await up(x, y)
      await fire('canvas', 'dblclick', ev(x, y))
    },
    /** A double-click whose second press never arrives as a separate mousedown —
     *  a double TAP, and what a driver that dispatches `dblclick` directly
     *  produces. Only ONE vertex was added, so a pop that does not check for a
     *  duplicate eats a real corner. */
    async dblclickSinglePress(x, y) {
      await down(x, y)
      await up(x, y)
      await fire('canvas', 'dblclick', ev(x, y))
    },
    key(k) {
      return fire('window', 'keydown', {
        key: k,
        target: null,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        preventDefault() {},
      })
    },
  }
}

// ---- measurement: recover drawn polygons from the context ops ---------------

/**
 * Every closed sub-path the renderer stroked, as screen-point arrays. A path is
 * collected when it runs `beginPath → moveTo → lineTo* → closePath` and is later
 * `stroke`d; the even-odd dimming path is excluded because it starts with `rect`.
 */
function strokedRings(ops) {
  const rings = []
  let cur = null
  let sawRect = false
  let closed = false
  for (const op of ops) {
    switch (op[0]) {
      case 'beginPath':
        cur = []
        sawRect = false
        closed = false
        break
      case 'rect':
        sawRect = true
        break
      case 'moveTo':
      case 'lineTo':
        if (cur) cur.push([op[1], op[2]])
        break
      case 'closePath':
        closed = true
        break
      case 'stroke':
        if (cur && closed && !sawRect && cur.length >= 3) rings.push(cur)
        cur = null
        break
      case 'fill':
        if (sawRect) cur = null
        break
      default:
        break
    }
  }
  return rings
}

/** The committed area ring the renderer last stroked (screen px). */
function drawnRing(dom) {
  const rings = strokedRings(dom.ctx.ops)
  return rings.length ? rings[rings.length - 1] : null
}

/** Vertex handles the renderer painted, as screen centres (fillRect of 8×8). */
function drawnHandles(dom) {
  const out = []
  for (const op of dom.ctx.ops) {
    if (op[0] === 'fillRect' && op[3] === 8 && op[4] === 8) out.push([op[1] + 4, op[2] + 4])
  }
  return out
}

const clearOps = (dom) => {
  dom.ctx.ops.length = 0
}

/** Repaint from the CURRENT scene state and return the ring that paint drew.
 *  Measuring after a forced `refresh()` (the façade's own paint entry point)
 *  makes the reading independent of how many times a gesture happened to
 *  repaint — several defect paths here return WITHOUT painting at all. */
function repaint(dom, dc) {
  clearOps(dom)
  dc.refresh()
  return drawnRing(dom)
}

const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol
const ringNear = (ring, pts, tol = 0.01) =>
  ring != null &&
  ring.length === pts.length &&
  ring.every((p, i) => near(p[0], pts[i][0], tol) && near(p[1], pts[i][1], tol))

// ---- fixtures ---------------------------------------------------------------

/** A bare 30×20 m sheet with NO wall linework, so vertex snapping is the
 *  identity and a click lands exactly where the test put it. */
function bareDrawing() {
  return {
    entities: [],
    furniture: [],
    layers: [],
    bounds: [0, 0, 30, 20],
    units: 'm',
  }
}

/** The same sheet with one wall rectangle, for the snap assertions. */
function walledDrawing() {
  const ring = [
    [2, 2],
    [28, 2],
    [28, 18],
    [2, 18],
  ]
  const entities = []
  for (let i = 0; i < 4; i++) {
    entities.push({
      kind: 'polyline',
      category: 'wall',
      layer: 'A-WALL',
      pts: [ring[i], ring[(i + 1) % 4]],
    })
  }
  return { entities, furniture: [], layers: [{ name: 'A-WALL' }], bounds: [0, 0, 30, 20], units: 'm' }
}

const { DrawingCanvas } = await (async () => {
  makeDom() // globals must exist before the module graph runs
  return bundleImport('DrawingCanvas.ts')
})()
const { derivePlate } = await bundleImport('plate.ts')
const { restrictDrawing } = await bundleImport('area.ts')

/**
 * World→screen for the fixtures, through the ONLY public projection the façade
 * exposes (`anchorFor`, the selection-card anchor = bbox top-centre). A probe
 * item with a degenerate bbox at (wx,wy) therefore reports exactly that point.
 */
function screenOf(dc, drawing, wx, wy) {
  const probe = { name: '__probe', category: 'furniture', bbox: [wx, wy, wx, wy], pts: [] }
  drawing.furniture.push(probe)
  const a = dc.anchorFor(probe)
  drawing.furniture.pop()
  return a
}

/** A fresh canvas over `drawing`, with the owner round-trip optionally wired. */
function mount(drawing, { roundTrip = false } = {}) {
  const dom = makeDom()
  const dc = new DrawingCanvas(dom.canvas)
  const emitted = []
  dc.onAreaChange = (poly) => {
    emitted.push(poly ? poly.map((p) => [p[0], p[1]]) : null)
    // Model SpaceStep.tsx: `setAreaPolygon(poly)` → the `[areaPolygon]` effect
    // pushes it straight back with `dc.setArea(...)`. React flushes that in a
    // microtask, i.e. before the next pointer event. THIS is what killed drags.
    if (roundTrip) queueMicrotask(() => dc.setArea(poly))
  }
  dc.setDrawing(drawing)
  return { dom, dc, emitted, drawing, drv: driver(dom) }
}

// ---- the guards -------------------------------------------------------------

let failures = 0
const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push(`  ✓ ${name}`)
  } catch (e) {
    failures++
    results.push(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`)
  }
}

// The lasso the user draws in every scenario: a rectangle in screen px, four
// corners, closed on the fourth. Chosen well inside the viewport and away from
// each other so no close/handle radius (10 px / 8 px) can confuse two of them.
const CORNERS = [
  [250, 200],
  [650, 200],
  [650, 500],
  [250, 500],
]

// SYMPTOM 1 — the diagonal chord.
await test('S1 · a 4-corner lasso closed by double-click draws all 4 corners', async () => {
  const { dom, dc, drv } = mount(bareDrawing())
  dc.beginArea()
  await drv.click(...CORNERS[0])
  await drv.click(...CORNERS[1])
  await drv.click(...CORNERS[2])
  await drv.dblclick(...CORNERS[3])
  const ring = repaint(dom, dc)
  assert.ok(ring, 'no ring was stroked after the double-click')
  assert.ok(
    ringNear(ring, CORNERS),
    `rendered ring is not the drawn ring\n  drawn:    ${JSON.stringify(CORNERS)}\n  rendered: ${JSON.stringify(ring.map((p) => [Math.round(p[0]), Math.round(p[1])]))}`,
  )
})

await test('S1 · closing by clicking the first vertex keeps all 4 corners', async () => {
  const { dom, dc, drv, emitted } = mount(bareDrawing())
  dc.beginArea()
  for (const c of CORNERS) await drv.click(...c)
  await drv.click(...CORNERS[0]) // the documented "click the first point to close"
  const ring = repaint(dom, dc)
  assert.equal(emitted.length, 1, `expected exactly one commit, got ${emitted.length}`)
  assert.ok(emitted[0] && emitted[0].length === 4, `committed ${emitted[0]?.length} vertices, want 4`)
  assert.ok(ringNear(ring, CORNERS), `rendered ring: ${JSON.stringify(ring)}`)
})

await test('S1 · a double-click that delivers only one press keeps 4 corners', async () => {
  const { dom, dc, drv } = mount(bareDrawing())
  dc.beginArea()
  await drv.click(...CORNERS[0])
  await drv.click(...CORNERS[1])
  await drv.click(...CORNERS[2])
  await drv.dblclickSinglePress(...CORNERS[3])
  assert.ok(
    ringNear(repaint(dom, dc), CORNERS),
    'the closing pop removed a REAL corner, not a duplicate',
  )
})

await test('S1 · Enter closes without dropping a vertex', async () => {
  const { dom, dc, drv } = mount(bareDrawing())
  dc.beginArea()
  for (const c of CORNERS) await drv.click(...c)
  await drv.key('Enter')
  assert.ok(ringNear(repaint(dom, dc), CORNERS))
})

// SYMPTOM 2 — handles will not drag.
await test('S2 · a vertex drag survives the owner setArea round-trip', async () => {
  const { dom, dc, drv } = mount(bareDrawing(), { roundTrip: true })
  dc.beginArea()
  for (const c of CORNERS) await drv.click(...c)
  await drv.key('Enter')
  await flush()
  dc.beginArea() // "Edit area" re-arms the committed ring
  const target = [CORNERS[0][0] + 60, CORNERS[0][1] + 40]
  await drv.down(...CORNERS[0])
  await drv.move(CORNERS[0][0] + 20, CORNERS[0][1] + 14)
  await flush() // React pushes the edited ring back in a microtask
  await drv.move(...target)
  await flush()
  await drv.up(...target)
  const ring = repaint(dom, dc)
  assert.ok(ring, 'no ring stroked after the drag')
  assert.ok(
    ringNear(ring, [target, CORNERS[1], CORNERS[2], CORNERS[3]], 0.5),
    `vertex 0 did not follow the cursor to ${JSON.stringify(target)}\n  rendered: ${JSON.stringify(ring.map((p) => [Math.round(p[0]), Math.round(p[1])]))}`,
  )
})

await test('S2 · dragging a vertex never pans the view', async () => {
  const { dom, dc, drv } = mount(bareDrawing(), { roundTrip: true })
  dc.beginArea()
  for (const c of CORNERS) await drv.click(...c)
  await drv.key('Enter')
  await flush()
  dc.beginArea()
  await drv.down(...CORNERS[0])
  for (let i = 1; i <= 6; i++) {
    await drv.move(CORNERS[0][0] + i * 10, CORNERS[0][1] + i * 6)
    await flush()
  }
  await drv.up(CORNERS[0][0] + 60, CORNERS[0][1] + 36)
  const ring = repaint(dom, dc)
  // The three vertices NOT under the cursor must be pixel-identical: if the
  // canvas panned instead of dragging, every one of them moves.
  assert.ok(ring, 'no ring stroked')
  for (let i = 1; i < 4; i++) {
    assert.ok(
      near(ring[i][0], CORNERS[i][0], 0.5) && near(ring[i][1], CORNERS[i][1], 0.5),
      `vertex ${i} moved to ${JSON.stringify(ring[i])} — the view panned during the drag`,
    )
  }
})

await test('S2 · a dragged vertex snaps onto imported wall linework', async () => {
  const { dom, dc, drv, drawing } = mount(walledDrawing(), { roundTrip: true })
  dc.beginArea()
  for (const c of CORNERS) await drv.click(...c)
  await drv.key('Enter')
  await flush()
  dc.beginArea()
  // The wall corner (2,2) in screen px; release 6 px off it — inside SNAP_PX.
  const { x: cx, y: cy } = screenOf(dc, drawing, 2, 2)
  await drv.down(...CORNERS[3])
  await drv.move(cx + 6, cy - 5)
  await flush()
  await drv.up(cx + 6, cy - 5)
  const ring = repaint(dom, dc)
  assert.ok(ring, 'no ring stroked')
  assert.ok(
    near(ring[3][0], cx, 0.5) && near(ring[3][1], cy, 0.5),
    `vertex 3 landed at ${JSON.stringify(ring[3].map(Math.round))}, want the wall corner ${[Math.round(cx), Math.round(cy)]}`,
  )
})

// SYMPTOM 3 — no second selection.
await test('S3 · with a ring committed, clicking outside it starts a new ring', async () => {
  const { dom, dc, drv, emitted } = mount(bareDrawing(), { roundTrip: true })
  dc.beginArea()
  for (const c of CORNERS) await drv.click(...c)
  await drv.key('Enter')
  await flush()
  emitted.length = 0
  dc.beginArea()
  const SECOND = [
    [700, 550],
    [850, 550],
    [850, 640],
    [700, 640],
  ]
  await drv.click(...SECOND[0]) // outside the committed ring → start over
  await drv.click(...SECOND[1])
  await drv.click(...SECOND[2])
  await drv.dblclick(...SECOND[3])
  await flush()
  const ring = repaint(dom, dc)
  assert.ok(
    ringNear(ring, SECOND),
    `second selection not drawn\n  want: ${JSON.stringify(SECOND)}\n  got:  ${JSON.stringify(ring && ring.map((p) => [Math.round(p[0]), Math.round(p[1])]))}`,
  )
  assert.ok(
    emitted.length > 0 && emitted[emitted.length - 1].length === 4,
    'the new ring was never committed to the owner',
  )
})

await test('S3 · clicking a committed edge inserts a vertex there (workflow.md §3.1)', async () => {
  const { dom, dc, drv } = mount(bareDrawing(), { roundTrip: true })
  dc.beginArea()
  for (const c of CORNERS) await drv.click(...c)
  await drv.key('Enter')
  await flush()
  dc.beginArea()
  const mid = [(CORNERS[0][0] + CORNERS[1][0]) / 2, CORNERS[0][1]]
  await drv.click(...mid)
  await flush()
  const ring = repaint(dom, dc)
  assert.ok(
    ringNear(ring, [CORNERS[0], mid, CORNERS[1], CORNERS[2], CORNERS[3]]),
    `edge click did not insert a vertex\n  got: ${JSON.stringify(ring && ring.map((p) => [Math.round(p[0]), Math.round(p[1])]))}`,
  )
  assert.equal(drawnHandles(dom).length, 5, 'handles do not match the 5-vertex ring')
})

await test('S3 · clicking inside a committed ring is inert (no accidental redraw)', async () => {
  const { dom, dc, drv, emitted } = mount(bareDrawing(), { roundTrip: true })
  dc.beginArea()
  for (const c of CORNERS) await drv.click(...c)
  await drv.key('Enter')
  await flush()
  emitted.length = 0
  dc.beginArea()
  await drv.click(450, 350) // dead centre of the ring, far from every edge
  await flush()
  assert.ok(ringNear(repaint(dom, dc), CORNERS), 'an interior click disturbed the committed ring')
  assert.equal(emitted.length, 0, 'an interior click emitted a change')
})

// ---- E2E · the drawn ring all the way to the floor plate --------------------
// `derivePlate`'s area branch is what turns the gesture into the plate the
// generator builds in, and it had never been exercised from a real import. The
// lasso here is DRAWN with the pointer driver on the parsed sample plan, so the
// polygon under test is the one the tool actually produces (snapping included),
// not a hand-written rectangle.

await test('E2E · a drawn lasso on the real import becomes the plate, not a hull', async () => {
  const drawing = await sampleDrawing()
  const [bx0, by0, bx1, by1] = drawing.bounds
  const { dom, dc, drv, emitted } = mount(drawing)
  // A sub-area well inside the sheet: the left-middle 30% × 40% of the plan, so
  // the bbox clip in `plateFromArea` is a no-op and the expected area is just
  // the shoelace of the ring.
  const lx = (f) => bx0 + (bx1 - bx0) * f
  const ly = (f) => by0 + (by1 - by0) * f
  const world = [
    [lx(0.12), ly(0.25)],
    [lx(0.42), ly(0.25)],
    [lx(0.42), ly(0.65)],
    [lx(0.12), ly(0.65)],
  ]
  dc.beginArea()
  for (const [wx, wy] of world) {
    const p = screenOf(dc, drawing, wx, wy)
    await drv.click(p.x, p.y)
  }
  await drv.key('Enter')
  const ring = emitted[emitted.length - 1]
  assert.ok(ring && ring.length === 4, `the tool emitted ${ring?.length} vertices`)
  assert.ok(repaint(dom, dc), 'the committed ring was not drawn')

  // Independent expectation: the shoelace area of the ring the tool emitted.
  let shoelace = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    shoelace += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1])
  }
  const expected = Math.abs(shoelace / 2)
  assert.ok(expected > 50, `the drawn sub-area is only ${expected.toFixed(1)} m² — fixture drifted`)

  const plate = derivePlate(drawing, ring, true)
  assert.ok(plate, 'derivePlate returned null for a valid area selection')
  assert.ok(
    Math.abs(plate.areaM2 - expected) < 1e-6,
    `plate area ${plate.areaM2.toFixed(2)} m² != the drawn ring's ${expected.toFixed(2)} m²`,
  )
  // The plate IS the lasso: same vertices, once the editor offset is undone.
  const src = plate.boundary.map(([x, y]) => [x + plate.offset.x, y + plate.offset.y])
  assert.ok(
    ringNear(src, ring, 1e-6),
    `plate boundary is not the drawn ring\n  ring:  ${JSON.stringify(ring)}\n  plate: ${JSON.stringify(src)}`,
  )
  assert.equal(plate.provenance?.method, 'user-traced', 'a drawn boundary must be user-traced')
  assert.equal(plate.provenance?.confidence, 'high', 'a drawn boundary is trusted')

  // …and it really restricts: strictly fewer items, all of them inside the ring.
  const kept = restrictDrawing(drawing, ring).furniture
  assert.ok(
    kept.length > 0 && kept.length < drawing.furniture.length,
    `restriction kept ${kept.length} of ${drawing.furniture.length} items`,
  )
  const [rx0, ry0, rx1, ry1] = [
    Math.min(...ring.map((p) => p[0])),
    Math.min(...ring.map((p) => p[1])),
    Math.max(...ring.map((p) => p[0])),
    Math.max(...ring.map((p) => p[1])),
  ]
  for (const f of kept) {
    const cx = (f.bbox[0] + f.bbox[2]) / 2
    const cy = (f.bbox[1] + f.bbox[3]) / 2
    assert.ok(
      cx >= rx0 && cx <= rx1 && cy >= ry0 && cy <= ry1,
      `kept an item centred at ${cx.toFixed(2)},${cy.toFixed(2)} outside the selection`,
    )
  }
})

await test('E2E · a degenerate lasso is never certified as a traced boundary', async () => {
  const drawing = await sampleDrawing()
  const [bx0, by0] = drawing.bounds
  const tiny = [
    [bx0 + 1, by0 + 1],
    [bx0 + 2, by0 + 1],
    [bx0 + 2, by0 + 2],
    [bx0 + 1, by0 + 2],
  ] // 1 m², under plateFromArea's 4 m² floor
  const plate = derivePlate(drawing, tiny, true)
  // MEASURED, not assumed: `plate.ts` promised a hull-tracer fallback here, and
  // there is none — the fallback traces the RESTRICTED drawing, which a
  // degenerate selection has already emptied, so the result is null. The comment
  // has been corrected to say so; this pins the behaviour either way. What must
  // never happen is a 1 m² stray being handed on as a trusted, user-traced plate.
  assert.ok(
    plate === null || plate.provenance?.method !== 'user-traced',
    'a degenerate selection was certified as a user-traced boundary',
  )
})

process.stdout.write(results.join('\n') + '\n')
if (failures) {
  process.stdout.write(`areaTool: ${failures} failing\n`)
  process.exit(1)
}
process.stdout.write(`areaTool: ${results.length} checks, all green\n`)
