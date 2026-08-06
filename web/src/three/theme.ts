import type { ZoneType } from '../types/doc'
import { SELECTION_ACCENT_HEX } from '../editor/planStyle'
/**
 * 3D viewer material themes. A theme is a palette that the {@link Viewer3D}
 * maps onto the scene's fabric: a per-zone floor tint (so the plan reads by
 * room in 3D, mirroring the 2D zone legend), two wall tones (a lighter one for
 * generated partitions, a heavier one for the exterior/plate — mirroring the 2D
 * lineweight hierarchy), a grounded exterior (ground plane + grid), and an
 * accent used for the grid's emphasis lines.
 *
 * Presets:
 *  - `studio`    — neutral / light-wood, default. Tints track the 2D legend.
 *  - `warm`      — oak floors + warm off-white walls.
 *  - `mono`      — greyscale architectural; zones read by lightness only.
 *  - `blueprint` — cool blue-grey, drafting feel.
 *
 * The chosen preset persists in localStorage under {@link THEME_STORAGE_KEY}.
 */
export type ThemeId = 'studio' | 'warm' | 'mono' | 'blueprint'

export interface ViewerTheme {
  id: ThemeId
  label: string
  /** Floor tint per zone type (hex). Reused per zone-type, never per plate. */
  floorByZone: Record<ZoneType, number>
  /** Fallback floor tint for an unknown/absent zone type. */
  floorBase: number
  /** Generated interior partitions (the lighter wall tone). */
  wall: number
  /** Exterior / plate walls — heavier & darker, mirroring the 2D lineweight. */
  wallExt: number
  /** Exterior ground plane under the building. */
  ground: number
  /** Ground grid minor lines. */
  grid: number
  /** Accent: the grid's emphasis lines (and a small swatch in the UI). */
  accent: number
}

/**
 * Zone types whose 3D floor is the NEUTRAL base, not a zone tint.
 *
 * Ground in the plan must be ground in the walkthrough. A zone-tinted carpet
 * under circulation resurrects in 3D exactly the fill the figure/ground rule
 * removed from the 2D plan — walk the model and the corridors are a coloured
 * floor again, telling a different story about the same building.
 *
 * `floorByZone` deliberately KEEPS its entries for these types:
 * `ViewerToolbar` reads `floorByZone.Circulation` for its per-theme swatch, so
 * deleting a key to change a material would break an unrelated consumer. What
 * changes is which types get a material allocated — `buildZonePlate` already
 * falls back to `floorBaseMat` for anything unregistered.
 */
export const NEUTRAL_FLOOR_ZONES: ReadonlySet<ZoneType> = new Set<ZoneType>([
  'Circulation',
  'Unassigned',
])

export const THEMES: Record<ThemeId, ViewerTheme> = {
  studio: {
    id: 'studio',
    label: 'Studio',
    floorByZone: {
      Workspace: 0xcfb87f, // warm light-wood neutral
      Meeting: 0xc0b2e2, // soft purple
      Collaboration: 0x9fd3b0, // soft green
      Circulation: 0xbcd2ea, // cool circulation path
      Unassigned: 0xbcd2ea, // ground: same floor as Circulation (Phase 2.4 makes both neutral)
      Core: 0xbcc3cf, // neutral grey
      ClosedOffice: 0xe9bb8c, // peach
      Amenity: 0x98d0c8, // teal
    },
    floorBase: 0xd8d2c4,
    wall: 0xdadde2, // light interior partition
    wallExt: 0xb7bbc4, // heavier exterior plate
    ground: 0xcfc8b8,
    grid: 0xb2b8c0,
    accent: SELECTION_ACCENT_HEX,
  },
  warm: {
    id: 'warm',
    label: 'Warm',
    floorByZone: {
      Workspace: 0xceb079, // oak
      Meeting: 0xccb9b0, // warm mauve
      Collaboration: 0xbfc794, // warm sage
      Circulation: 0xd6cba8, // warm path
      Unassigned: 0xd6cba8, // ground: same floor as Circulation (Phase 2.4 makes both neutral)
      Core: 0xcbc0a7,
      ClosedOffice: 0xe6b57f, // warm peach
      Amenity: 0xbccca0,
    },
    floorBase: 0xd6c8ad,
    wall: 0xe1d6be, // warm off-white plaster
    wallExt: 0xbdb08f, // warm taupe, heavier
    ground: 0xc2b48f,
    grid: 0xb3a888,
    accent: SELECTION_ACCENT_HEX,
  },
  mono: {
    id: 'mono',
    label: 'Mono',
    floorByZone: {
      Workspace: 0xcccccc,
      Meeting: 0xbcbcbc,
      Collaboration: 0xd8d8d8,
      Circulation: 0xe2e2e2, // lightest path
      Unassigned: 0xe2e2e2, // ground: same floor as Circulation (Phase 2.4 makes both neutral)
      Core: 0xafafaf,
      ClosedOffice: 0xc6c6c6,
      Amenity: 0xd0d0d0,
    },
    floorBase: 0xd0d0d0,
    wall: 0xcbccce,
    wallExt: 0x9da1a7, // structural grey
    ground: 0xb9bcbf,
    grid: 0xa1a5aa,
    accent: 0x8a9099,
  },
  blueprint: {
    id: 'blueprint',
    label: 'Blueprint',
    floorByZone: {
      Workspace: 0xb2c6e0,
      Meeting: 0xbcbce6,
      Collaboration: 0xafd2d6,
      Circulation: 0xc4d6ee, // lightest cool path
      Unassigned: 0xc4d6ee, // ground: same floor as Circulation (Phase 2.4 makes both neutral)
      Core: 0xacb9cd,
      ClosedOffice: 0xc6bcdc,
      Amenity: 0xaad2dc,
    },
    floorBase: 0xbccadd,
    wall: 0xbfccdd,
    wallExt: 0x91a4c0, // deep blue-grey structural
    ground: 0xa6b8ce,
    grid: 0x8598b4,
    accent: 0x4a82c4, // blueprint blue
  },
}

export const THEME_ORDER: ThemeId[] = ['studio', 'warm', 'mono', 'blueprint']
export const DEFAULT_THEME: ThemeId = 'studio'
export const THEME_STORAGE_KEY = 'v3d-theme'

/** Read the persisted theme id, falling back to {@link DEFAULT_THEME}. */
export function loadThemeId(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    if (v && v in THEMES) return v as ThemeId
  } catch {
    /* private mode / no storage */
  }
  return DEFAULT_THEME
}

/** Persist the chosen theme id (best-effort; ignores storage failures). */
export function saveThemeId(id: ThemeId): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
}
