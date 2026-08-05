import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Viewer3D, type ViewerMode, type PickHit } from './Viewer3D'
import { Minimap, type MinimapHandle, type MinimapProps } from './Minimap'
import { ViewerToolbar, DEFAULT_SUN, type Quality, type ViewerWithExtras } from './ViewerToolbar'
import { DEFAULT_THEME, type ThemeId } from './theme'
import type { DocState } from '../editor/EditorCanvas'
import { MONO, UI } from '../ui/type'

/**
 * Minimal selection card for a 3D pick, anchored at the click position and
 * clamped inside the viewer container. Used by {@link Scene3D}.
 * NOTE: this deliberately mirrors the visual language
 * of ui/SelectionCard (white, 12px radius, soft shadow, ~240px, title/subtitle/
 * status chip) but is kept local because that component is owned by a parallel
 * change — merge the two once ui/SelectionCard stabilizes.
 */
export function PickCard3D({
  screen,
  hostRef,
  title,
  subtitle,
  chip,
}: {
  screen: { x: number; y: number }
  hostRef: RefObject<HTMLDivElement | null>
  title: string
  subtitle: string
  chip: { text: string; bg: string; fg: string }
}) {
  const CARD_W = 240
  const CARD_H = 96 // estimate for clamping; content is compact and fixed
  const PAD = 8
  const hw = hostRef.current?.clientWidth ?? CARD_W + 2 * PAD
  const hh = hostRef.current?.clientHeight ?? CARD_H + 2 * PAD
  const left = Math.max(PAD, Math.min(screen.x + 12, hw - CARD_W - PAD))
  const top = Math.max(PAD, Math.min(screen.y + 12, hh - CARD_H - PAD))
  return (
    <div
      data-testid="pick-card-3d"
      style={{
        position: 'absolute',
        left,
        top,
        width: CARD_W,
        background: '#ffffff',
        borderRadius: 12,
        boxShadow: '0 8px 28px rgba(24, 26, 30, 0.18), 0 1px 3px rgba(24, 26, 30, 0.1)',
        padding: '12px 14px',
        zIndex: 3,
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 4,
        }}
      >
        <div
          style={{
            font: `600 14px/1.3 ${UI}`,
            color: '#1c1f24',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
        <div
          style={{
            font: `600 10px/1 ${UI}`,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: chip.fg,
            background: chip.bg,
            padding: '4px 8px',
            borderRadius: 999,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {chip.text}
        </div>
      </div>
      <div
        style={{
          font: `400 11px/1.4 ${MONO}`,
          color: '#6b7280',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {subtitle}
      </div>
    </div>
  )
}

/** Chip palettes: decision lifecycle (Materio) + neutral kinds. */
export const PICK_CHIP = {
  Open: { text: 'Open', bg: '#eef0f3', fg: '#5b6472' },
  InReview: { text: 'In review', bg: '#fdf1dd', fg: '#a06514' },
  Confirmed: { text: 'Confirmed', bg: '#e2f3ea', fg: '#1f7a4d' },
  Zone: { text: 'Zone', bg: '#eef0f3', fg: '#5b6472' },
  Furniture: { text: 'Furniture', bg: '#eef0f3', fg: '#5b6472' },
} as const

/**
 * React wrapper around {@link Viewer3D}. Mounts a full-size container, creates
 * the viewer once, pushes DocState on every change, and disposes on unmount.
 * A ResizeObserver keeps the renderer/camera synced to the container size.
 *
 * Adds the shared {@link ViewerToolbar}, a walkthrough hint overlay driven by
 * the viewer's `onModeHint` callback, and a click-to-select card (orbit mode)
 * driven by `onPick`.
 */
export function Scene3D({ state }: { state: DocState }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<ViewerWithExtras | null>(null)
  const minimapRef = useRef<MinimapHandle>(null)
  const [mode, setMode] = useState<ViewerMode>('orbit')
  const [quality, setQuality] = useState<Quality>('high')
  const [theme, setThemeId] = useState<ThemeId>(DEFAULT_THEME)
  const [hint, setHint] = useState<string | null>(null)
  // Static minimap geometry in world space, recomputed only when the plan does.
  const [map, setMap] = useState<MinimapProps | null>(null)
  // Current 3D selection (orbit-mode click). Shell hits (building fabric) and
  // empty space both close the card.
  const [picked, setPicked] = useState<PickHit | null>(null)

  // Create the viewer once for the lifetime of the mounted container.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const viewer: ViewerWithExtras = new Viewer3D(host)
    viewer.onModeHint = setHint
    setQuality(viewer.getQuality?.() ?? 'high')
    setThemeId(viewer.getTheme?.() ?? DEFAULT_THEME)
    viewer.onQualityChange = setQuality
    viewer.onPick = (h) => setPicked(h && h.kind !== 'shell' ? h : null)
    viewerRef.current = viewer
    // Dev handle for tests/debugging, like window.__ec / window.__dc.
    if (import.meta.env.DEV) (window as unknown as { __v3d: Viewer3D }).__v3d = viewer

    const ro = new ResizeObserver(() => viewer.resize())
    ro.observe(host)

    return () => {
      ro.disconnect()
      viewer.onQualityChange = undefined
      viewer.onPick = undefined
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

  const switchMode = (m: ViewerMode) => {
    setMode(m)
    setPicked(null) // selection card is orbit-only
    viewerRef.current?.setMode(m)
  }

  // Enrich the pick with document data for the card: decision chip for
  // components, area for zones (cheap — the zone shape is already in state).
  const card = useMemo(() => {
    if (!picked) return null
    if (picked.kind === 'component') {
      const c = state.components.find((x) => x.id === picked.id)
      return {
        title: picked.label || picked.category || 'Component',
        subtitle: picked.category ?? '',
        chip: PICK_CHIP[c?.decision ?? 'Open'],
      }
    }
    if (picked.kind === 'zone') {
      const z = state.zones?.find((x) => x.id === picked.id)
      let area: number | null = null
      if (z) {
        const s = z.shape
        if (s.kind === 'Poly') {
          let a2 = 0
          for (let i = 0; i < s.pts.length; i++) {
            const [x0, y0] = s.pts[i]
            const [x1, y1] = s.pts[(i + 1) % s.pts.length]
            a2 += x0 * y1 - x1 * y0
          }
          area = Math.abs(a2) / 2
        } else {
          area = s.kind === 'Rect' ? s.w * s.h : s.w * s.h - s.in_w * s.in_h
        }
      }
      return {
        title: picked.label || 'Zone',
        subtitle: `${picked.zoneType ?? 'Zone'}${area != null ? ` · ${area.toFixed(1)} m²` : ''}`,
        chip: PICK_CHIP.Zone,
      }
    }
    return null
  }, [picked, state])

  return (
    <div ref={hostRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ViewerToolbar
        mode={mode}
        quality={quality}
        onMode={switchMode}
        onView={(v) => viewerRef.current?.setView?.(v)}
        onFrame={() => viewerRef.current?.frameAll?.()}
        onQuality={(q) => {
          const v = viewerRef.current
          v?.setQuality?.(q)
          // Re-read so the UI tracks what the engine actually accepted (an old
          // engine without the render tier no-ops or clamps the request).
          setQuality(v?.getQuality?.() ?? q)
        }}
        onSun={(elev, azim) => viewerRef.current?.setSun?.(elev, azim)}
        getSun={() => viewerRef.current?.getSun?.() ?? DEFAULT_SUN}
        theme={theme}
        onTheme={(id) => {
          viewerRef.current?.setTheme?.(id)
          setThemeId(id)
        }}
      />
      {mode === 'orbit' && picked && card && (
        <PickCard3D
          screen={picked.screen}
          hostRef={hostRef}
          title={card.title}
          subtitle={card.subtitle}
          chip={card.chip}
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
            font: `400 13px/1 ${MONO}`,
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
