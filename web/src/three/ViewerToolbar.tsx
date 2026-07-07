import type { CSSProperties, ReactNode } from 'react'
import type { ViewerMode, Viewer3D } from './Viewer3D'

/** Camera framing presets offered by the upgraded viewer engine. */
export type ViewPreset = 'persp' | 'top'
/** Render-quality levels offered by the upgraded viewer engine. */
export type Quality = 'high' | 'low'

/**
 * Members the upgraded {@link Viewer3D} engine adds. The engine lands in a
 * parallel change, so wrappers call these through a typed facade with runtime
 * guards (`viewer as ViewerWithExtras`, then `v.frameAll?.()`) — each control
 * degrades to a no-op until the engine ships.
 */
export interface ViewerExtras {
  frameAll(): void
  setView(preset: ViewPreset): void
  setQuality(q: Quality): void
  getQuality(): Quality
  onQualityChange?: (q: Quality) => void
}

/** Typed facade over the current engine plus the (optional) upgraded API. */
export type ViewerWithExtras = Viewer3D & Partial<ViewerExtras>

export interface ViewerToolbarProps {
  mode: ViewerMode
  quality: Quality
  onMode: (m: ViewerMode) => void
  onView: (v: ViewPreset) => void
  onFrame: () => void
  onQuality: (q: Quality) => void
}

// Local 16px viewer glyphs. Deliberately not added to ui/icons.tsx: that file
// is the 2D editor's 24px tool-icon set and these camera/quality glyphs belong
// to the 3D viewer's own visual system (smaller grid, tighter strokes).
const glyph = {
  width: 15,
  height: 15,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

const glyphs: Record<'orbit' | 'walk' | 'top' | 'cube' | 'frame' | 'sparkle', ReactNode> = {
  orbit: (
    <svg {...glyph}>
      <circle cx="8" cy="8" r="3.1" />
      <path d="M2.2 6.2C1.5 7 1.3 7.8 1.7 8.5c.8 1.4 4 1.9 7.2 1.1 3.2-.9 5.7-2.7 4.9-4.1-.4-.7-1.3-1-2.5-1" />
    </svg>
  ),
  walk: (
    <svg {...glyph}>
      <circle cx="8.8" cy="2.6" r="1.3" />
      <path d="M8.6 5L8 8.6M8 8.6l-2 5M8 8.6l2.3 2.2.5 3M8.3 5.8L5.6 7.6M8.6 5.4l2.7 1.7" />
    </svg>
  ),
  top: (
    <svg {...glyph}>
      <rect x="2.8" y="2.8" width="10.4" height="10.4" rx="1" />
      <circle cx="8" cy="8" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  ),
  cube: (
    <svg {...glyph}>
      <path d="M8 1.6l5.7 3.2v6.4L8 14.4l-5.7-3.2V4.8z" />
      <path d="M2.3 4.8L8 8l5.7-3.2M8 8v6.4" />
    </svg>
  ),
  frame: (
    <svg {...glyph}>
      <path d="M2 5.2V3.4C2 2.6 2.6 2 3.4 2h1.8M10.8 2h1.8c.8 0 1.4.6 1.4 1.4v1.8M14 10.8v1.8c0 .8-.6 1.4-1.4 1.4h-1.8M5.2 14H3.4c-.8 0-1.4-.6-1.4-1.4v-1.8" />
    </svg>
  ),
  sparkle: (
    <svg {...glyph}>
      <path d="M8 1.8l1.4 4.2L13.6 7.4 9.4 8.8 8 13l-1.4-4.2L2.4 7.4l4.2-1.4z" />
      <path d="M13 11.6l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" strokeWidth={1.1} />
    </svg>
  ),
}

const pill: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 2,
  display: 'flex',
  alignItems: 'stretch',
  gap: 2,
  padding: 3,
  border: '1px solid rgba(0,0,0,0.08)',
  borderRadius: 9,
  background: 'rgba(255,255,255,0.86)',
  backdropFilter: 'blur(6px)',
  boxShadow: '0 1px 4px rgba(0,0,0,0.10)',
}

const divider: CSSProperties = {
  width: 1,
  margin: '3px 3px',
  background: 'rgba(0,0,0,0.10)',
}

const seg = (active: boolean, disabled: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  font: '500 12px/1 "Space Grotesk", system-ui, sans-serif',
  letterSpacing: '0.02em',
  padding: '6px 10px',
  border: 'none',
  borderRadius: 6,
  cursor: disabled ? 'default' : 'pointer',
  color: active ? '#1b1d21' : '#5c626c',
  background: active ? '#E8A13C' : 'transparent',
  boxShadow: active ? '0 1px 3px rgba(0,0,0,0.14)' : 'none',
  opacity: disabled ? 0.35 : 1,
})

/**
 * Shared floating toolbar for the 3D views: orbit/walk camera mode, view
 * presets (top / perspective), frame-all, and a render-quality chip. Purely
 * presentational — wrappers own the state and talk to the viewer engine.
 * View presets and Frame only apply to the orbit camera, so they render
 * disabled while walking.
 */
export function ViewerToolbar({ mode, quality, onMode, onView, onFrame, onQuality }: ViewerToolbarProps) {
  const walking = mode === 'walk'
  return (
    <div style={pill} role="toolbar" aria-label="3D viewer controls">
      <button
        style={seg(mode === 'orbit', false)}
        onClick={() => onMode('orbit')}
        title="Orbit view"
        aria-pressed={mode === 'orbit'}
        data-testid="v3d-orbit"
      >
        {glyphs.orbit}
        Orbit
      </button>
      <button
        style={seg(walking, false)}
        onClick={() => onMode('walk')}
        title="First-person walkthrough"
        aria-pressed={walking}
        data-testid="v3d-walk"
      >
        {glyphs.walk}
        Walk
      </button>
      <span style={divider} />
      <button
        style={seg(false, walking)}
        onClick={() => onView('top')}
        title="Top view"
        disabled={walking}
        data-testid="v3d-top"
      >
        {glyphs.top}
        Top
      </button>
      <button
        style={seg(false, walking)}
        onClick={() => onView('persp')}
        title="Perspective view"
        disabled={walking}
        data-testid="v3d-persp"
      >
        {glyphs.cube}
        3D
      </button>
      <button
        style={seg(false, walking)}
        onClick={onFrame}
        title="Frame all content"
        disabled={walking}
        data-testid="v3d-frame"
      >
        {glyphs.frame}
        Frame
      </button>
      <span style={divider} />
      <button
        style={seg(quality === 'high', false)}
        onClick={() => onQuality(quality === 'high' ? 'low' : 'high')}
        title={quality === 'high' ? 'High quality rendering (click for performance mode)' : 'Performance mode (click for high quality)'}
        aria-pressed={quality === 'high'}
        data-testid="v3d-quality"
      >
        {glyphs.sparkle}
        HQ
      </button>
    </div>
  )
}
