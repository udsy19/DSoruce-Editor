# DSource Studio — one Node service serving the SPA and every /api route.
#
# WHY A SINGLE IMAGE. `deploy/server.ts` already is the whole backend: static
# SPA, the guarded LLM proxies, the bank reverse-proxy, DWG conversion, and the
# plan/share/pack stores. That maps onto one Fly machine with no decomposition,
# which is the main reason Fly fits this app — there is nothing here to split.
#
# The Rust core is NOT built here. `web/src/wasm/` is committed precisely so a
# deploy needs no Rust toolchain (same reason Vercel builds work). If you change
# any Rust, run `make wasm` and commit the regenerated bindings BEFORE deploying,
# or this image ships the previous core against the new source.

# ── stage 1: build the SPA and bundle the server ─────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /src

RUN corepack enable

# Manifests first so a source-only change does not re-resolve the dependency
# graph. web/ and deploy/ are separate installs — deploy/ needs only esbuild.
#
# The root package.json comes too, and only for its `packageManager` pin:
# corepack resolves pnpm by walking up from the cwd, and `web/` has no pin of its
# own. Without this the image builds with whatever pnpm corepack defaults to,
# against a lockfile written by 9.12 — and `--frozen-lockfile` turns that
# mismatch into a build failure that reads like a dependency problem.
COPY package.json ./
COPY web/package.json web/pnpm-lock.yaml ./web/
RUN cd web && pnpm install --frozen-lockfile
COPY deploy/package.json deploy/package-lock.json ./deploy/
RUN cd deploy && npm ci --no-audit --no-fund

COPY . .

# The commit this image was built from. `.git` is excluded from the build
# context, so without this the SPA's build-provenance meta tag stamps 'unknown'
# and a served bundle cannot be traced to a commit — the exact thing that stamp
# exists to prevent. Passed through to the runtime too, so /api/health reports
# the same value the HTML does.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

# `pnpm build` runs `tsc --noEmit` first, so a type error fails the IMAGE rather
# than shipping and failing at runtime. That is deliberate: the build is the last
# gate before a machine starts serving.
RUN cd web && pnpm build
RUN cd deploy && npm run bundle

# ── stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# LibreDWG is the ONE native dependency, and it is why this is a Debian image
# rather than Alpine — `libredwg-tools` is packaged for Debian and musl builds of
# it are a yak shave with no payoff here.
#
# It provides BOTH binaries the DWG path needs: `dwg2dxf` (primary) and
# `dwgread` (the `-O JSON` fallback origin/main added for files dwg2dxf cannot
# finish). Installing only the first would leave that fallback dead — and it
# would fail as a spawn error at request time, not at build time.
#
# `ca-certificates` is required for outbound HTTPS to api.anthropic.com and
# Supabase; the slim image omits it, and without it every model call fails TLS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libredwg-tools ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # Fail the BUILD if either binary is missing, rather than discovering it when a
 # user uploads a drawing. A package rename upstream should break the image, not
 # the product.
 && command -v dwg2dxf >/dev/null || (echo "dwg2dxf missing from libredwg-tools" && exit 1) \
 && command -v dwgread >/dev/null || (echo "dwgread missing from libredwg-tools" && exit 1)

# Only the two build outputs. No node_modules: the server is a single bundled
# .mjs with no runtime dependencies, which is what `npm run bundle` produces.
COPY --from=build /src/web/dist ./dist
COPY --from=build /src/deploy/dist-server/server.mjs ./server.mjs

ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

# Defaults that make the container correct on its own. HOST is the important
# one: the server defaults to 127.0.0.1, which is right for a VPS behind Caddy
# and unreachable in a container. Overridable by fly.toml [env] / `fly secrets`.
ENV HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/dist \
    PLANS_DIR=/data/plans \
    PACK_OUT_DIR=/data/out

# Written to on first request; created here so a machine with no volume attached
# still starts and serves everything except durable storage, instead of crashing
# on an ENOENT the health check cannot explain.
RUN mkdir -p /data/plans /data/out && chown -R node:node /data

# Drop root. The server binds 8080, so no privileged port is needed.
USER node
EXPOSE 8080

# Node handles SIGTERM itself — see the drain handler in deploy/server.ts. Using
# the exec form (no shell) is what lets that signal reach node as PID 1 instead
# of being swallowed by /bin/sh.
CMD ["node", "server.mjs"]
