import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ViewerMode, Viewer3D } from './Viewer3D'
import { THEMES, THEME_ORDER, type ThemeId } from './theme'
import { SELECTION_ACCENT } from '../editor/planStyle'

/** Camera framing presets offered by the upgraded viewer engine. */
export type ViewPreset = 'persp' | 'top'
/** Render-quality tiers offered by the upgraded viewer engine. `render` is the
 *  Enscape-like photoreal tier (adds sun control). */
export type Quality = 'low' | 'high' | 'render'
/** Sun position, degrees: elevation 5..90 above the horizon, azimuth 0..360. */
export interface SunPosition {
  elevationDeg: number
  azimuthDeg: number
}

/** Engine default sun — used until the upgraded engine's `getSun` exists. */
export const DEFAULT_SUN: SunPosition = { elevationDeg: 42, azimuthDeg: 135 }

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
  // Method syntax (not a property type) on purpose: the old engine declares
  // this callback slot with the 2-state Quality, and only method parameters
  // are checked bivariantly under strictFunctionTypes — so the facade stays
  // assignable from both engine generations.
  onQualityChange?(q: Quality): void
  setSun(elevationDeg: number, azimuthDeg: number): void
  getSun(): SunPosition
  /** Switch the viewer material theme (studio/warm/mono/blueprint); persists. */
  setTheme(id: ThemeId): void
  getTheme(): ThemeId
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
  /** Live sun update from the popover sliders (render tier only). */
  onSun: (elevationDeg: number, azimuthDeg: number) => void
  /** Current engine sun, read when the popover opens. */
  getSun: () => SunPosition
  /** Active material theme + setter (from the Theme popover). */
  theme: ThemeId
  onTheme: (id: ThemeId) => void
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

const glyphs: Record<'orbit' | 'walk' | 'top' | 'cube' | 'frame' | 'sparkle' | 'sun' | 'palette', ReactNode> = {
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
  sun: (
    <svg {...glyph}>
      <circle cx="8" cy="8" r="2.7" />
      <path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.3 3.3l1.3 1.3M11.4 11.4l1.3 1.3M12.7 3.3l-1.3 1.3M4.6 11.4l-1.3 1.3" />
    </svg>
  ),
  palette: (
    <svg {...glyph}>
      <path d="M8 1.7a6.3 6.3 0 100 12.6c1 0 1.5-.8 1.5-1.5 0-.4-.2-.7-.4-1-.2-.3-.4-.6-.4-1 0-.7.6-1.3 1.3-1.3H11a3.3 3.3 0 003.3-3.3C14.3 4.3 11.5 1.7 8 1.7z" />
      <circle cx="5" cy="7" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="4.7" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="5.4" r="0.85" fill="currentColor" stroke="none" />
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
  background: active ? SELECTION_ACCENT : 'transparent',
  boxShadow: active ? '0 1px 3px rgba(0,0,0,0.14)' : 'none',
  opacity: disabled ? 0.35 : 1,
})

// The Render tier reads slightly premium: sparkle glyph plus a warm amber
// gradient when active (the other segments stay flat accent).
const renderSeg = (active: boolean): CSSProperties => ({
  ...seg(active, false),
  ...(active
    ? {
        background: `linear-gradient(120deg, ${SELECTION_ACCENT} 0%, #F3C778 100%)`,
        boxShadow: '0 1px 4px rgba(var(--accent-amber-rgb), 0.45)',
      }
    : {}),
})

const popover: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 8px)',
  right: 0,
  width: 232,
  padding: '12px 14px',
  border: '1px solid rgba(0,0,0,0.08)',
  borderRadius: 9,
  background: 'rgba(255,255,255,0.92)',
  backdropFilter: 'blur(6px)',
  boxShadow: '0 6px 20px rgba(0,0,0,0.14)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  cursor: 'default',
}

/** One labeled degree slider row inside the sun popover. */
function SunSlider({
  label,
  min,
  max,
  value,
  testid,
  onInput,
}: {
  label: string
  min: number
  max: number
  value: number
  testid: string
  onInput: (v: number) => void
}) {
  return (
    <label style={{ display: 'block' }}>
      <span
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 5,
        }}
      >
        <span style={{ font: '500 11px/1 "Space Grotesk", system-ui, sans-serif', color: '#5c626c', letterSpacing: '0.03em' }}>
          {label}
        </span>
        <span style={{ font: '400 11px/1 "IBM Plex Mono", ui-monospace, monospace', color: '#1b1d21' }}>
          {value}°
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        data-testid={testid}
        onInput={(e) => onInput(Number(e.currentTarget.value))}
        style={{ display: 'block', width: '100%', margin: 0, accentColor: SELECTION_ACCENT }}
      />
    </label>
  )
}

/** One theme option in the Theme popover: a swatch strip of its key tones
 *  (a few zone floors + the heavier wall + ground) and the theme label. */
