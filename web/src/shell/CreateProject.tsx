// The "Property" STEP BODY — design: docs/design/ui-system.md §2.3.
// Captures the fields that flow straight into the exporters (ReportMeta /
// TakeoffOptions): project name, property name, address, initial floor, and a
// client logo (stored as a data: URL → report cover). On submit it mints a
// ProjectRecord (whose id doubles as the SavedPlan.projectId for this project's
// floors) and hands it back to the shell to open the editor.
//
// This renders the FORM ONLY. It used to draw its own full-screen chrome, which
// is why "Property" appeared in the stepper as a step the user was never shown
// as one — permanently pre-ticked, for a screen with no stepper on it. The shell
// now wraps this in WizardChrome like every other step, and the chrome's Next
// submits the form through the HTML `form=` attribute, so no state is lifted.

import { useEffect, useState } from 'react'
import { createProject, type ProjectRecord } from '../persist/projects'
import { Icon } from '../ui/icons'

/** The chrome's Next targets this form by id (HTML form-owner attribute). */
export const CREATE_FORM_ID = 'create-project-form'

export function CreateProject({
  onCreated,
  onReadyChange,
}: {
  onCreated: (p: ProjectRecord) => void
  /** Reports whether the required fields are filled, so the chrome can disable
   *  Next WITH A REASON instead of letting a native validation bubble be the
   *  first the user hears of it. */
  onReadyChange?: (ready: boolean) => void
}) {
  const [name, setName] = useState('')
  const [propertyName, setPropertyName] = useState('')
  const [address, setAddress] = useState('')
  const [floor, setFloor] = useState('')
  const [logo, setLogo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const ready = propertyName.trim().length > 0
  useEffect(() => onReadyChange?.(ready), [ready, onReadyChange])

  const onLogo = (file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setLogo(typeof reader.result === 'string' ? reader.result : null)
    reader.readAsDataURL(file)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const rec = await createProject({
        name: name.trim() || 'Untitled Project',
        propertyName: propertyName.trim(),
        address: address.trim() || undefined,
        floor: floor.trim() || undefined,
        logo: logo ?? undefined,
      })
      onCreated(rec)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="create-step">
      <div className="create-wrap">
        <form
          id={CREATE_FORM_ID}
          className="create-form"
          data-testid="create-project-form"
          onSubmit={submit}
        >
          <label className="create-field">
            <span className="field-label">Project name</span>
            <input
              className="field-input"
              data-testid="create-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Q3 Tenant Fit-out"
              autoFocus
            />
          </label>

          <label className="create-field">
            {/* The one required field — said out loud, not discovered via a
                native validation bubble on submit. */}
            <span className="field-label">
              Property name <span className="field-required">required</span>
            </span>
            <input
              className="field-input"
              data-testid="create-property"
              value={propertyName}
              onChange={(e) => setPropertyName(e.target.value)}
              placeholder="One Prestige Tower"
              required
            />
          </label>

          <label className="create-field">
            <span className="field-label">Address</span>
            <input
              className="field-input"
              data-testid="create-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="12 MG Road, Bengaluru 560001"
            />
          </label>

          <label className="create-field">
            <span className="field-label">Floor</span>
            <input
              className="field-input"
              data-testid="create-floor"
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
              placeholder="L14"
            />
          </label>

          <div className="create-field">
            <span className="field-label">Client logo</span>
            <label className="create-logo" data-testid="create-logo">
              {logo ? (
                <img className="create-logo-preview" src={logo} alt="Client logo preview" />
              ) : (
                <span className="create-logo-drop">
                  <Icon name="upload" size={16} /> Upload a logo
                </span>
              )}
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => onLogo(e.target.files?.[0])}
              />
            </label>
          </div>

        </form>
      </div>
    </div>
  )
}
