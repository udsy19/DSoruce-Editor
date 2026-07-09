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

import { useEffect, useRef, useState } from 'react'
import { EditorView, type EditorController } from '../App'
import { navigate, useRoute } from './route'
import { ProjectLibrary } from './ProjectLibrary'
import { CreateProject } from './CreateProject'
import { WizardChrome } from './WizardChrome'
import { SpaceStep } from './steps/SpaceStep'
import { ProgramStep } from './steps/ProgramStep'
import { GenerateStep } from './steps/GenerateStep'
import { getProject, type ProjectRecord } from '../persist/projects'

export function AppShell() {
  const route = useRoute()
  const editorRef = useRef<EditorController>(null)
  const editorActive = route.name === 'editor' || route.name === 'wizard'

  // Latch: once the editor has been shown (or is needed behind the Space step)
  // we keep it mounted forever.
  const [editorMounted, setEditorMounted] = useState(editorActive)
  if (editorActive && !editorMounted) setEditorMounted(true)

  // The Space and Program steps own the screen (their own WizardChrome); the
  // editor is mounted behind them (for importFile / loadDrawing / setProgram)
  // but hidden. Only the Generate step (and the plain editor route) show the
  // editor directly.
  const onSpace = route.name === 'wizard' && route.step === 'space'
  const onProgram = route.name === 'wizard' && route.step === 'program'
  const onGenerate = route.name === 'wizard' && route.step === 'generate'
  // The Generate step steers the mounted-behind editor (runGenerate /
  // openCandidate) but shows its own gallery chrome; only the plain editor
  // route shows the editor directly.
  const editorVisible = route.name === 'editor'

  // Whether the Space step has a plate loaded — gates the chrome's Next button
  // (WizardChrome owns Back/Next; the step reports readiness up).
  const [spaceReady, setSpaceReady] = useState(false)
  const [programReady, setProgramReady] = useState(false)

  // The active project (wizard or editor route) — its real identity brands the
  // exports (workflow.md §2). Loaded here and threaded into EditorView so the
  // ExportMenu drops the 'Untitled Plan' placeholder.
  const activePid =
    route.name === 'wizard' || route.name === 'editor' ? route.projectId : undefined
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null)
  useEffect(() => {
    let alive = true
    if (!activePid) {
      setActiveProject(null)
      return
    }
    void getProject(activePid).then((r) => {
      if (alive) setActiveProject(r ?? null)
    })
    return () => {
      alive = false
    }
  }, [activePid])

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
              anchors: rec?.draft?.anchors,
              heal: rec?.draft?.heal?.on ?? true,
              keepExisting: rec?.draft?.keepExisting ?? false,
              silent: true,
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
      {onProgram && (
        <WizardChrome
          current="program"
          title="State the program"
          subtitle="Say what to build — how many of each room type, the desk type and size, and where offices should sit. Start from a template or a headcount, then tune every count in Detailed."
          onBack={() => navigate({ name: 'wizard', projectId: route.projectId, step: 'space' })}
          onNext={() => {
            // Advance to Generate — the GenerateStep authoritatively re-arms the
            // editor (test-fit with area/markers/anchors + the resolved Program)
            // on entry, so there's nothing to prime here.
            navigate({ name: 'wizard', projectId: route.projectId, step: 'generate' })
          }}
          nextLabel="Next: Generate"
          nextTestId="program-next"
          nextDisabled={!programReady}
        >
          <ProgramStep
            key={route.projectId}
            projectId={route.projectId}
            onReadyChange={setProgramReady}
          />
        </WizardChrome>
      )}
      {onGenerate && (
        <WizardChrome
          current="generate"
          title="Pick a test-fit"
          subtitle="The engine generated alternatives against your program. Compare their metrics and category winners, then open one to edit — or head back to adjust the brief."
          onBack={() => navigate({ name: 'wizard', projectId: route.projectId, step: 'program' })}
          hideNext
        >
          <GenerateStep key={route.projectId} projectId={route.projectId} controller={editorRef} />
        </WizardChrome>
      )}
      {editorMounted && (
        // display:contents keeps the wrapper out of layout so `.app` fills
        // #root; display:none hides the whole subtree when inactive.
        <div style={{ display: editorVisible ? 'contents' : 'none' }}>
          <EditorView
            ref={editorRef}
            project={activeProject}
            openPlanId={route.name === 'editor' ? route.planId : undefined}
          />
        </div>
      )}
    </>
  )
}
