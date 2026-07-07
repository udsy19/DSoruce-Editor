import { useEffect, useRef, useState } from 'react'
import { Viewer3D, type ViewerMode } from './Viewer3D'
import { Minimap, type MinimapHandle, type MinimapProps } from './Minimap'
import { ViewerToolbar, type Quality, type ViewerWithExtras } from './ViewerToolbar'
import type { DocState } from '../editor/EditorCanvas'

/**
 * React wrapper around {@link Viewer3D}. Mounts a full-size container, creates
 * the viewer once, pushes DocState on every change, and disposes on unmount.
 * A ResizeObserver keeps the renderer/camera synced to the container size.
 *
 * Adds the shared {@link ViewerToolbar} and a walkthrough hint overlay driven
 * by the viewer's `onModeHint` callback.
 */
export function Scene3D({ state }: { state: DocState }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<ViewerWithExtras | null>(null)
  const minimapRef = useRef<MinimapHandle>(null)
  const [mode, setMode] = useState<ViewerMode>('orbit')
  const [quality, setQuality] = useState<Quality>('high')
  const [hint, setHint] = useState<string | null>(null)
  // Static minimap geometry in world space, recomputed only when the plan does.
  const [map, setMap] = useState<MinimapProps | null>(null)

  // Create the viewer once for the lifetime of the mounted container.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const viewer: ViewerWithExtras = new Viewer3D(host)
    viewer.onModeHint = setHint
    setQuality(viewer.getQuality?.() ?? 'high')
    viewer.onQualityChange = setQuality
    viewerRef.current = viewer

    const ro = new ResizeObserver(() => viewer.resize())
    ro.observe(host)

    return () => {
      ro.disconnect()
      viewer.onQualityChange = undefined
      viewer.dispose()
      viewerRef.current = null
    }
  }, [])

  // Rebuild the scene whenever the document changes, and derive the minimap's
  // static geometry. Generated plans render in source coords (offset {0,0}), so
  // walls/components are already the viewer's world space — used directly.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.setState(state)
    const b = viewer.getContentBounds()
    setMap({
      segments: state.walls.map((w) => [w.a.x, w.a.y, w.b.x, w.b.y]),
      points: state.components.map((c) => [c.x, c.y]),
      bounds: { minX: b.min.x, minZ: b.min.z, maxX: b.max.x, maxZ: b.max.z },
    })
  }, [state])

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

  return (
    <div ref={hostRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ViewerToolbar
        mode={mode}
        quality={quality}
        onMode={pick}
        onView={(v) => viewerRef.current?.setView?.(v)}
        onFrame={() => viewerRef.current?.frameAll?.()}
        onQuality={(q) => {
          viewerRef.current?.setQuality?.(q)
          setQuality(q)
        }}
      />
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
