// CadStore implementation — an entity list with an id counter and an undo stack.
// See cad/model.ts for the authoritative CadStore contract.

import type { CadEntity, CadStore } from './model'

/** Max undo snapshots retained; oldest are dropped past this. */
const UNDO_CAP = 100

export function createStore(): CadStore {
  const entities: CadEntity[] = []
  const undoStack: CadEntity[][] = []
  let nextId = 1

  const store: CadStore = {
    entities,
    onChange: null,

    add(e, batch = false): CadEntity {
      if (!batch) pushSnapshot()
      const created = { ...e, id: nextId++ } as CadEntity
      entities.push(created)
      fire()
      return created
    },

    update(id, patch): void {
      const target = entities.find((x) => x.id === id)
      if (!target) return
      // Merge patch; id is preserved (patch never carries a conflicting kind
      // in practice — callers patch same-kind fields).
      Object.assign(target, patch, { id })
      fire()
    },

    remove(ids): void {
      const set = new Set(Array.isArray(ids) ? ids : [ids])
      if (set.size === 0) return
      let removed = false
      for (let i = entities.length - 1; i >= 0; i--) {
        if (set.has(entities[i].id)) {
          entities.splice(i, 1)
          removed = true
        }
      }
      if (removed) fire()
    },

    get(id): CadEntity | undefined {
      return entities.find((x) => x.id === id)
    },

    snapshot(): void {
      pushSnapshot()
    },

    undo(): void {
      const prev = undoStack.pop()
      if (!prev) return
      entities.length = 0
      entities.push(...prev)
      // nextId stays monotonic (only ever increments on add), so restored ids
      // can never collide with future ones — no rewind needed.
      fire()
    },

    canUndo(): boolean {
      return undoStack.length > 0
    },

    clear(): void {
      pushSnapshot()
      entities.length = 0
      fire()
    },
  }

  function pushSnapshot(): void {
    undoStack.push(structuredClone(entities))
    if (undoStack.length > UNDO_CAP) undoStack.shift()
  }

  function fire(): void {
    store.onChange?.()
  }

  return store
}
