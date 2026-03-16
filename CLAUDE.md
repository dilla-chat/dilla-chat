# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dilla is a federated, end-to-end encrypted Discord alternative. AGPLv3 licensed.

## Architecture

**Monorepo with three language targets:**
- **`server/`** — Go 1.24 backend (single binary, SQLite/SQLCipher, gorilla/websocket, Pion WebRTC SFU, Hashicorp Memberlist federation)
- **`client/src/`** — React 19 + TypeScript frontend (Zustand state, Vite bundler, react-router-dom v7)
- **`client/src-tauri/`** — Rust/Tauri v2 desktop shell (Signal Protocol crypto, Ed25519 key management)

**Communication pattern:** REST for CRUD operations, WebSocket for real-time events (messages, presence, voice signaling, typing indicators). The server embeds the built client via `internal/webapp/`.

**Auth:** Ed25519 challenge-response → JWT tokens. No passwords — identity is a keypair.

**E2E encryption:** Signal Protocol (X3DH + Double Ratchet) implemented in Rust, called from React via Tauri IPC. Server sees metadata only.

**Federation:** SWIM gossip protocol via Memberlist. Peers discover each other and sync state.

## Build & Dev Commands

### Server (`cd server`)
```bash
make build          # → bin/dilla-server
make dev            # Run with debug logging
make test           # Go tests
make webapp         # Build client and embed in server binary
make cross-compile  # Linux/macOS/Windows (amd64+arm64)
make docker         # Docker image (Alpine-based)
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
- **Go:** Standard `go fmt` / `go vet`.
- **CSS:** Use theme variables from `src/styles/theme.css` — never hardcode colors. BEM-like class naming.
- **Commits:** Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

## Key Server Paths

- Entrypoint: `server/cmd/dilla-server/main.go`
- API handlers: `server/internal/api/` (router.go defines all routes)
- WebSocket hub: `server/internal/ws/`
- Database models/queries: `server/internal/db/`
- SQL migrations: `server/migrations/`
- Federation: `server/internal/federation/`
- Voice SFU: `server/internal/voice/`
- Config (flags + env vars): `server/internal/config/config.go`

## Key Client Paths

- Pages: `client/src/pages/` (AppLayout is the main shell)
- Components: `client/src/components/`
- API client: `client/src/services/api.ts`
- WebSocket client: `client/src/services/websocket.ts`
- Zustand stores: `client/src/stores/`
- Signal Protocol crypto: `client/src/services/crypto.ts` → calls Rust in `src-tauri/src/crypto.rs`

## Configuration

All server config via env vars (prefix `DILLA_`) or equivalent CLI flags. See `.env.example`. Key vars: `PORT`, `DATA_DIR`, `DB_PASSPHRASE`, `TLS_CERT`/`TLS_KEY`, `PEERS` (federation), `CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN` (voice relay).
