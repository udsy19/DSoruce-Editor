# Deploying DSource Editor to Vercel

Two deploy targets exist for the same app; they share the API logic:

- **VPS (`deploy/server.ts`)** — one Node service behind Caddy. Full backend
  including DWG conversion + server plan sync. See `deploy/deploy.sh`.
- **Vercel (this doc)** — the SPA on Vercel's CDN + `/api/*` as serverless
  functions. Two backend routes degrade gracefully (see Limitations).

Both back onto **`deploy/apiCore.ts`** — the single, env-agnostic implementation
of `/api/agent`, `/api/claude`, and `/api/bank`. Change a proxy once, both
targets get it. (The dev middlewares in `web/vite.config.ts` remain the dev
source of truth — keep them in lockstep with `apiCore.ts`.)

## What ships

- **Static SPA** — `vercel.json` builds `web/` (`pnpm build`) to `web/dist` and
  serves it, with a SPA fallback rewrite to `index.html`. The Rust→wasm bindings
  in `web/src/wasm/` are **committed** (Vercel has no Rust toolchain), so the
  build needs no `cargo`/`wasm-pack`. After any Rust change, run `make wasm`
  locally and commit the regenerated `web/src/wasm/*` to redeploy.
- **Serverless functions** (`api/*.ts`, Node runtime):
  - `GET/POST /api/agent` — OpenAI-compatible LLM proxy (agent panel, drivers).
  - `GET/POST /api/claude` — Anthropic Messages proxy (designer, evaluator, refine).
  - `GET /api/bank/*` — reverse proxy to the material-bank origin.
  - `/api/dwg` → `503` (see Limitations).
  - `/api/plans/*` → `501` (see Limitations).

## Deploy

1. Import the repo into Vercel. **Keep the Root Directory as the repo root**
   (the default) — `vercel.json` at the root drives the build; do not set it to
   `web/`, or the `api/` functions won't be picked up.
2. Set the environment variables below (Project → Settings → Environment
   Variables), for Production (and Preview if you want).
3. Deploy. Vercel reads `vercel.json`: installs + builds `web/`, publishes
   `web/dist`, and deploys `api/*.ts` as functions.

CLI equivalent: `vercel` (link) then `vercel --prod`.

## Environment variables

| Var | Route | Required? | Default |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `/api/claude` | **Yes** for AI (designer/evaluator/refine) | — (route returns 503 without it) |
| `ANTHROPIC_MODEL` | `/api/claude` | No | `claude-sonnet-5` |
| `LLM_API_KEY` | `/api/agent` | For the OpenAI-compatible agent driver | — (503 without it) |
| `LLM_BASE_URL` | `/api/agent` | No | `https://api.openai.com/v1` |
| `LLM_MODEL` | `/api/agent` | No | `gpt-4o-mini` |
| `BANK_UPSTREAM` | `/api/bank` | No | `https://46.202.179.28.sslip.io` |

Never commit keys — set them in Vercel. (Local dev reads `web/.env.local`.)

## Limitations on Vercel (vs the VPS)

- **DWG import** — `/api/dwg` needs the LibreDWG `dwg2dxf` native binary, which
  can't run in Vercel's sandbox, so it returns **503**. **DXF import is fully
  client-side and works.** The frontend surfaces the 503 as an import error; it
  does not crash. For DWG, use the VPS deploy (host with LibreDWG installed).
- **Cross-device plan sync** — `/api/plans` writes local disk, which Vercel's
  serverless filesystem doesn't persist, so it returns **501**. The plan library
  is primarily **IndexedDB (in-browser)** and works fully; `syncPlans()` treats
  the 501 as "offline" and leaves local data intact. For sync, use the VPS
  deploy, or back `api/plans/[[...path]].ts` with a durable store (Vercel
  Blob/KV).
- **Function duration** — `vercel.json` sets `maxDuration: 60`. On the Hobby
  plan the ceiling is 60s; long Claude calls (the multi-objective designer) are
  fine within that but a very large batch could approach it.
