# DSource Editor — dev tasks
# Requires: rustup + wasm32 target, wasm-pack, pnpm (Node 20+).

.PHONY: wasm install dev build clean setup

# Compile the Rust core to WebAssembly bindings under web/src/wasm.
wasm:
	wasm-pack build crates/ds-core --target web --out-dir ../../web/src/wasm --out-name ds_core

install:
	cd web && pnpm install

# One-shot bootstrap on a fresh machine.
setup:
	rustup target add wasm32-unknown-unknown
	cargo install wasm-pack || true
	$(MAKE) wasm
	$(MAKE) install

# Run the frontend dev server (rebuild wasm first).
dev: wasm
	cd web && pnpm dev

# Production build (typecheck + vite build).
build: wasm
	cd web && pnpm build

clean:
	cargo clean
	rm -rf web/src/wasm web/dist web/node_modules
