# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dilla is a federated, end-to-end encrypted Discord alternative. AGPLv3 licensed.

## Architecture

**Monorepo with two language targets:**
- **`server-rs/`** — Rust backend (single binary, axum, SQLite/SQLCipher via rusqlite, tokio-tungstenite WebSocket, webrtc-rs SFU, WebSocket federation transport)
- **`client/src/`** — React 19 + TypeScript frontend (Zustand state, Vite bundler, react-router-dom v7)
- **`client/src-tauri/`** — Rust/Tauri v2 desktop shell (Signal Protocol crypto, Ed25519 key management)

**Communication pattern:** REST for CRUD operations, WebSocket for real-time events (messages, presence, voice signaling, typing indicators). The server embeds the built client via rust-embed.

**Auth:** Ed25519 challenge-response → JWT tokens. No passwords — identity is a keypair.

**E2E encryption:** Signal Protocol (X3DH + Double Ratchet) implemented in Rust, called from React via Tauri IPC. Server sees metadata only.

**Federation:** WebSocket transport between nodes, Lamport clocks for ordering, full state sync. Peers discover each other and replicate messages.

## Build & Dev Commands

### Server (`cd server-rs`)
```bash
cargo build            # Debug build
cargo build --release  # Release build → target/release/dilla-server
cargo run              # Run with debug logging
cargo test             # Run tests
```

### Client (`cd client`)
```bash
npm install
npm run dev          # Vite dev server on http://localhost:8888
npm run build        # Type-check + production bundle
npm run lint         # ESLint
npm run format       # Prettier
npm run tauri dev    # Full desktop app (dev mode)
npm run tauri build  # Desktop installer
```

## Code Style

- **TypeScript:** Prettier (semi, single quotes, 2-space indent, 100 print width, trailing commas). ESLint with typescript-eslint + react-hooks.
- **Rust:** Standard `cargo fmt` / `cargo clippy`.
- **CSS:** Use theme variables from `src/styles/theme.css` — never hardcode colors. BEM-like class naming.
- **Commits:** Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

## Key Server Paths

- Entrypoint: `server-rs/src/main.rs`
- API handlers: `server-rs/src/api/` (mod.rs defines all routes)
- WebSocket hub: `server-rs/src/ws/hub.rs`
- WebSocket client handler: `server-rs/src/ws/client.rs`
- WebSocket events/payloads: `server-rs/src/ws/events.rs`
- Database models/queries: `server-rs/src/db/`
- SQL migrations: `server-rs/src/db/migrations.rs`
- Federation: `server-rs/src/federation/`
- Voice SFU: `server-rs/src/voice/`
- Config (env vars): `server-rs/src/config.rs`
- Auth: `server-rs/src/auth.rs`
- Presence: `server-rs/src/presence.rs`
- Observability (OTel): `server-rs/src/observability/mod.rs`
- Webapp embed: `server-rs/src/webapp/mod.rs`

## Key Client Paths

- Pages: `client/src/pages/` (AppLayout is the main shell)
- Components: `client/src/components/`
- API client: `client/src/services/api.ts`
- WebSocket client: `client/src/services/websocket.ts`
- Zustand stores: `client/src/stores/`
- Signal Protocol crypto: `client/src/services/crypto.ts` → calls Rust in `src-tauri/src/crypto.rs`

## Configuration

All server config via env vars (prefix `DILLA_`) or equivalent CLI flags. See `.env.example`. Key vars: `PORT`, `DATA_DIR`, `DB_PASSPHRASE`, `TLS_CERT`/`TLS_KEY`, `PEERS` (federation), `CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN` (voice relay).
