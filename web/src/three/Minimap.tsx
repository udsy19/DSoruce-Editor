import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type { Pose } from './Viewer3D'
import { MONO } from '../ui/type'

/**
 * Live top-down minimap for the first-person walkthrough. A small translucent
 * overlay (shown only in walk mode) that keeps the user oriented in the plan —
 * like a game / Revit walkthrough minimap.
 *
 * ── Coordinate model ──────────────────────────────────────────────────────
 * Everything the minimap receives is already in the viewer's (recentered)
 * WORLD space: plan world **X → horizontal**, world **Z → vertical** (plan-Y,
 * which points DOWN on screen, matching the 2D editor's top-down convention).
 * The geometry background (`segments`, `points`) and the live {@link Pose} all
 * share that space, so a single fit transform maps them together.
 *
 * ── Rendering strategy (60fps-safe) ───────────────────────────────────────
 * The static plan background is rasterized ONCE to an offscreen canvas whenever
 * the geometry props change. Each walk frame the parent calls the imperative
 * `setPose` handle, which blits the cached background and draws only the player
 * marker + view cone — no React re-render per frame.
 */

export interface MinimapBounds {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

export interface MinimapProps {
  /** Wall segments in world space: [x1, z1, x2, z2]. */
  segments: [number, number, number, number][]
  /** Furniture dots in world space: [x, z]. */
  points: [number, number][]
  /** Plan extent in world space (fit target). */
  bounds: MinimapBounds
  /** Click-to-teleport: called with the world (x, z) of a click on the map. */
  onPick?: (x: number, z: number) => void
}

/** Imperative handle so the parent can push a pose every frame without a
 *  React re-render. */
export interface MinimapHandle {
  setPose(pose: Pose): void
}

const SIZE = 170 // CSS px of the (square) map box
const PAD = 12 // inner letterbox padding, world geometry never touches the edge
const ACCENT = '#E8A13C'
const WALL_LINE = 'rgba(92, 98, 108, 0.85)' // cool gray
const DOT = 'rgba(92, 98, 108, 0.35)' // faint furniture dots

/** Fit transform from world (x, z) → canvas pixels (device space), preserving
 *  aspect ratio and letterboxing within the padded box. */
interface Fit {
  scale: number
  ox: number
  oy: number
  minX: number
  minZ: number
}

function computeFit(bounds: MinimapBounds, dim: number, dpr: number): Fit {
  const worldW = Math.max(bounds.maxX - bounds.minX, 1e-3)
  const worldH = Math.max(bounds.maxZ - bounds.minZ, 1e-3)
  const pad = PAD * dpr
  const avail = dim - 2 * pad
  const scale = Math.min(avail / worldW, avail / worldH)
  const ox = (dim - worldW * scale) / 2
  const oy = (dim - worldH * scale) / 2
  return { scale, ox, oy, minX: bounds.minX, minZ: bounds.minZ }
}

const toX = (f: Fit, x: number) => f.ox + (x - f.minX) * f.scale
const toY = (f: Fit, z: number) => f.oy + (z - f.minZ) * f.scale

export const Minimap = forwardRef<MinimapHandle, MinimapProps>(function Minimap(
  { segments, points, bounds, onPick },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Cached static background (plan geometry) + the fit used to draw it.
  const bgRef = useRef<HTMLCanvasElement | null>(null)
  const fitRef = useRef<Fit | null>(null)

  // Rasterize the static plan background whenever geometry or size changes.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const dim = SIZE * dpr
    canvas.width = dim
    canvas.height = dim

    const fit = computeFit(bounds, dim, dpr)
    fitRef.current = fit

    const bg = bgRef.current ?? document.createElement('canvas')
    bg.width = dim
    bg.height = dim
    bgRef.current = bg
    const g = bg.getContext('2d')
    if (!g) return
    g.clearRect(0, 0, dim, dim)

    // Furniture dots (faint).
    g.fillStyle = DOT
    const r = Math.max(1.1 * dpr, 1)
    for (const [x, z] of points) {
      g.beginPath()
      g.arc(toX(fit, x), toY(fit, z), r, 0, Math.PI * 2)
      g.fill()
    }

    // Wall segments (thin cool-gray lines).
    g.strokeStyle = WALL_LINE
    g.lineWidth = Math.max(1 * dpr, 1)
    g.lineCap = 'round'
    g.beginPath()
    for (const [x1, z1, x2, z2] of segments) {
      g.moveTo(toX(fit, x1), toY(fit, z1))
      g.lineTo(toX(fit, x2), toY(fit, z2))
    }
    g.stroke()

    // Paint the initial frame (background only, no pose yet).
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.clearRect(0, 0, dim, dim)
      ctx.drawImage(bg, 0, 0)
    }
  }, [segments, points, bounds])

  useImperativeHandle(
    ref,
    () => ({
      setPose(pose: Pose) {
        const canvas = canvasRef.current
        const bg = bgRef.current
        const fit = fitRef.current
        if (!canvas || !bg || !fit) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const dim = canvas.width

        // Clear + blit cached plan, then draw the live marker on top.
        ctx.clearRect(0, 0, dim, dim)
        ctx.drawImage(bg, 0, 0)

        const px = toX(fit, pose.x)
        const py = toY(fit, pose.z)
        // Heading direction survives the fit unchanged (uniform scale).
        let hx = pose.hx
        let hy = pose.hz
        const len = Math.hypot(hx, hy) || 1
        hx /= len
        hy /= len

        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        // View cone: a translucent wedge along the heading.
        const cone = 22 * dpr
        const half = 0.5 // ~28° half-angle
        const lx = hx * Math.cos(half) - hy * Math.sin(half)
        const ly = hx * Math.sin(half) + hy * Math.cos(half)
        const rx = hx * Math.cos(-half) - hy * Math.sin(-half)
        const ry = hx * Math.sin(-half) + hy * Math.cos(-half)
        const grad = ctx.createRadialGradient(px, py, 0, px, py, cone)
        grad.addColorStop(0, 'rgba(232, 161, 60, 0.45)')
        grad.addColorStop(1, 'rgba(232, 161, 60, 0)')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.moveTo(px, py)
        ctx.lineTo(px + lx * cone, py + ly * cone)
        ctx.lineTo(px + rx * cone, py + ry * cone)
        ctx.closePath()
        ctx.fill()

        // Player dot (amber).
        ctx.fillStyle = ACCENT
        ctx.beginPath()
        ctx.arc(px, py, 3.2 * dpr, 0, Math.PI * 2)
        ctx.fill()
        ctx.lineWidth = 1.2 * dpr
        ctx.strokeStyle = 'rgba(24, 26, 30, 0.6)'
        ctx.stroke()
      },
    }),
    [],
  )

  // Click-to-teleport: invert the fit (device px → world). The canvas is SIZE
  // CSS px wide but `fit` works in device px, so scale the CSS offset by dpr.
  const handleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const fit = fitRef.current
    if (!onPick || !fit) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const dx = e.nativeEvent.offsetX * dpr
    const dy = e.nativeEvent.offsetY * dpr
    const worldX = fit.minX + (dx - fit.ox) / fit.scale
    const worldZ = fit.minZ + (dy - fit.oy) / fit.scale
    onPick(worldX, worldZ)
  }

  const boxStyle: CSSProperties = {
    position: 'absolute',
    left: 12,
    bottom: 12,
    width: SIZE,
    height: SIZE,
    borderRadius: 12,
    border: '1px solid rgba(0,0,0,0.08)',
    background: 'rgba(243, 241, 236, 0.72)',
    boxShadow: '0 2px 10px rgba(0,0,0,0.16)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: 2,
  }

  return (
    <div style={boxStyle}>
      <canvas
        ref={canvasRef}
        onClick={onPick ? handleClick : undefined}
        style={{
          width: SIZE,
          height: SIZE,
          display: 'block',
          // Re-enable pointer events on the canvas (the box disables them) so
          // clicks land, and hint teleport with a crosshair.
          pointerEvents: onPick ? 'auto' : 'none',
          cursor: onPick ? 'crosshair' : 'default',
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 6,
          left: 8,
          font: `500 9px/1 ${MONO}`,
          letterSpacing: '0.08em',
          color: '#5c626c',
          pointerEvents: 'none',
        }}
      >
        {onPick ? 'CLICK TO MOVE' : 'YOU ARE HERE'}
      </div>
    </div>
  )
})
