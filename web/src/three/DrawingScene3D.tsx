import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Viewer3D, type ViewerMode } from './Viewer3D'
import { Minimap, type MinimapHandle, type MinimapProps } from './Minimap'
import { buildFromDrawing } from './buildFromDrawing'
import type { Drawing } from '../import/types'

/**
 * React wrapper that renders an imported CAD {@link Drawing} as a 3D scene.
 * Self-contained like {@link Scene3D}: mounts a full-size container, creates the
 * {@link Viewer3D} once, rebuilds the scene when the `drawing` identity changes,
 * and disposes on unmount. A ResizeObserver keeps the renderer/camera synced.
 *
 * Owns its own orbit/walk mode (defaults to `orbit` so the user first sees the
 * whole plan) and renders the shared mode toggle, walkthrough hint overlay, and
 * a first-person crosshair.
 */
export function DrawingScene3D({ drawing }: { drawing: Drawing }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer3D | null>(null)
  const minimapRef = useRef<MinimapHandle>(null)
  const [mode, setMode] = useState<ViewerMode>('orbit')
  const [hint, setHint] = useState<string | null>(null)
  // Static minimap geometry in world space, recomputed only when the plan does.
  const [map, setMap] = useState<MinimapProps | null>(null)

  // Create the viewer once for the lifetime of the mounted container.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const viewer = new Viewer3D(host)
    viewer.onModeHint = setHint
    viewerRef.current = viewer

    const ro = new ResizeObserver(() => viewer.resize())
    ro.observe(host)

    return () => {
      ro.disconnect()
      viewer.dispose()
      viewerRef.current = null
    }
  }, [])

  // Rebuild the scene whenever the imported drawing changes, and derive the
  // minimap's static geometry. Drawing coords are SOURCE coords; the viewer
  // recenters imported plans, so we subtract getContentOffset() from every
  // point to reach the viewer's world space (world = source − offset).
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const { root } = buildFromDrawing(drawing)
    viewer.setContent(root)
    const { x: ox, z: oz } = viewer.getContentOffset()
    const b = viewer.getContentBounds()

    const segments: MinimapProps['segments'] = []
    for (const e of drawing.entities) {
      if (e.category !== 'wall' || e.kind !== 'polyline' || !e.pts) continue
      const pts = e.pts
      for (let i = 0; i < pts.length - 1; i++) {
        segments.push([pts[i][0] - ox, pts[i][1] - oz, pts[i + 1][0] - ox, pts[i + 1][1] - oz])
      }
      if (e.closed && pts.length > 2) {
        const a = pts[pts.length - 1]
        const z = pts[0]
        segments.push([a[0] - ox, a[1] - oz, z[0] - ox, z[1] - oz])
      }
    }
    const points: MinimapProps['points'] = drawing.furniture.map((f) => {
      const [minX, minY, maxX, maxY] = f.bbox
      return [(minX + maxX) / 2 - ox, (minY + maxY) / 2 - oz]
    })
    setMap({
      segments,
      points,
      bounds: { minX: b.min.x, minZ: b.min.z, maxX: b.max.x, maxZ: b.max.z },
    })
  }, [drawing])

  // Feed the live first-person pose to the minimap while walking (imperative,
  // no re-render per frame). Cleared when leaving walk mode or unmounting.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    if (mode === 'walk') viewer.onPose = (p) => minimapRef.current?.setPose(p)
    return () => {
      if (viewer) viewer.onPose = undefined
    }
  }, [mode])

  const pick = (m: ViewerMode) => {
    setMode(m)
    viewerRef.current?.setMode(m)
  }

  const btn = (active: boolean): CSSProperties => ({
    font: '500 12px/1 "Space Grotesk", system-ui, sans-serif',
    letterSpacing: '0.02em',
    padding: '7px 14px',
    border: '1px solid rgba(0,0,0,0.08)',
    borderRadius: 7,
    cursor: 'pointer',
    color: active ? '#1b1d21' : '#5c626c',
    background: active ? '#E8A13C' : 'rgba(255,255,255,0.86)',
    boxShadow: active ? '0 1px 4px rgba(0,0,0,0.14)' : '0 1px 3px rgba(0,0,0,0.08)',
    backdropFilter: 'blur(6px)',
  })

  return (
    <div ref={hostRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 6, zIndex: 2 }}>
        <button style={btn(mode === 'orbit')} onClick={() => pick('orbit')} title="Orbit view">
          Orbit
        </button>
        <button
          style={btn(mode === 'walk')}
          onClick={() => pick('walk')}
          title="First-person walkthrough"
        >
          Walk
        </button>
      </div>
      {mode === 'walk' && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: 6,
            height: 6,
            marginTop: -3,
            marginLeft: -3,
            borderRadius: '50%',
            background: '#E8A13C',
            boxShadow: '0 0 0 1.5px rgba(24,26,30,0.55)',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        />
      )}
      {mode === 'walk' && map && (
        <Minimap
          ref={minimapRef}
          segments={map.segments}
          points={map.points}
          bounds={map.bounds}
          onPick={(x, z) => viewerRef.current?.moveWalkerTo(x, z)}
        />
      )}
      {mode === 'walk' && hint && (
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            font: '400 13px/1 "IBM Plex Mono", ui-monospace, monospace',
            color: '#f3f1ec',
            background: 'rgba(24,26,30,0.82)',
            padding: '8px 16px',
            borderRadius: 8,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        >
          {hint}
        </div>
      )}
    </div>
  )
}
