// Pointer + keyboard dispatch for the imported-drawing canvas, and the tool
// state machines they drive: placement, area-select (workflow.md §3.1), room
// markers (§3.2), anchor pins (§3.5) and raster scale calibration.
//
// Each handler is the exact body of the former `DrawingCanvas.onX` arrow field,
// re-expressed over a {@link DrawingScene}. `DrawingCanvas` still owns the
// listener registration/teardown, so DOM lifetime stays in one place.

import type { FurnitureItem } from './types'
import type { Pt } from './testfit'
import { renderScene } from './drawingRender'
import {
  deleteSelected,
  duplicateSelected,
  emitChange,
  placeAt,
  pushUndo,
  rotateSelected,
  translateItem,
  undoEdit,
} from './drawingEdit'
import {
  AREA_CLOSE_PX,
  AREA_VERTEX_PX,
  DRAG_THRESHOLD,
  MAX_SCALE,
  MIN_SCALE,
  ROTATE_STEP,
  SNAP_PX,
  clamp,
  screenFromEvent,
  snapPlace,
  toScreen,
  toWorld,
  withinCanvas,
  type DrawingScene,
} from './drawingScene'

// ---- hit-testing + adaptive snapping ----

/** Topmost furniture item (by draw order) whose bbox contains the screen point. */
function pickFurniture(s: DrawingScene, sx: number, sy: number): FurnitureItem | null {
  const d = s.drawing
  if (!d) return null
  const w = toWorld(s, sx, sy)
  for (let i = d.furniture.length - 1; i >= 0; i--) {
    const it = d.furniture[i]
    const [minX, minY, maxX, maxY] = it.bbox
    if (w.x >= minX && w.x <= maxX && w.y >= minY && w.y <= maxY) return it
  }
  return null
}

/** Snap a screen point to the nearest wall endpoint (priority) or wall-line
 *  projection within `SNAP_PX`, giving the area tool its "adaptive" feel.
 *  Returns the world point + whether it snapped to a feature. */
function snapWorld(s: DrawingScene, sx: number, sy: number): { p: Pt; snapped: boolean } {
  const w = toWorld(s, sx, sy)
  const tol = SNAP_PX / s.scale // px → world meters
  let best: Pt | null = null
  let bestD = tol
  for (const [ex, ey] of s.snapPoints) {
    const d = Math.hypot(ex - w.x, ey - w.y)
    if (d < bestD) {
      bestD = d
      best = [ex, ey]
    }
  }
  if (best) return { p: best, snapped: true }
  // Fall back to the closest point on any wall segment.
  let projD = tol
  let proj: Pt | null = null
  for (const [a, b] of s.snapSegs) {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len2 = dx * dx + dy * dy
    const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((w.x - a[0]) * dx + (w.y - a[1]) * dy) / len2))
    const px = a[0] + t * dx
    const py = a[1] + t * dy
    const d = Math.hypot(px - w.x, py - w.y)
    if (d < projD) {
      projD = d
      proj = [px, py]
    }
  }
  if (proj) return { p: proj, snapped: true }
  return { p: [w.x, w.y], snapped: false }
}

/** Index of the area vertex whose handle is under (sx,sy), or null. */
function hitAreaVertex(s: DrawingScene, sx: number, sy: number): number | null {
  for (let i = 0; i < s.area.length; i++) {
    const p = toScreen(s, s.area[i][0], s.area[i][1])
    if (Math.hypot(p.x - sx, p.y - sy) <= AREA_VERTEX_PX + 4) return i
  }
  return null
}

/** True when (sx,sy) is within closing distance of the first vertex. */
function nearFirstVertex(s: DrawingScene, sx: number, sy: number): boolean {
  if (s.area.length < 3) return false
  const p = toScreen(s, s.area[0][0], s.area[0][1])
  return Math.hypot(p.x - sx, p.y - sy) <= AREA_CLOSE_PX
}

// ---- area tool ----

/** Notify the owner of the committed ring (or null while not yet closed). */
function emitArea(s: DrawingScene): void {
  const closed = s.areaClosed && s.area.length >= 3
  s.ev.onAreaChange?.(closed ? s.area.map((p): Pt => [p[0], p[1]]) : null)
}

/** Close the in-progress ring: commit it, disarm the tool (so the committed
 *  polygon renders without edit handles), and notify. Re-editing is a fresh
 *  beginArea() away — it keeps the committed ring and re-arms the handles. */