function ThemeRow({ id, active, onSelect }: { id: ThemeId; active: boolean; onSelect: () => void }) {
  const t = THEMES[id]
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`
  const swatches = [t.floorByZone.Workspace, t.floorByZone.Meeting, t.floorByZone.Circulation, t.wallExt, t.ground]
  return (
    <button
      onClick={onSelect}
      data-testid={`v3d-theme-${id}`}
      aria-pressed={active}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '7px 8px',
        border: active ? `1px solid ${SELECTION_ACCENT}` : '1px solid transparent',
        borderRadius: 7,
        background: active ? 'rgba(var(--accent-amber-rgb), 0.10)' : 'transparent',
        cursor: 'pointer',
      }}
    >
      <span style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', boxShadow: '0 0 0 1px rgba(0,0,0,0.08)' }}>
        {swatches.map((c, i) => (
          <span key={i} style={{ width: 13, height: 18, background: hex(c) }} />
        ))}
      </span>
      <span style={{ font: '500 12px/1 "Space Grotesk", system-ui, sans-serif', color: active ? '#1b1d21' : '#3f444c' }}>
        {t.label}
      </span>
    </button>
  )
}

/**
 * Shared floating toolbar for the 3D views: orbit/walk camera mode, view
 * presets (top / perspective), frame-all, a three-tier quality segment
 * (Lo / Hi / Render), and a material Theme popover. Wrappers own mode/quality/
 * theme state and talk to the viewer engine; the render-tier sun popover and
 * the theme popover (open flags) are view-local UI state kept here so both
 * wrappers share them. View presets and Frame only apply to the orbit camera,
 * so they render disabled while walking.
 */
export function ViewerToolbar({ mode, quality, onMode, onView, onFrame, onQuality, onSun, getSun, theme, onTheme }: ViewerToolbarProps) {
  const walking = mode === 'walk'
  const rootRef = useRef<HTMLDivElement>(null)
  const [sunOpen, setSunOpen] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const [sun, setSun] = useState<SunPosition>(DEFAULT_SUN)

  // Close whichever popover is open on outside click or Escape.
  useEffect(() => {
    if (!sunOpen && !themeOpen) return
    const closeAll = () => {
      setSunOpen(false)
      setThemeOpen(false)
    }
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closeAll()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAll()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [sunOpen, themeOpen])

  // The popover never survives a walk switch or leaving the render tier
  // (auto-degrade included — quality flows back in via props).
  useEffect(() => {
    if (walking || quality !== 'render') setSunOpen(false)
  }, [walking, quality])

  const toggleSun = () => {
    if (!sunOpen) setSun(getSun()) // seed sliders from the engine on open
    setThemeOpen(false)
    setSunOpen(!sunOpen)
  }

  const toggleTheme = () => {
    setSunOpen(false)
    setThemeOpen((v) => !v)
  }

  const changeSun = (next: SunPosition) => {
    setSun(next)
    onSun(next.elevationDeg, next.azimuthDeg)
  }

  return (
    <div ref={rootRef} style={pill} role="toolbar" aria-label="3D viewer controls">
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
        style={seg(quality === 'low', false)}
        onClick={() => onQuality('low')}
        title="Performance mode"
        aria-pressed={quality === 'low'}
        data-testid="v3d-q-low"
      >
        Lo
      </button>
      <button
        style={seg(quality === 'high', false)}
        onClick={() => onQuality('high')}
        title="High quality rendering"
        aria-pressed={quality === 'high'}
        data-testid="v3d-q-high"
      >
        Hi
      </button>
      <button
        style={renderSeg(quality === 'render')}
        onClick={() => onQuality('render')}
        title="Photoreal render tier (sun control)"
        aria-pressed={quality === 'render'}
        data-testid="v3d-q-render"
      >
        {glyphs.sparkle}
        Render
      </button>
      {quality === 'render' && (
        <>
          <span style={divider} />
          <button
            style={seg(sunOpen, false)}
            onClick={toggleSun}
            title="Sun position"
            aria-pressed={sunOpen}
            aria-expanded={sunOpen}
            data-testid="v3d-sun"
          >
            {glyphs.sun}
          </button>
        </>
      )}
      <span style={divider} />
      <button
        style={seg(themeOpen, false)}
        onClick={toggleTheme}
        title="Material theme"
        aria-pressed={themeOpen}
        aria-expanded={themeOpen}
        data-testid="v3d-theme"
      >
        {glyphs.palette}
        Theme
      </button>
      {themeOpen && (
        <div style={{ ...popover, gap: 4 }} role="group" aria-label="Material theme">
          {THEME_ORDER.map((id) => (
            <ThemeRow key={id} id={id} active={theme === id} onSelect={() => onTheme(id)} />
          ))}
        </div>
      )}
      {sunOpen && (
        <div style={popover} role="group" aria-label="Sun position">
          <SunSlider
            label="Elevation"
            min={5}
            max={90}
            value={sun.elevationDeg}
            testid="v3d-sun-elev"
            onInput={(v) => changeSun({ ...sun, elevationDeg: v })}
          />
          <SunSlider
            label="Azimuth"
            min={0}
            max={360}
            value={sun.azimuthDeg}
            testid="v3d-sun-azim"
            onInput={(v) => changeSun({ ...sun, azimuthDeg: v })}
          />
        </div>
      )}
    </div>
  )
}
