/// <reference types="vite/client" />

// Cloud plan sync config (docs/design/cloud-sync.md). All optional: with none
// set, `cloudEnabled()` is false and the app runs local-only (the default).
interface ImportMetaEnv {
  /** '1' turns the opt-in cloud sync UI on. Anything else = off (default). */
  readonly VITE_CLOUD_SYNC?: string
  /** Supabase project URL, e.g. https://<ref>.supabase.co */
  readonly VITE_SUPABASE_URL?: string
  /** Supabase publishable/anon key — browser-safe, gated by RLS. */
  readonly VITE_SUPABASE_ANON_KEY?: string
}
