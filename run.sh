#!/usr/bin/env bash
# DSource Editor — one-command run.
#
#   ./run.sh          start the dev server (auto-bootstraps on first run,
#                     rebuilds wasm only when Rust sources changed)
#   ./run.sh build    production build (wasm + typecheck + vite build)
#   ./run.sh fresh    force a full wasm rebuild, then start the dev server
#
# Thin wrapper over the Makefile targets (setup / wasm / dev / build) — the
# Makefile stays the source of truth for how each step works; this script
# only decides *which* steps are needed.

set -euo pipefail
cd "$(dirname "$0")"

# Cargo installs to ~/.cargo/bin, which login shells sometimes lack.
export PATH="$HOME/.cargo/bin:$PATH"

say()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── prerequisites ──────────────────────────────────────────────────────────
command -v cargo >/dev/null || die "Rust not found — install via https://rustup.rs"
command -v pnpm  >/dev/null || die "pnpm not found — corepack enable && corepack prepare pnpm@latest --activate (Node 20+)"

if ! rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown \
   || ! command -v wasm-pack >/dev/null; then
  say "First run: installing wasm toolchain + dependencies (make setup)…"
  make setup
fi

[ -d web/node_modules ] || { say "Installing frontend dependencies…"; make install; }

# ── wasm: rebuild only when Rust sources are newer than the bindings ───────
wasm_stale() {
  local out=web/src/wasm/ds_core_bg.wasm
  [ -f "$out" ] || return 0
  [ -n "$(find crates/ds-core/src crates/ds-core/Cargo.toml -newer "$out" 2>/dev/null | head -1)" ]
}

# ── modes ──────────────────────────────────────────────────────────────────
case "${1:-dev}" in
  build)
    make build
    ;;
  fresh)
    make wasm
    say "Starting dev server → http://localhost:5173"
    cd web && exec pnpm dev
    ;;
  dev|*)
    if wasm_stale; then
      say "Rust changed — rebuilding wasm…"
      make wasm
    else
      say "wasm bindings up to date — skipping rebuild"
    fi
    if [ ! -f web/.env.local ]; then
      warn "web/.env.local not found — the AI assistant panel will be disabled."
      warn "  (Create it with LLM_BASE_URL / LLM_API_KEY / LLM_MODEL to enable; never commit it.)"
    fi
    say "Starting dev server → http://localhost:5173"
    cd web && exec pnpm dev
    ;;
esac
