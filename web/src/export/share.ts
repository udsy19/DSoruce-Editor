// Shareable web 3D viewer — the export side (deliverable 4).
//
// qbiq hands a client an Autodesk APS link that opens the Revit model in a
// browser. DSource's equivalent is entirely its own stack: the SAME interior
// scene the hero renders are made from (`three/materialTheme.buildInteriorScene`
// — one scene builder, no second theme) is serialized to glTF-binary and PUT on
// the server's share store, and `/share/<id>` opens it in `src/viewer/`.
//
// Why glTF and not the existing `export/obj.ts`: OBJ carries no PBR materials,
// no texture packing and no single-file container — the shared link must open
// with the render palette intact, in one request. The OBJ exporter stays the
// hand-written "give me a mesh for Blender" path; this one is "show my client
// the design in a browser". Both remain, neither duplicates the other.

import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import type { DocState } from '../editor/EditorCanvas'
import { buildInteriorScene, type InteriorSceneOpts } from '../three/materialTheme'
import { triggerDownload } from './png'

/**
 * Scene options for a shared model. The ceiling and the exterior ground are
 * OFF: a share link opens on an orbit ("doll's house") view, and both of those
 * surfaces are opaque lids over exactly the geometry the client came to see —
 * the ceiling from above, the 300 m ground disc from anywhere. Everything else
 * (typed walls, real door openings, perimeter glazing, feature luminaires,
 * palette-calibrated floors) is the render pipeline's scene, unchanged.
 */
export const SHARE_SCENE: InteriorSceneOpts = { ceiling: false, exterior: false }

export interface ShareLink {
  planId: string
  /** Absolute URL of the viewer page. */
  url: string
  /** Size of the published GLB. */
  bytes: number
}

/** Serialize the interior scene for `state` to glTF-binary bytes. */
export async function buildPlanGlb(
  state: DocState,
  opts: InteriorSceneOpts = {},
): Promise<ArrayBuffer> {
  const scene = buildInteriorScene(state, { ...SHARE_SCENE, ...opts })
  try {
    const out = await new GLTFExporter().parseAsync(scene.root, {
      binary: true,
      onlyVisible: true,
      // Canvas-authored maps (parquet, carpet, glazing) are procedural and
      // resample cleanly; 1024 keeps a floorplate's model in the low MBs.
      maxTextureSize: 1024,
    })
    return out as ArrayBuffer
  } finally {
    scene.dispose()
  }
}

/** The viewer page for a published id. */
export function shareUrl(planId: string, origin: string = location.origin): string {
  return `${origin.replace(/\/$/, '')}/share/${planId}`
}

/**
 * Publish `state` as a shareable 3D link: build the GLB, POST it to the share
 * store, and return the URL to hand to a client.
 *
 * Throws when the deployment has no share store (Vercel answers 501 — see
 * deploy/VERCEL.md); callers should offer {@link downloadPlanGlb} instead.
 */
export async function publishShareLink(
  state: DocState,
  opts: {
    name: string
    /** Reuse a specific link id (a re-publish); defaults to a fresh uuid. */
    planId?: string
    /** Origin to publish to + build the URL from. Defaults to the page's. */
    origin?: string
    scene?: InteriorSceneOpts
  },
): Promise<ShareLink> {
  const planId = opts.planId ?? crypto.randomUUID()
  const origin = (opts.origin ?? location.origin).replace(/\/$/, '')
  const glb = await buildPlanGlb(state, opts.scene)
  const res = await fetch(`${origin}/api/share/${planId}?name=${encodeURIComponent(opts.name)}`, {
    method: 'POST',
    body: new Blob([glb], { type: 'model/gltf-binary' }),
  })
  if (!res.ok) {
    const detail = await res
      .json()
      .then((j: { error?: string }) => j?.error ?? '')
      .catch(() => '')
    throw new Error(`Share store unavailable (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  return { planId, url: shareUrl(planId, origin), bytes: glb.byteLength }
}

/** Save the viewer-ready model locally — the fallback when there is no store. */
export async function downloadPlanGlb(
  state: DocState,
  filename = 'dsource-plan.glb',
  opts: InteriorSceneOpts = {},
): Promise<void> {
  const glb = await buildPlanGlb(state, opts)
  triggerDownload(new Blob([glb], { type: 'model/gltf-binary' }), filename)
}
