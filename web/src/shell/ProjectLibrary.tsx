// Full-screen landing + project library — design: docs/design/workflow.md §1
// (step 1, "Projects / Landing"). Lists first-class ProjectRecords from the
// `projects` store (including in-progress projects with zero floors) and folds
// in each project's floor count derived from saved plans (their
// SavedPlan.projectId === ProjectRecord.id, so grouping reconciles).

import { useEffect, useState } from 'react'
import { listProjects, deleteProject, type ProjectRecord } from '../persist/projects'
import { listPlans } from '../persist/plans'
import { Icon } from '../ui/icons'

export function ProjectLibrary({
  onNew,
  onOpen,
}: {
  onNew: () => void
  onOpen: (p: ProjectRecord) => void
}) {
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [floors, setFloors] = useState<Record<string, number>>({})

  const refresh = async () => {
    const [recs, plans] = await Promise.all([listProjects(), listPlans()])
    const counts: Record<string, number> = {}
    for (const p of plans) if (p.projectId) counts[p.projectId] = (counts[p.projectId] ?? 0) + 1
    setProjects(recs)
    setFloors(counts)
  }
  useEffect(() => {
    void refresh()
  }, [])

  return (
    <div className="studio" data-testid="project-library">
      <header className="studio-top">
        <div className="studio-brand">
          <span className="brand-mark" aria-hidden />
          <span className="studio-wordmark">DSOURCE STUDIO</span>
        </div>
        <button className="studio-start" onClick={onNew} data-testid="project-new">
          <Icon name="generate" size={15} /> Start a project
        </button>
      </header>

      <div className="studio-hero">
        <h1 className="studio-headline">
          A floor plate in.
          <br />
          A priced, buildable plan out.
        </h1>
        <p className="studio-sub">
          Upload a plate, set the program, and let the autonomous engine generate a regulation-aware,
          costed test-fit — in 2D and 3D.
        </p>
      </div>

      <div className="studio-library">
        <div className="studio-library-head">
          <span className="panel-eyebrow">Your projects</span>
          <span className="num muted">{projects.length}</span>
        </div>

        {projects.length === 0 ? (
          <div className="studio-empty" data-testid="project-library-empty">
            <span className="empty-glyph" aria-hidden>
              <Icon name="upload" size={24} />
            </span>
            <p className="studio-empty-lead">No projects yet.</p>
            <button className="empty-btn primary" onClick={onNew}>
              <Icon name="generate" size={15} /> Start a project
            </button>
          </div>
        ) : (
          <div className="studio-grid">
            {projects.map((p) => (
              <button
                key={p.id}
                className="project-card"
                data-testid="project-card"
                onClick={() => onOpen(p)}
              >
                <div className="project-card-logo" aria-hidden>
                  {p.logo ? <img src={p.logo} alt="" /> : <span className="project-card-initial">{initial(p)}</span>}
                </div>
                <div className="project-card-body">
                  <div className="project-card-name">{p.name}</div>
                  <div className="project-card-prop">{p.propertyName}</div>
                  {p.address && <div className="project-card-addr">{p.address}</div>}
                </div>
                <div className="project-card-foot">
                  <span className="project-card-floor">{p.floor ? p.floor : 'Floor —'}</span>
                  <span className="num muted">
                    {floors[p.id] ?? 0} floor{(floors[p.id] ?? 0) === 1 ? '' : 's'}
                  </span>
                  <span
                    className="project-card-del"
                    role="button"
                    tabIndex={0}
                    aria-label={`Delete ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (window.confirm(`Delete project "${p.name}"? Its saved floors are kept.`))
                        void deleteProject(p.id).then(refresh)
                    }}
                  >
                    <Icon name="close" size={13} />
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function initial(p: ProjectRecord): string {
  const s = (p.name || p.propertyName || '?').trim()
  return s ? s[0].toUpperCase() : '?'
}
