// Placeable component types. `category` matches the Rust core's category strings
// and drives which slice of the material bank the re-imagine panel shows.
export interface CatItem {
  category: string
  label: string
  w: number // meters
  h: number
  color: string
  emoji: string
}

export const CATALOG: CatItem[] = [
  { category: 'Desk', label: 'Desk', w: 1.4, h: 0.7, color: '#4f8cff', emoji: '🖥️' },
  { category: 'Chair', label: 'Chair', w: 0.5, h: 0.5, color: '#8b5cf6', emoji: '🪑' },
  { category: 'Table', label: 'Table', w: 1.6, h: 0.8, color: '#22b8a0', emoji: '🍽️' },
  { category: 'MeetingRoom', label: 'Meeting Room', w: 4, h: 3, color: '#f59e0b', emoji: '📊' },
  { category: 'FallCeiling', label: 'Fall Ceiling', w: 3, h: 3, color: '#94a3b8', emoji: '🔲' },
]

export const catByCategory = (c: string): CatItem | undefined =>
  CATALOG.find((x) => x.category === c)
