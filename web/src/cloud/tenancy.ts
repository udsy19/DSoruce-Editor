// Tenancy — organisations, roles, projects and per-project grants.
// Schema + policies: supabase/migrations/0002_tenancy.sql (behaviour asserted by
// supabase/tests/rls.sql, 28 checks against a real Postgres).
//
// This module is a thin, typed reader over tables whose ACCESS CONTROL LIVES IN
// THE DATABASE. Nothing here filters by organisation, and nothing here should
// start to: every query below is already scoped by row-level security, so a
// client-side `.eq('org_id', …)` would be a second, weaker copy of a rule the
// server already enforces — and the copy is the one that drifts. If a query
// returns fewer rows than you expect, the answer is a policy, not a filter.
//
// Inert when cloud is disabled: `getClient()` returns null and every call here
// returns an empty result rather than throwing, matching the contract the rest
// of `cloud/` keeps.

import { getClient } from './client'

/** Ascending privilege. Mirrors the Postgres enum `public.org_role` exactly —
 *  the database compares these with `>=`, so ORDER IS SEMANTIC, not cosmetic. */
export const ROLES = ['viewer', 'reviewer', 'designer', 'admin', 'owner'] as const
export type Role = (typeof ROLES)[number]

/** Rank for client-side gating of UI affordances. This is a CONVENIENCE, never
 *  an authorization decision — hiding a button is not access control, and the
 *  database refuses the write regardless of what the UI chose to render. */
export function atLeast(role: Role | null, min: Role): boolean {
  if (!role) return false
  return ROLES.indexOf(role) >= ROLES.indexOf(min)
}

export interface Organisation {
  id: string
  name: string
  slug: string
  createdAt: string
}

export interface OrgMember {
  orgId: string
  userId: string
  role: Role
  createdAt: string
}

/** A client engagement. Mirrors the local `ProjectRecord` (persist/projects.ts),
 *  minus the draft/chosenPlan bookkeeping, which stays device-local. */
export interface Project {
  id: string
  orgId: string
  name: string
  propertyName: string
  address: string | null
  /** Object-store URL. Deliberately NOT the local record's inlined data: URL —
   *  base64 in a row is what makes plan-sync egress unbounded. */
  logoUrl: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

/** Organisations the signed-in user belongs to. RLS returns only those. */
export async function listOrganisations(): Promise<Organisation[]> {
  const client = getClient()
  if (!client) return []
  const { data, error } = await client
    .from('organisations')
    .select('id,name,slug,created_at')
    .order('name')
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id, name: r.name, slug: r.slug, createdAt: r.created_at,
  }))
}

/** Create an organisation. A trigger makes the caller its owner in the same
 *  statement, so there is no window where the row exists un-owned and no second
 *  round trip that could fail halfway. */
export async function createOrganisation(name: string, slug: string): Promise<Organisation> {
  const client = getClient()
  if (!client) throw new Error('Cloud sync is disabled')
  const { data, error } = await client
    .from('organisations')
    .insert({ name, slug })
    .select('id,name,slug,created_at')
    .single()
  if (error) throw error
  return { id: data.id, name: data.name, slug: data.slug, createdAt: data.created_at }
}

/** The caller's role in one organisation, or null if they are not a member. */
export async function myRole(orgId: string): Promise<Role | null> {
  const client = getClient()
  if (!client) return null
  const { data } = await client.auth.getUser()
  const uid = data.user?.id
  if (!uid) return null
  const { data: row, error } = await client
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', uid)
    .maybeSingle()
  if (error) throw error
  return (row?.role as Role) ?? null
}

/** The roster. Visible to any member; only admin+ may change it (enforced by RLS). */
export async function listMembers(orgId: string): Promise<OrgMember[]> {
  const client = getClient()
  if (!client) return []
  const { data, error } = await client
    .from('org_members')
    .select('org_id,user_id,role,created_at')
    .eq('org_id', orgId)
  if (error) throw error
  return (data ?? []).map((r) => ({
    orgId: r.org_id, userId: r.user_id, role: r.role as Role, createdAt: r.created_at,
  }))
}

/** Projects the caller can reach — org membership OR a direct project grant.
 *  The union is resolved server-side by `project_role_of`, which is why this
 *  takes no orgId: an external client contact belongs to no organisation at all
 *  and must still see the one project they were granted. */
export async function listProjects(): Promise<Project[]> {
  const client = getClient()
  if (!client) return []
  const { data, error } = await client
    .from('projects')
    .select('id,org_id,name,property_name,address,logo_url,created_at,updated_at,archived_at')
    .is('archived_at', null)
    .order('updated_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    propertyName: r.property_name,
    address: r.address,
    logoUrl: r.logo_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  }))
}

/** Resolve the caller's home organisation, creating a personal one on first use.
 *
 *  Delegates to the `ensure_personal_org()` RPC rather than doing select-then-
 *  insert here: two tabs signing in at once would race, and the rule would have
 *  to be reimplemented identically by every future client. The function is
 *  idempotent and an invited member adopts the org they were invited to instead
 *  of accumulating an empty personal one. See migration 0003. */
export async function ensurePersonalOrg(): Promise<string | null> {
  const client = getClient()
  if (!client) return null
  const { data, error } = await client.rpc('ensure_personal_org')
  if (error) throw error
  return (data as string) ?? null
}

/** Mirror a local `ProjectRecord` into the cloud.
 *
 *  Must run BEFORE any plan that references the project: `plans.project_id` is
 *  half of a composite foreign key onto `projects (id, org_id)` (migration 0004),
 *  so pushing a plan first fails outright rather than dangling.
 *
 *  `logo` is deliberately NOT carried. Locally it is an inlined `data:` URL; the
 *  column is `logo_url` and wants an object-store reference. Writing base64 into
 *  a Postgres row is exactly what makes sync egress unbounded, so the logo waits
 *  for the object store rather than being smuggled across in the wrong shape. */
export async function pushProject(rec: {
  id: string
  name: string
  propertyName: string
  address?: string
  createdAt: string
  updatedAt: string
}, orgId: string): Promise<void> {
  const client = getClient()
  if (!client) throw new Error('Cloud sync is disabled')
  const { error } = await client.from('projects').upsert(
    {
      id: rec.id,
      org_id: orgId,
      name: rec.name,
      property_name: rec.propertyName ?? '',
      address: rec.address ?? null,
      created_at: rec.createdAt,
      updated_at: rec.updatedAt,
    },
    { onConflict: 'id' },
  )
  if (error) throw error
}

/** The organisation a project belongs to, or null if it is not reachable. */
export async function orgOfProject(projectId: string): Promise<string | null> {
  const client = getClient()
  if (!client) return null
  const { data, error } = await client
    .from('projects')
    .select('org_id')
    .eq('id', projectId)
    .maybeSingle()
  if (error) throw error
  return data?.org_id ?? null
}

/** Grant an external user (a client contact) access to ONE project. */
export async function grantProjectAccess(
  projectId: string,
  userId: string,
  role: Role = 'viewer',
): Promise<void> {
  const client = getClient()
  if (!client) throw new Error('Cloud sync is disabled')
  const { error } = await client
    .from('project_grants')
    .upsert({ project_id: projectId, user_id: userId, role }, { onConflict: 'project_id,user_id' })
  if (error) throw error
}
