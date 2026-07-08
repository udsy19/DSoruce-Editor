// Hash-route model for the AppShell view-state machine — design:
// docs/design/workflow.md §1. NO router dependency: the shell keeps one big,
// expensive, always-mounted EditorView alive across navigation, which any
// mount/unmount router would tear down (losing the wasm doc + the window.__ec
// seam tests depend on). Hash routing is static-host-safe (no server routes).

import { useSyncExternalStore } from 'react'

export type WizardStep = 'space' | 'program' | 'generate'

export type Route =
  | { name: 'projects' } //                         #/                     landing + library
  | { name: 'create' } //                           #/new                  create-project form
  | { name: 'wizard'; projectId: string; step: WizardStep } // #/p/:pid/space|program|generate
  | { name: 'editor'; projectId?: string; planId?: string } // #/p/:pid/f/:planId | #/editor (dev)

const WIZARD_STEPS: readonly WizardStep[] = ['space', 'program', 'generate']

/** Parse `location.hash` into a Route. '' / '#' / '#/' → projects. */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (path === '') return { name: 'projects' }
  if (path === 'new') return { name: 'create' }
  if (path === 'editor') return { name: 'editor' }
  const seg = path.split('/')
  if (seg[0] === 'p' && seg[1]) {
    const projectId = decodeURIComponent(seg[1])
    // #/p/:pid/f/:planId — a saved floor opens straight in the editor.
    if (seg[2] === 'f' && seg[3]) return { name: 'editor', projectId, planId: decodeURIComponent(seg[3]) }
    // #/p/:pid/space|program|generate — a wizard step under a project.
    const step = seg[2] as WizardStep | undefined
    if (step && WIZARD_STEPS.includes(step)) return { name: 'wizard', projectId, step }
    // #/p/:pid — bare project id enters the wizard at its first step.
    return { name: 'wizard', projectId, step: 'space' }
  }
  return { name: 'projects' }
}

/** Format a Route into a `#/…` hash. */
export function toHash(r: Route): string {
  switch (r.name) {
    case 'projects':
      return '#/'
    case 'create':
      return '#/new'
    case 'wizard':
      return `#/p/${encodeURIComponent(r.projectId)}/${r.step}`
    case 'editor':
      if (r.projectId && r.planId) return `#/p/${encodeURIComponent(r.projectId)}/f/${encodeURIComponent(r.planId)}`
      return '#/editor'
  }
}

// --- subscribe hook -------------------------------------------------------
// One shared external store over location.hash; components read it with
// useRoute() and steer it with navigate(). pushState keeps the back button
// working; the popstate listener re-parses on browser nav.

function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb)
  window.addEventListener('hashchange', cb)
  return () => {
    window.removeEventListener('popstate', cb)
    window.removeEventListener('hashchange', cb)
  }
}

function snapshot(): string {
  return window.location.hash
}

/** Reactive current Route. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, () => '')
  return parseHash(hash)
}

/** Navigate to a Route (pushes history + fires hashchange for subscribers). */
export function navigate(r: Route): void {
  const hash = toHash(r)
  if (window.location.hash !== hash) window.location.hash = hash
}
