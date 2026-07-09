// UI-side descriptor of the architectural drawing set — the data the Sheets
// manager (web/src/ui/SheetsPanel.tsx) renders and toggles over.
//
// NOTE: the *actual* sheet content, order, and page geometry are owned by
// web/src/export/sheetSet.ts (buildDrawingSetPdf → cover · contents ·
// demolition · construction). This manifest is a pure, dependency-free mirror
// of that set so the manager can list sheets, show numbers, and preview what
// is coming online — WITHOUT importing the heavy PDF engine. When sheetSet.ts
// gains a sheet (Furniture / Moodboard / Sections per the M3–M4 milestones in
// docs/design/drawing-set-generator.md §4), flip its `available` flag here and
// it surfaces in the manager automatically — no SheetsPanel edit required.

export type SheetKind = 'cover' | 'contents' | 'plan' | 'furniture' | 'moodboard' | 'section'

export interface SheetDescriptor {
  /** Stable id — also the include-toggle key. */
  id: string
  /** Sheet number as printed in the title block, or '—' for front matter. */
  no: string
  title: string
  kind: SheetKind
  /** One-line description of what the sheet shows. */
  blurb: string
  /**
   * True when sheetSet.ts emits this sheet today. Future sheets are listed
   * (so the manager previews the growing set) but are shown as "soon" and are
   * neither included nor published until their generator lands.
   */
  available: boolean
}

/** The set, in publish order. Mirrors buildDrawingSetPdf() in sheetSet.ts. */
export const SHEET_MANIFEST: SheetDescriptor[] = [
  {
    id: 'cover',
    no: '—',
    title: 'Cover',
    kind: 'cover',
    blurb: 'Hero plan · project identity · concept blurb',
    available: true,
  },
  {
    id: 'contents',
    no: '—',
    title: 'Contents',
    kind: 'contents',
    blurb: 'Sheet index with dotted leaders',
    available: true,
  },
  {
    id: 'demolition',
    no: 'A.01',
    title: 'Demolition Plan',
    kind: 'plan',
    blurb: 'Existing shell grey · demolished walls red cross-hatch',
    available: true,
  },
  {
    id: 'construction',
    no: 'A.02',
    title: 'Construction & Furnishing Plan',
    kind: 'plan',
    blurb: 'New walls blue · furniture · door/window schedule',
    available: true,
  },
  // ---- Coming online (docs/design/drawing-set-generator.md §4, M3–M4) ----
  {
    id: 'furniture',
    no: 'A.03',
    title: 'Furniture & Fixtures',
    kind: 'furniture',
    blurb: 'Product cards · specs · pricing (from the takeoff + bank)',
    available: false,
  },
  {
    id: 'moodboard',
    no: 'A.04',
    title: 'Materials / Moodboard',
    kind: 'moodboard',
    blurb: 'Interior render · material swatch palette',
    available: false,
  },
  {
    id: 'sections',
    no: 'A.05',
    title: 'Sections & Elevations',
    kind: 'section',
    blurb: 'Orthographic cuts · scale figures · height dims',
    available: false,
  },
]

/** Sheets the current engine can actually publish (available === true). */
export function publishableSheets(): SheetDescriptor[] {
  return SHEET_MANIFEST.filter((s) => s.available)
}
