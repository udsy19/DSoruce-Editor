// Top-level view-state machine — design: docs/design/workflow.md §1.
//
// Renders exactly one screen for the current hash route: ProjectLibrary (#/),
// CreateProject (#/new), or the EditorView (#/p/:pid/… and #/editor). The
// EditorView is the whole existing editor (App.tsx); it is MOUNTED LAZILY on
// first entry into any wizard/editor route, then KEPT MOUNTED (hidden with
// display:none, never unmounted) so its async wasm doc, canvas transform,
// parsed drawing, and the window.__ec/__dc seams survive every navigation.
// Landing/library render without paying the wasm boot cost.

import { useRef, useState } from 'react'
import { EditorView, type EditorController } from '../App'
import { navigate, useRoute } from './route'
import { ProjectLibrary } from './ProjectLibrary'
import { CreateProject } from './CreateProject'

export function AppShell() {
  const route = useRoute()
  const editorRef = useRef<EditorController>(null)
  const editorActive = route.name === 'editor' || route.name === 'wizard'

  // Latch: once the editor has been shown we keep it mounted forever.
  const [editorMounted, setEditorMounted] = useState(editorActive)
  if (editorActive && !editorMounted) setEditorMounted(true)

  return (
    <>
      {route.name === 'projects' && (
        <ProjectLibrary
          onNew={() => navigate({ name: 'create' })}
          onOpen={(p) => navigate({ name: 'wizard', projectId: p.id, step: 'space' })}
        />
      )}
      {route.name === 'create' && (
        <CreateProject
          onCancel={() => navigate({ name: 'projects' })}
          onCreated={(p) => navigate({ name: 'wizard', projectId: p.id, step: 'space' })}
        />
      )}
      {editorMounted && (
        // display:contents keeps the wrapper out of layout so `.app` fills
        // #root; display:none hides the whole subtree when inactive.
        <div style={{ display: editorActive ? 'contents' : 'none' }}>
          <EditorView ref={editorRef} />
        </div>
      )}
    </>
  )
}
