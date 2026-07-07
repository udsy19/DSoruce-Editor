// Office-furniture material bank (imported-plan re-imagine).
// -------------------------------------------------------------------------
// Sibling to `mock.ts`: that bank keys products by the generative editor's
// component categories; this one keys a realistic office catalog by furniture
// *bank-category* (task-chair, desk, …) and maps a real imported `FurnitureItem`
// (from a DWG) onto one of those buckets via `bankCategoryForItem`. Same
// product shape as mock.ts so the real searchable bank can replace either file.

import type { FurnitureItem } from '../import/types'

export interface OfficeProduct {
  id: string
  name: string
  vendor: string
  price: number
  swatch: string // stand-in for a real thumbnail/3D asset
  /** Real catalog thumbnail when the product came from the live bank. */
  image?: string | null
}

/** Office furniture bank-categories the imported schedule maps onto. */
export type BankCategory =
  | 'task-chair'
  | 'desk'
  | 'workstation-bench'
  | 'meeting-table'
  | 'side-table'
  | 'lounge'
  | 'stool'
  | 'storage'
  | 'planter'
  | 'partition'

const BANK: Record<BankCategory, OfficeProduct[]> = {
  'task-chair': [
    { id: 'tc-silq', name: 'SILQ Task Chair', vendor: 'Steelcase', price: 1090, swatch: '#2b2b30' },
    { id: 'tc-aeron', name: 'Aeron Task Chair', vendor: 'Herman Miller', price: 1395, swatch: '#33363b' },
    { id: 'tc-fern', name: 'Fern Ergonomic Chair', vendor: 'Haworth', price: 980, swatch: '#3f6f8f' },
    { id: 'tc-id-mesh', name: 'ID Mesh Task Chair', vendor: 'Vitra', price: 860, swatch: '#4a4f57' },
    { id: 'tc-gesture', name: 'Gesture Task Chair', vendor: 'Steelcase', price: 1240, swatch: '#5a5f66' },
  ],
  desk: [
    { id: 'dk-migration', name: 'Migration SE Sit-Stand Desk', vendor: 'Herman Miller', price: 1180, swatch: '#b5834f' },
    { id: 'dk-ology', name: 'Ology Height-Adjustable Desk', vendor: 'Steelcase', price: 1420, swatch: '#8a5a34' },
    { id: 'dk-jump', name: 'Jump Stand Sit-Stand Desk', vendor: 'Haworth', price: 990, swatch: '#c9a06a' },
    { id: 'dk-tyde', name: 'Tyde Executive Desk', vendor: 'Vitra', price: 2380, swatch: '#5a3b28' },
  ],
  'workstation-bench': [
    { id: 'wb-fuze', name: 'Fuze Bench System (2-Person)', vendor: 'Herman Miller', price: 2240, swatch: '#d7d9dd' },
    { id: 'wb-frameone', name: 'FrameOne Bench Desk', vendor: 'Steelcase', price: 1860, swatch: '#e8e8ea' },
    { id: 'wb-planes', name: 'Planes Bench Workstation', vendor: 'Haworth', price: 1990, swatch: '#c2c6cc' },
    { id: 'wb-joyn', name: 'Joyn Bench (140cm)', vendor: 'Vitra', price: 1720, swatch: '#a8895f' },
  ],
  'meeting-table': [
    { id: 'mt-eames', name: 'Eames Segmented Conference Table', vendor: 'Herman Miller', price: 4600, swatch: '#5a3b28' },
    { id: 'mt-potrero', name: 'Potrero415 Meeting Table', vendor: 'Steelcase', price: 2980, swatch: '#c9a06a' },
    { id: 'mt-medamorph', name: 'MedaMorph Conference Table', vendor: 'Vitra', price: 3450, swatch: '#8a5a34' },
    { id: 'mt-70', name: '70 Series Round Meeting Table', vendor: 'Muuto', price: 1680, swatch: '#dfe1e6' },
  ],
  'side-table': [
    { id: 'st-nelson', name: 'Nelson Pedestal Side Table', vendor: 'Herman Miller', price: 720, swatch: '#2b2b30' },
    { id: 'st-around', name: 'Around Coffee Table', vendor: 'Muuto', price: 540, swatch: '#b5834f' },
    { id: 'st-tofu', name: 'Tofu Coffee Table', vendor: 'Vitra', price: 890, swatch: '#dfe1e6' },
    { id: 'st-relate', name: 'Relate Side Table', vendor: 'Haworth', price: 460, swatch: '#9aa0ab' },
  ],
  lounge: [
    { id: 'lg-womb', name: 'Womb Lounge Chair', vendor: 'Knoll', price: 4200, swatch: '#c15a4a' },
    { id: 'lg-fiber', name: 'Fiber Lounge Armchair', vendor: 'Muuto', price: 1180, swatch: '#8a9a86' },
    { id: 'lg-oyster', name: 'Oyster Club Chair', vendor: 'Vitra', price: 2650, swatch: '#4a5f8f' },
    { id: 'lg-outline', name: 'Outline 3-Seat Sofa', vendor: 'Muuto', price: 3980, swatch: '#5f6670' },
    { id: 'lg-bardot', name: 'Bardot Banquette Settee', vendor: 'Haworth', price: 2340, swatch: '#7a5c8a' },
  ],
  stool: [
    { id: 'sl-about', name: 'About A Stool Barstool', vendor: 'Muuto', price: 320, swatch: '#3f6f8f' },
    { id: 'sl-turnstone', name: 'Turnstone Shortcut Stool', vendor: 'Steelcase', price: 410, swatch: '#c9a06a' },
    { id: 'sl-hal', name: 'Hal Counter Stool', vendor: 'Vitra', price: 580, swatch: '#2b2b30' },
    { id: 'sl-nerd', name: 'Nerd Bar Stool', vendor: 'Muuto', price: 490, swatch: '#b5834f' },
  ],
  storage: [
    { id: 'sr-meridian', name: 'Meridian Lateral File Cabinet', vendor: 'Herman Miller', price: 980, swatch: '#6b7280' },
    { id: 'sr-currency', name: 'Currency Storage Credenza', vendor: 'Steelcase', price: 1240, swatch: '#8a5a34' },
    { id: 'sr-fjord', name: 'Fjord Storage Cabinet', vendor: 'Haworth', price: 860, swatch: '#c2c6cc' },
    { id: 'sr-stacking', name: 'Stacking Storage Case', vendor: 'Vitra', price: 640, swatch: '#d7d9dd' },
  ],
  planter: [
    { id: 'pl-riihi', name: 'Riihi Floor Planter', vendor: 'Muuto', price: 280, swatch: '#8a9a86' },
    { id: 'pl-elevated', name: 'Elevated Planter Bowl', vendor: 'Ferm Living', price: 190, swatch: '#6f8a5f' },
    { id: 'pl-plant-box', name: 'Plant Box Room Divider', vendor: 'Ferm Living', price: 420, swatch: '#5f7a4a' },
  ],
  partition: [
    { id: 'pt-privacy', name: 'Privacy Wall Glazed Panel', vendor: 'Steelcase', price: 1650, swatch: '#bfe3ea' },
    { id: 'pt-loftwall', name: 'LoftWall Framed Screen', vendor: 'Haworth', price: 890, swatch: '#9aa2ad' },
    { id: 'pt-overlay', name: 'Overlay Modular Panel', vendor: 'Knoll', price: 1120, swatch: '#c2c6cc' },
    { id: 'pt-softwall', name: 'Softwall Acoustic Partition', vendor: 'Muuto', price: 740, swatch: '#d7d9dd' },
  ],
}