function closeArea(s: DrawingScene): void {
  s.areaClosed = true
  s.areaTool = false
  s.areaDragVertex = null
  s.toolCursor = null
  s.canvas.style.cursor = 'default'
  renderScene(s)
  emitArea(s)
}

/** Esc while the area tool is armed: cancel an in-progress ring (clear +
 *  disarm), or just disarm when a ring is already committed. */
function escapeArea(s: DrawingScene): void {
  if (!s.areaClosed) s.area = []
  s.areaTool = false
  s.areaDragVertex = null
  s.toolCursor = null
  s.canvas.style.cursor = 'default'
  renderScene(s)
}

// ---- tool arming ----

/** Exit placement mode without placing (Escape does the same). */
export function cancelPlace(s: DrawingScene): void {
  if (!s.placing) return
  s.placing = null
  s.placeCursor = null
  s.canvas.style.cursor = 'default'
  renderScene(s)
}

/** Disarm the area, marker, anchor and scale tools (keeps committed pins/polygon). */
export function cancelTool(s: DrawingScene): void {
  s.areaTool = false
  s.markerArm = null
  s.anchorArm = null
  s.areaDragVertex = null
  s.scaleTool = false
  s.scaleFirst = null
  s.toolCursor = null
  s.canvas.style.cursor = 'default'
  renderScene(s)
}

/** Shared prologue for arming any of the click-to-drop tools: disarm the
 *  others and drop the current selection. Callers set their own armed state. */
export function disarmForTool(s: DrawingScene): void {
  cancelPlace(s)
  s.areaTool = false
  s.markerArm = null
  s.anchorArm = null
  s.scaleTool = false
  s.scaleFirst = null
  s.areaDragVertex = null
  s.toolCursor = null
}

/** Clear the selection and notify, if anything is selected. */
export function dropSelection(s: DrawingScene): void {
  if (s.selected) {
    s.selected = null
    s.ev.onSelect?.(null)
  }
}

// ---- pointer ----

export function handleDown(s: DrawingScene, e: MouseEvent): void {
  const p = screenFromEvent(s, e)
  s.pointerDown = true
  s.didPan = false
  s.movingActive = false
  s.lastScreen = p
  s.downScreen = p
  // Placement mode: never arm a move — a drag pans, a plain click stamps
  // (handled in handleUp so panning still works while placing).
  if (s.placing) {
    s.moveCandidate = null
    return
  }
  // Area tool: grabbing a vertex handle arms a drag; empty space stays a pan
  // (a plain click adds a vertex in handleUp).
  if (s.areaTool) {
    s.areaDragVertex = hitAreaVertex(s, p.x, p.y)
    s.moveCandidate = null
    return
  }
  // Marker/anchor tool: a plain click drops a pin (in handleUp so panning works).
  if (s.markerArm || s.anchorArm) {
    s.moveCandidate = null
    return
  }
  // Scale tool: clicks place the reference-line endpoints (in handleUp so a drag
  // still pans the backdrop while positioning).
  if (s.scaleTool) {
    s.moveCandidate = null
    return
  }
  // Hitting a furniture item selects it and arms a MOVE (started once we drag
  // past the threshold). Empty space stays a pan.
  const hit = pickFurniture(s, p.x, p.y)
  s.moveCandidate = hit
  if (hit) {
    if (s.selected !== hit) {
      s.selected = hit
      s.ev.onSelect?.(hit)
    }
    s.lastWorld = toWorld(s, p.x, p.y)
    renderScene(s)
  }
}

