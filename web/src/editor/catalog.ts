// Placeable component types. `category` matches the Rust core's category strings
// and drives which slice of the material bank the re-imagine panel shows.
//
// Colors are a deliberately COOL, muted content palette so the warm amber UI
// accent (selection / active tool) always reads as distinct from the content.
export interface CatItem {
  category: string
  label: string
  w: number // meters
  h: number
  color: string
  icon: string // key into ui/icons.tsx
}

export const CATALOG: CatItem[] = [
  { category: 'Desk', label: 'Desk', w: 1.4, h: 0.7, color: '#5B8DEF', icon: 'desk' },
  { category: 'Chair', label: 'Chair', w: 0.5, h: 0.5, color: '#9B7EDE', icon: 'chair' },
  { category: 'Table', label: 'Table', w: 1.6, h: 0.8, color: '#46B3A6', icon: 'table' },
  { category: 'MeetingRoom', label: 'Meeting Room', w: 4, h: 3, color: '#5FA8C4', icon: 'meeting' },
  { category: 'FallCeiling', label: 'Fall Ceiling', w: 3, h: 3, color: '#8A93A6', icon: 'ceiling' },
]

export const catByCategory = (c: string): CatItem | undefined =>
  CATALOG.find((x) => x.category === c)