/**
 * Search one bank-category by a name/vendor substring. Empty query returns the
 * whole bucket. Unknown category returns `[]`.
 */
export function searchOfficeBank(bankCategory: string, q: string): OfficeProduct[] {
  const items = BANK[bankCategory as BankCategory] ?? []
  const query = q.trim().toLowerCase()
  if (!query) return items
  return items.filter(
    (p) => p.name.toLowerCase().includes(query) || p.vendor.toLowerCase().includes(query),
  )
}

/**
 * Map an imported `FurnitureItem` onto a bank-category by inspecting its cleaned
 * name (and category as a weak hint). Case-insensitive substring rules; ordered
 * so the more specific match wins. Falls back to `task-chair` (the safest, most
 * common office object) when nothing matches.
 */
export function bankCategoryForItem(item: FurnitureItem): BankCategory {
  const n = `${item.name} ${item.category}`.toLowerCase()
  const has = (s: string) => n.includes(s)

  // Lounge seating first: it shares the "chair" token but is a distinct bucket.
  if (has('club chair') || has('lounge') || has('banquette') || has('sofa') || has('settee'))
    return 'lounge'
  // Task/office seating — "chair" but not the lounge variants handled above.
  if (has('task chair') || (has('chair') && !has('club') && !has('lounge'))) return 'task-chair'
  if (has('bench') || has('workstation')) return 'workstation-bench'
  if (has('desk') || has('pedestal desk')) return 'desk'
  if (has('side table') || has('coffee')) return 'side-table'
  if (has('meeting') || has('conference') || has('pedestal table') || (has('table') && !has('side')))
    return 'meeting-table'
  if (has('stool') || has('barstool')) return 'stool'
  if (has('cabinet') || has('storage') || has('credenza') || has('case')) return 'storage'
  if (has('planter')) return 'planter'
  if (has('panel') || has('mullion') || has('partition') || has('screen')) return 'partition'
  return 'task-chair'
}
