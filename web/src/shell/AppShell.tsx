// Top-level view-state machine — design: docs/design/workflow.md §1.
//
// Renders exactly one screen for the current hash route: ProjectLibrary (#/),
// CreateProject (#/new), the Space wizard step (#/p/:pid/space → WizardChrome +
// SpaceStep), or the EditorView (#/p/:pid/{program,generate,f/:planId} and
// #/editor). The EditorView is the whole existing editor (App.tsx); it is
// MOUNTED LAZILY on first entry into any wizard/editor route, then KEPT MOUNTED
// (hidden with display:none, never unmounted) so its async wasm doc, canvas
// transform, parsed drawing, and the window.__ec/__dc seams survive every
// navigation — including the Space step, which steers it through the controller
// (importFile / loadDrawing) instead of remounting it. Landing/library render
// without paying the wasm boot cost.
//
// Program / Generate are S5 / S7; until then those wizard steps fall through to
// the visible EditorView as a forward-compatible stub (the routes already
// exist, so #/p/:pid/program deep-links today and gains its own chrome later).

import { useRef, useState } from 'react'
import { EditorView, type EditorController } from '../App'
import { navigate, useRoute } from './route'
import { ProjectLibrary } from './ProjectLibrary'
import { CreateProject } from './CreateProject'
import { WizardChrome } from './WizardChrome'
import { SpaceStep } from './steps/SpaceStep'
import { getProject } from '../persist/projects'

export function AppShell() {
  const route = useRoute()
  const editorRef = useRef<EditorController>(null)
  const editorActive = route.name === 'editor' || route.name === 'wizard'

  // Latch: once the editor has been shown (or is needed behind the Space step)
  // we keep it mounted forever.
  const [editorMounted, setEditorMounted] = useState(editorActive)
  if (editorActive && !editorMounted) setEditorMounted(true)

  // The Space step owns the screen (its own WizardChrome); the editor is mounted
  // behind it (for importFile / loadDrawing) but hidden. Every other editor
  // route shows the editor directly — including the Program/Generate stubs.
  const onSpace = route.name === 'wizard' && route.step === 'space'
  const editorVisible =
    route.name === 'editor' || (route.name === 'wizard' && route.step !== 'space')

  // Whether the Space step has a plate loaded — gates the chrome's Next button
  // (WizardChrome owns Back/Next; the step reports readiness up).
  const [spaceReady, setSpaceReady] = useState(false)

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
      {onSpace && (
        <WizardChrome
          current="space"
          title="Drop the floor plate"
          subtitle="Upload a CAD floor plan (DXF or DWG). We trace its usable plate, tally its components, and detect the rooms and program before you set the brief."
          onBack={() => navigate({ name: 'projects' })}
          onNext={async () => {
            // Seed the editor's test-fit with the Space step's sub-area + room
            // markers (workflow.md §3.1/§3.2), read fresh off the persisted
            // draft, then advance. testFit is a no-op until a drawing is loaded.
            const rec = await getProject(route.projectId)
            editorRef.current?.testFit({
              areaPolygon: rec?.draft?.areaPolygon,
              markers: rec?.draft?.markers,
            })
            navigate({ name: 'wizard', projectId: route.projectId, step: 'program' })
          }}
          nextLabel="Next: Program"
          nextDisabled={!spaceReady}
        >
          <SpaceStep
            key={route.projectId}
            projectId={route.projectId}
            controller={editorRef}
            onReadyChange={setSpaceReady}
          />
        </WizardChrome>
      )}
      {editorMounted && (
        // display:contents keeps the wrapper out of layout so `.app` fills
        // #root; display:none hides the whole subtree when inactive.
        <div style={{ display: editorVisible ? 'contents' : 'none' }}>
          <EditorView ref={editorRef} />
        </div>
      )}
    </>
  )
}