export function handleMove(s: DrawingScene, e: MouseEvent): void {
  const p = screenFromEvent(s, e)
  if (s.pointerDown) {
    // Area vertex drag: snap-follow the cursor, live-update the ring.
    if (s.areaTool && s.areaDragVertex != null) {
      const { p: snapped } = snapWorld(s, p.x, p.y)
      s.area[s.areaDragVertex] = snapped
      s.lastScreen = p
      renderScene(s)
      if (s.areaClosed) emitArea(s)
      return
    }
    if (
      !s.didPan &&
      !s.movingActive &&
      Math.hypot(p.x - s.downScreen.x, p.y - s.downScreen.y) > DRAG_THRESHOLD
    ) {
      if (s.moveCandidate) {
        s.movingActive = true
        pushUndo(s)
        s.canvas.style.cursor = 'grabbing'
      } else {
        s.didPan = true
      }
    }
    if (s.movingActive && s.moveCandidate) {
      const w = toWorld(s, p.x, p.y)
      translateItem(s.moveCandidate, w.x - s.lastWorld.x, w.y - s.lastWorld.y)
      s.lastWorld = w
      renderScene(s)
    } else if (s.didPan) {
      s.offset.x += p.x - s.lastScreen.x
      s.offset.y += p.y - s.lastScreen.y
      s.fitted = false // user took manual control — stop auto-fit on resize
      renderScene(s)
    }
    s.lastScreen = p
    return
  }
  // Placement mode: the ghost tracks the (snapped) cursor; no hover picking.
  if (s.placing) {
    const within = withinCanvas(s, p.x, p.y)
    const w = toWorld(s, p.x, p.y)
    s.placeCursor = within ? { x: snapPlace(w.x), y: snapPlace(w.y) } : null
    s.canvas.style.cursor = 'crosshair'
    renderScene(s)
    return
  }
  const within = withinCanvas(s, p.x, p.y)
  // Area tool: the next-vertex preview snaps to wall features; hovering a
  // vertex handle shows a grab cursor.
  if (s.areaTool) {
    if (within) {
      const { p: sp, snapped } = snapWorld(s, p.x, p.y)
      s.toolCursor = sp
      s.toolSnapped = snapped
    } else {
      s.toolCursor = null
    }
    s.canvas.style.cursor = hitAreaVertex(s, p.x, p.y) != null ? 'grab' : 'crosshair'
    renderScene(s)
    return
  }
  // Marker/anchor tool: a pin ghost tracks the cursor (not wall-snapped).
  if (s.markerArm || s.anchorArm) {
    const w = toWorld(s, p.x, p.y)
    s.toolCursor = within ? [w.x, w.y] : null
    s.canvas.style.cursor = 'crosshair'
    renderScene(s)
    return
  }
  // Scale tool: the reference line rubber-bands from its first point.
  if (s.scaleTool) {
    const w = toWorld(s, p.x, p.y)
    s.toolCursor = within ? [w.x, w.y] : null
    s.canvas.style.cursor = 'crosshair'
    renderScene(s)
    return
  }
  // Hover hit-test only when not dragging.
  const hit = within ? pickFurniture(s, p.x, p.y) : null
  s.canvas.style.cursor = hit ? 'move' : 'default'
  if (hit !== s.hovered) {
    s.hovered = hit
    s.ev.onHover?.(hit)
    renderScene(s)
  }
}

export function handleUp(s: DrawingScene, e: MouseEvent): void {
  if (!s.pointerDown) return
  s.pointerDown = false
  const wasPan = s.didPan
  const wasMoving = s.movingActive
  s.movingActive = false
  s.moveCandidate = null
  s.canvas.style.cursor = 'default'
  if (wasMoving) {
    emitChange(s) // a drag-move committed
    return
  }
  // Area vertex drag committed (a click on a handle that didn't pan).
  if (s.areaTool && s.areaDragVertex != null) {
    s.areaDragVertex = null
    if (s.areaClosed) emitArea(s)
    renderScene(s)
    return
  }
  if (wasPan) return // was a pan, not a click
  // Area tool: add a vertex, or close the ring by clicking the first vertex.
  if (s.areaTool) {
    const p = screenFromEvent(s, e)
    if (!s.areaClosed && nearFirstVertex(s, p.x, p.y)) {
      closeArea(s)
      return
    }
    if (!s.areaClosed) {
      const { p: vertex } = snapWorld(s, p.x, p.y)
      s.area.push(vertex)
      renderScene(s)
    }
    return
  }
  // Marker tool: drop a pin at the click point; the owner assigns id/ref.
  if (s.markerArm) {
    const p = screenFromEvent(s, e)
    const w = toWorld(s, p.x, p.y)
    s.ev.onMarkerDrop?.(w.x, w.y)
    return
  }
  // Anchor tool: drop a pin at the click point; the owner assigns id/kind.
  if (s.anchorArm) {
    const p = screenFromEvent(s, e)
    const w = toWorld(s, p.x, p.y)
    s.ev.onAnchorDrop?.(w.x, w.y)
    return
  }
  // Scale tool: first click sets the reference line's start, second click
  // completes it — measure its world length + let the owner enter the real one.
  if (s.scaleTool) {
    const p = screenFromEvent(s, e)
    const w = toWorld(s, p.x, p.y)
    if (!s.scaleFirst) {
      s.scaleFirst = [w.x, w.y]
      s.scaleLine = null
      renderScene(s)
    } else {
      s.scaleLine = [s.scaleFirst, [w.x, w.y]]
      s.scaleFirst = null
      s.scaleTool = false // line is placed; owner now asks for its length
      s.canvas.style.cursor = 'default'
      renderScene(s)
      const len = Math.hypot(
        s.scaleLine[1][0] - s.scaleLine[0][0],
        s.scaleLine[1][1] - s.scaleLine[0][1],
      )
      s.ev.onScaleReady?.(len)
    }
    return
  }
  // Placement mode: a plain click stamps the armed spec at the snapped point.
  if (s.placing) {
    const p = screenFromEvent(s, e)
    const w = toWorld(s, p.x, p.y)
    placeAt(s, snapPlace(w.x), snapPlace(w.y))
    return
  }
  // Plain click: (de)select the item under the cursor.
  const p = screenFromEvent(s, e)
  const hit = pickFurniture(s, p.x, p.y)
  if (hit !== s.selected) {
    s.selected = hit
    s.ev.onSelect?.(hit)
  }
  renderScene(s)
}

