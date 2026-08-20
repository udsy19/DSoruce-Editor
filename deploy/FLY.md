# Deploying DSource Studio to Fly.io

One Node service — the SPA plus every `/api` route — on one machine with one
volume. `deploy/server.ts` already was the whole backend; Fly runs it as-is.

There are **three things that must exist before the first `fly deploy`**, and
each one fails in a way that does not obviously point at itself. They are §1–§3.

---

## 1. The volume — or plans, shares and packs vanish on every deploy

A machine's root filesystem is ephemeral. `PLANS_DIR`, the published share
bundles and the deliverable packs all write to `/data`, which must be a volume:

```bash
fly volumes create dsource_data --region bom --size 3
```

**A Fly volume attaches to one machine and is not shared.** `fly.toml` therefore
pins this app to a single machine. Adding a second would give it its own empty
volume, and plans would appear and disappear depending on which machine answered
— an intermittent data-loss bug that looks like a caching problem.

That is a deliberate configuration, not a limitation to route around. Horizontal
scale requires moving those three stores off local disk first: `/api/plans` is
already superseded by Supabase (`web/src/cloud/supabaseProvider.ts`), and
share/pack want object storage. Until that lands, one machine is correct.

## 2. Secrets — or the app boots and every AI call 503s

```bash
fly secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  SUPABASE_URL=https://<project>.supabase.co \
  SUPABASE_ANON_KEY=<publishable key> \
  BANK_UPSTREAM=https://<material-bank-host>
```

| Secret | Without it |
|---|---|
| `ANTHROPIC_API_KEY` | `/api/claude` → 503. Designer, evaluator and refine all go dark. |
| `SUPABASE_URL` + `SUPABASE_ANON_KEY` | **The guard drops to `off`** — see §3. |
| `BANK_UPSTREAM` | `/api/bank` proxies to the default host in `apiCore.ts`. |
| `LLM_API_KEY` | Optional. Only if the OpenAI-compatible `/api/agent` driver ships. |

The anon key is designed to reach browsers and is not a secret; it lives here so
each deployment points at its own project, not to hide it.

## 3. Do not set `API_AUTH`

`apiCore.guard()` fails closed: with `SUPABASE_URL` configured, auth is
**required** unless explicitly disabled. Leaving `API_AUTH` unset is the safe
state — which is why `fly.toml` does not set it.

`API_AUTH=off` opens `/api/claude` and `/api/agent` to the internet on your
Anthropic key, with no identity, no quota and no origin check. The process logs
a warning when it is off; nothing else will stop you.

**Verify after the first deploy** — this is the single check worth running by
hand, because the failure is silent and expensive:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{}' \
  https://dsource-studio.fly.dev/api/claude
# 401 = guarded.  200 = OPEN — stop and fix before anything else.
```

Set a hard monthly spend cap in the Anthropic console regardless. It is the only
control that does not depend on this code being correct.

---

## Deploy

```bash
fly deploy --build-arg GIT_SHA=$(git rev-parse HEAD)
```

**Pass `GIT_SHA`.** `.git` is excluded from the build context, so without it the
SPA's build-provenance meta tag and `/api/health` both report `unknown`, and a
served bundle cannot be traced to a commit.

**After any Rust change, `make wasm` and commit the bindings first.** The image
builds no Rust — `web/src/wasm/` is committed on purpose — so a deploy without
that step ships the previous core against the new source, and every test still
passes because they run against the source, not the image.

Run the battery before deploying; it is not run inside the image:

```bash
bash scripts/verify-all.sh --full   # expect 62/62, nothing skipped
```

## Verify a deploy landed

```bash
curl -s https://dsource-studio.fly.dev/api/health
# {"ok":true,"revision":"<sha>","uptime_s":N}
```

`revision` should equal the SHA you passed. If it says `unknown`, the build arg
was missed. If it is the *previous* SHA, you are talking to a machine that has
not rolled yet — Fly's health check has a 10s grace period.

## Region

`primary_region = "bom"` (Mumbai). The users, the material bank and any
India-residency requirement all point there.

**Egress is the one Fly cost line to watch: $0.12/GB in India, six times its
US/EU rate.** This app ships a ~2.8 MB bundle (cached hard after first load) and
~5 MB GLBs per published share link, so egress scales with *share views*, not
with users. If that becomes the bill, move the GLBs to object storage with free
egress — `deploy/shareStore.ts` is the whole contract, three functions.

## Operational notes

- **Graceful shutdown** is handled: `SIGTERM` drains in-flight requests, with a
  25 s backstop. Deploys should not truncate responses.
- **`auto_stop_machines`** lets the machine sleep when idle, but
  `min_machines_running = 1` keeps one warm — a cold start on the first request
  of a live client demo is a bad first impression, and this product gets demoed
  live.
- **LibreDWG** (`dwg2dxf` + `dwgread`) is installed in the image, and the build
  **fails** if either binary is missing. DWG import works here, unlike on Vercel.
- **`ALLOWED_ORIGINS`** must track the domain. On a custom domain, update it or
  the app will 403 its own frontend. It is defence in depth — an Origin header is
  trivially forged outside a browser — never the gate.

## Not yet wired

Honest list, so none of it is discovered in production:

- **No error tracking.** No Sentry, no PostHog, nothing. A browser-heavy app
  whose hardest failure mode is *the client's GPU* gives you no visibility into
  it unless you instrument for it.
- **No custom SMTP.** Auth is magic-link; Supabase's built-in sender is capped at
  **2 emails/hour project-wide** and is not for production. A three-person demo
  fails. Wire Resend/Postmark into Supabase Auth → SMTP before real users.
- **No migration has been applied to any database.** `supabase/migrations/`
  0001–0008 exist and are tested against a real Postgres; none has been run
  against a live project. Diff against the real schema before applying.
- **No org sets a budget.** `org_budgets` is enforced and tested, but every org
  is uncapped until an admin writes a row.
