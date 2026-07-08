#!/usr/bin/env bash
# Idempotent deploy of DSource Editor to the VPS. Run FROM the repo root:
#   ./deploy/deploy.sh
#
# Builds the SPA + server bundle locally, rsyncs to /opt/dsource, installs the
# systemd unit, appends the Caddy site once, restarts the service, smoke-tests.
# The remote env file (/opt/dsource/env — holds LLM_API_KEY/ANTHROPIC_API_KEY)
# is created only if absent and NEVER overwritten or echoed.
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root, wherever this is invoked from

VPS=root@46.202.179.28
APP_HOST=app.46.202.179.28.sslip.io

echo "==> [1/7] Building wasm + SPA"
export PATH="$HOME/.cargo/bin:$PATH"
make wasm
(cd web && pnpm build)

echo "==> [2/7] Bundling server"
(cd deploy && npm install --no-audit --no-fund && npm run bundle)

echo "==> [3/7] Rsync dist + server + unit"
ssh "$VPS" 'mkdir -p /opt/dsource/dist'
rsync -az --delete web/dist/ "$VPS:/opt/dsource/dist/"
rsync -az deploy/dist-server/server.mjs "$VPS:/opt/dsource/server.mjs"
rsync -az deploy/dsource-api.service "$VPS:/etc/systemd/system/dsource-api.service"

echo "==> [4/7] Env file (create-once, never overwrite)"
if ssh "$VPS" '[ -e /opt/dsource/env ]'; then
  echo "    /opt/dsource/env already exists — left untouched."
else
  if [ -f web/.env.local ]; then
    # Copy only KEY=VALUE lines; values never pass through echo/set -x.
    grep -E '^[A-Za-z_][A-Za-z0-9_]*=' web/.env.local \
      | ssh "$VPS" 'umask 077; cat > /opt/dsource/env'
    echo "    Created /opt/dsource/env from web/.env.local keys."
  else
    ssh "$VPS" 'umask 077; : > /opt/dsource/env'
    echo "    No web/.env.local — created an EMPTY /opt/dsource/env."
  fi
  echo "    REVIEW IT ON THE VPS: it should hold LLM_API_KEY / ANTHROPIC_API_KEY"
  echo "    (and optionally LLM_BASE_URL/LLM_MODEL/ANTHROPIC_MODEL/DWG2DXF_BIN)."
fi

echo "==> [5/7] Caddy site (append once; existing bank site untouched)"
if ssh "$VPS" "grep -q '$APP_HOST' /etc/caddy/Caddyfile"; then
  echo "    $APP_HOST already in Caddyfile — skipping."
else
  ssh "$VPS" 'cat >> /etc/caddy/Caddyfile' < deploy/Caddyfile.snippet
  echo "    Appended site block for $APP_HOST."
fi

echo "==> [6/7] Enable + restart service, reload Caddy"
ssh "$VPS" <<'REMOTE'
set -euo pipefail
systemctl daemon-reload
systemctl enable --now dsource-api
systemctl restart dsource-api
systemctl reload caddy
REMOTE

echo "==> [7/7] Smoke checks"
sleep 2
curl -fsS -o /dev/null -w "    GET /            -> %{http_code}\n" "https://$APP_HOST/"
printf "    GET /api/claude  -> %s\n" "$(curl -fsS "https://$APP_HOST/api/claude")"
printf "    GET /api/plans   -> %s\n" "$(curl -fsS "https://$APP_HOST/api/plans" | head -c 200)"
echo "==> Deployed: https://$APP_HOST/"