export function handleLeave(s: DrawingScene): void {
  if (s.placing && s.placeCursor) {
    s.placeCursor = null
    renderScene(s)
  }
  if ((s.areaTool || s.markerArm || s.scaleTool) && s.toolCursor) {
    s.toolCursor = null
    renderScene(s)
  }
  if (s.hovered) {
    s.hovered = null
    s.ev.onHover?.(null)
    renderScene(s)
  }
}

/** Double-click closes the in-progress area ring (dropping the redundant
 *  vertex the two constituent clicks added). */
export function handleDblClick(s: DrawingScene, e: MouseEvent): void {
  if (!s.areaTool || s.areaClosed) return
  e.preventDefault()
  if (s.area.length > 3) s.area.pop() // the dblclick's second click
  if (s.area.length >= 3) closeArea(s)
  else renderScene(s)
}

export function handleWheel(s: DrawingScene, e: WheelEvent): void {
  e.preventDefault()
  const p = screenFromEvent(s, e)
  const before = toWorld(s, p.x, p.y)
  const factor = Math.exp(-e.deltaY * 0.0015)
  s.scale = clamp(s.scale * factor, MIN_SCALE, MAX_SCALE)
  // Keep the world point under the cursor fixed (Y flipped).
  s.offset.x = p.x - before.x * s.scale
  s.offset.y = p.y + before.y * s.scale
  s.fitted = false // user zoomed — stop auto-fit on resize
  renderScene(s)
}

// ---- keyboard: tools, then rotate / delete / duplicate / undo ----

export function handleKey(s: DrawingScene, e: KeyboardEvent): void {
  if (!s.drawing) return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  const mod = e.metaKey || e.ctrlKey
  const key = e.key.toLowerCase()
  // Area tool: Enter/Escape close/cancel the ring, Backspace drops the last
  // vertex. Handled before the furniture shortcuts so they don't clash.
  if (s.areaTool && !mod) {
    if (key === 'escape') {
      e.preventDefault()
      escapeArea(s)
      return
    }
    if (key === 'enter') {
      e.preventDefault()
      if (!s.areaClosed && s.area.length >= 3) closeArea(s)
      return
    }
    if ((key === 'backspace' || key === 'delete') && !s.areaClosed && s.area.length > 0) {
      e.preventDefault()
      s.area.pop()
      renderScene(s)
      return
    }
  }
  if ((s.markerArm || s.anchorArm) && !mod && key === 'escape') {
    e.preventDefault()
    cancelTool(s)
    return
  }
  // Scale tool: Escape cancels the reference line (drops any first point).
  if (s.scaleTool && !mod && key === 'escape') {
    e.preventDefault()
    cancelTool(s)
    return
  }
  // Placement mode: Escape exits, R spins the ghost (Shift+R reverses —
  // the same convention as rotating a selected item). ⌘Z etc. fall through.
  if (s.placing && !mod) {
    if (key === 'escape') {
      e.preventDefault()
      cancelPlace(s)
      return
    }
    if (key === 'r') {
      e.preventDefault()
      s.placeRotation += e.shiftKey ? -ROTATE_STEP : ROTATE_STEP
      renderScene(s)
      return
    }
  }
  if (mod && key === 'z') {
    e.preventDefault()
    undoEdit(s)
    return
  }
  if (mod && key === 'd') {
    e.preventDefault()
    duplicateSelected(s)
    return
  }
  if (mod) return // leave other browser shortcuts alone
  if (!s.selected) return
  if (key === 'r') {
    e.preventDefault()
    rotateSelected(s, e.shiftKey ? -ROTATE_STEP : ROTATE_STEP)
  } else if (key === 'delete' || key === 'backspace') {
    e.preventDefault()
    deleteSelected(s)
  }
}
