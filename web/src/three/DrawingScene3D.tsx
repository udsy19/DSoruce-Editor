import { useEffect, useRef } from 'react'
import type * as THREE from 'three'
import { Viewer3D } from './Viewer3D'
import { buildFromDrawing } from './buildFromDrawing'
import type { Drawing } from '../import/types'

/**
 * React wrapper that renders an imported CAD {@link Drawing} as a walk-through
 * 3D scene. Mirrors {@link Scene3D}: mounts a full-size container, creates the
 * {@link Viewer3D} once, and disposes on unmount. A ResizeObserver keeps the
 * renderer/camera synced to the container size.
 *
 * The scene root is rebuilt from scratch whenever the `drawing` prop identity
 * changes (a new import) or `mode` changes.
 *
 * `setContent`/`setMode` are added to Viewer3D by a parallel agent; until they
 * land we call them through defensive casts so this typechecks and no-ops.
 */
export function DrawingScene3D({ drawing, mode }: { drawing: Drawing; mode?: 'orbit' | 'walk' }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer3D | null>(null)

  // Create the viewer once for the lifetime of the mounted container.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const viewer = new Viewer3D(host)
    viewerRef.current = viewer

    const ro = new ResizeObserver(() => viewer.resize())
    ro.observe(host)

    return () => {
      ro.disconnect()
      viewer.dispose()
      viewerRef.current = null
    }
  }, [])

  // Rebuild the scene whenever the imported drawing changes.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const { root } = buildFromDrawing(drawing)
    ;(viewer as unknown as { setContent?: (g: THREE.Group) => void }).setContent?.(root)
  }, [drawing])

  // Switch orbit/walk navigation.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    ;(viewer as unknown as { setMode?: (m: string) => void }).setMode?.(mode ?? 'orbit')
  }, [mode])

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}
