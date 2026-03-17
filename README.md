# Dilla

> Self-hosted, end-to-end encrypted chat — built in Gothenburg.

Dilla is a privacy-first chat platform you run on your own infrastructure. Your messages. Your server. Your kanals.

![License](https://img.shields.io/badge/license-AGPLv3-blue)
![Rust](https://img.shields.io/badge/Rust-1.75+-DEA584)
![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131)

---

## Table of Contents

- [What is Dilla?](#what-is-dilla)
- [Features](#features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
  - [1. Build the Server](#1-build-the-server)
  - [2. Start the Server](#2-start-the-server)
  - [3. Create Your Admin Account](#3-create-your-admin-account)
  - [4. Start the Client](#4-start-the-client)
  - [5. Invite Others](#5-invite-others)
- [Federation — Connecting Multiple Servers](#federation--connecting-multiple-servers)
- [Docker](#docker)
- [Configuration Reference](#configuration-reference)
- [Building from Source](#building-from-source)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [API Reference](#api-reference)
- [Security Model](#security-model)
- [Contributing](#contributing)
- [License](#license)

---

## What is Dilla?

Dilla is an open-source chat platform that works like Discord but with two key differences:

1. **You own the server.** A single Rust binary runs your entire team — no cloud service needed.
2. **True E2E encryption.** Messages are encrypted on your device before they leave. The server never sees plaintext.

Friends can each run a server and **federate** them together into a mesh for high availability. Users just see "teams" — the infrastructure is invisible.

---

## Features

| Category | What you get |
|----------|-------------|
| 💬 **Messaging** | Text kanals, markdown rendering, message editing/deletion |
| 🧵 **Threads** | Reply threads branching from any message |
| 📱 **Direct Messages** | 1-on-1 and group DMs |
| 🔊 **Voice kanals** | WebRTC voice chat with mute, deafen, speaking detection |
| 😀 **Reactions** | Emoji reactions with a built-in picker |
| 📁 **File Sharing** | Drag & drop uploads, inline image/video/audio previews |
| 🔒 **E2E Encryption** | Signal Protocol (X3DH + Double Ratchet) — all messages |
| 🌐 **Federation** | Peer-to-peer mesh — multiple servers act as one team |
| 👥 **Roles & Permissions** | 12-bit permission system with custom roles |
| 🟢 **Presence** | Online / Idle / DND / Offline + custom status messages |
| 🎨 **Themes** | Dark and light mode |
| 🔍 **Search** | Client-side search (works on encrypted messages) |
| ⌨️ **Keyboard Shortcuts** | Ctrl+K search, voice controls, channel navigation |
| 🌍 **i18n** | Internationalization ready from day one |

---

## Architecture

```
┌──────────────────────────┐          ┌──────────────────────────┐
│    Tauri Desktop Client  │          │    Rust Server Binary     │
│    React + Rust          │◄────────►│    Single binary          │
│    ~5MB installer        │  WebSocket│    SQLite + SQLCipher     │
│                          │  (JSON)  │                           │
│  ┌────────────────────┐  │          │  ┌──────────────────────┐ │
│  │ Signal Protocol    │  │          │  │ WebSocket Hub        │ │
│  │ (Rust, client-side)│  │          │  │ REST API (axum)      │ │
│  │ Ed25519 + X25519   │  │          │  │ webrtc-rs SFU        │ │
│  │ AES-256-GCM        │  │          │  │ Rate Limiting        │ │
│  └────────────────────┘  │          │  │ Structured Logging   │ │
└──────────────────────────┘          │  └──────────────────────┘ │
                                      └────────────┬─────────────┘
                                                   │ Federation
                                                   │ (WebSocket relay
                                                   │  + Lamport clocks)
                                                   ▼
                                      ┌──────────────────────────┐
                                      │  Other Server Nodes       │
                                      │  (Same binary, different  │
                                      │   machines / networks)    │
                                      └──────────────────────────┘
```

**Key concepts:**
- **Team** = what users see (like a Discord "server")
- **Server node** = one running instance of the binary
- **Mesh** = multiple server nodes forming one team (transparent to users)
- Users can join **multiple teams** simultaneously (separate connections)

---

## Quick Start

### 1. Build the Server

**Prerequisites:** Rust 1.75+

```bash
cd server-rs
cargo build --release
```

This produces `target/release/dilla-server`.

### 2. Start the Server

```bash
DILLA_TEAM="My Team" ./target/release/dilla-server
```

On first run, you'll see output like this:

```
  *** First-time setup ***
  Bootstrap link: http://localhost:8080/setup?token=abc123def456...

INFO  Server started on :8080
```

### 3. Create Your Admin Account

Open the **bootstrap link** from the terminal in your browser (or paste it into the Dilla client). This one-time link lets you:

1. Create your identity (Ed25519 keypair)
2. Set your username and passphrase
3. Become the **admin** of the team

> ⚠️ The bootstrap link works exactly **once**. After the first user registers, it's invalidated.

### 4. Start the Client

**Prerequisites:** Node.js 20+, Rust 1.75+ (for Tauri)

```bash
cd client
npm install

# Option A: Web browser (development)
npm run dev
# Opens at http://localhost:5173

# Option B: Desktop app (full features including E2E crypto)
npm run tauri dev
```

Connect to your server by entering `http://localhost:8080` (or your server's address).

### 5. Invite Others

As admin, go to **Team Settings → Invites** and create an invite link. Share it with others. They'll use it to register and join your team.

Invite options:
- **One-time use** — link works for exactly 1 person
- **N uses** — set a max number of uses
- **Unlimited** — open invite
- **Expiry** — optional time limit

---

## Federation — Connecting Multiple Servers

Federation lets multiple server instances form a **mesh** that acts as one team. If one node goes down, others keep running.

### Add a Second Node

On another machine (or different port):

```bash
DILLA_TEAM="My Team" DILLA_PORT=8081 DILLA_PEERS=localhost:8080 ./target/release/dilla-server
```

The nodes will discover each other via WebSocket federation and sync state automatically.

### Generate a Join Token (from the UI)

1. Go to **Team Settings → Federation**
2. Click **"Generate Join Command"**
3. Copy the command and run it on the new machine:

```bash
dilla-server --join-token <token>
```

### What Gets Synced

| Data | Synced? |
|------|---------|
| Channels & members | ✅ Full sync on join |
| Messages | ✅ Replicated in real-time |
| Roles & permissions | ✅ Synced |
| Presence | ✅ Broadcast across mesh |
| Voice audio | ❌ Stays on the origin node |

---

## Docker

### Build

```bash
cd server-rs
docker build -t dilla-server .
```

### Run

```bash
docker run -d \
  --name dilla \
  -p 8080:8080 \
  -p 8081:8081 \
  -v dilla-data:/data \
  -e DILLA_TEAM="My Team" \
  dilla-server
```

### With TLS

```bash
docker run -d \
  --name dilla \
  -p 443:8080 \
  -v dilla-data:/data \
  -v /path/to/certs:/certs:ro \
  -e DILLA_TEAM="My Team" \
  -e DILLA_TLS_CERT=/certs/cert.pem \
  -e DILLA_TLS_KEY=/certs/key.pem \
  dilla-server
```

### Docker Compose Example

```yaml
version: '3.8'
services:
  dilla:
    build: ./server-rs
    ports:
      - "8080:8080"
      - "8081:8081"
    volumes:
      - dilla-data:/data
    environment:
      DILLA_TEAM: "My Team"
      DILLA_DB_PASSPHRASE: "change-me-to-something-strong"
      DILLA_LOG_LEVEL: "info"
    restart: unless-stopped

volumes:
  dilla-data:
```

---

## Configuration Reference

Every flag has an equivalent environment variable (prefix `DILLA_`). Env vars are read first; flags override them.

### Core

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `-port` | `DILLA_PORT` | `8080` | HTTP listen port |
| `-team` | `DILLA_TEAM` | — | Team name (required on first run) |
| `-data-dir` | `DILLA_DATA_DIR` | `./data` | Where to store the database and uploads |
| `-db-passphrase` | `DILLA_DB_PASSPHRASE` | — | SQLCipher encryption passphrase for the database |

### TLS

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `-tls-cert` | `DILLA_TLS_CERT` | — | Path to TLS certificate file |
| `-tls-key` | `DILLA_TLS_KEY` | — | Path to TLS private key file |

> If both are set, the server uses HTTPS. Otherwise it uses plain HTTP.

### Federation

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `-federation-port` | `DILLA_FEDERATION_PORT` | port + 1 | Memberlist gossip port |
| `-peers` | `DILLA_PEERS` | — | Comma-separated peer addresses (e.g. `node1:8081,node2:8081`) |
| `-node-name` | `DILLA_NODE_NAME` | auto | Unique name for this node in the mesh |
| `-join-secret` | `DILLA_JOIN_SECRET` | — | HMAC secret for signing join tokens |
| `-fed-bind-addr` | `DILLA_FED_BIND_ADDR` | `0.0.0.0` | Federation bind address |
| `-fed-advertise-addr` | `DILLA_FED_ADVERTISE_ADDR` | — | Address advertised to peers (for NAT) |
| `-fed-advertise-port` | `DILLA_FED_ADVERTISE_PORT` | `0` | Port advertised to peers |

### Uploads

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `-max-upload-size` | `DILLA_MAX_UPLOAD_SIZE` | `26214400` (25 MB) | Max file upload size in bytes |
| `-upload-dir` | `DILLA_UPLOAD_DIR` | `{data-dir}/uploads` | File storage directory |

### Logging & Rate Limiting

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `-log-level` | `DILLA_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `-log-format` | `DILLA_LOG_FORMAT` | `text` | `text` (human-readable) or `json` (structured) |
| `-rate-limit` | `DILLA_RATE_LIMIT` | `100` | Max requests/second per IP |
| `-rate-burst` | `DILLA_RATE_BURST` | `200` | Burst allowance per IP |

---

## Building from Source

### Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| Rust | 1.75+ | Server binary + Tauri client backend + E2E crypto |
| Node.js | 20+ | Client frontend |
| npm | 9+ | Package management |

### Server

```bash
cd server-rs

cargo build --release   # Build for current platform → target/release/dilla-server
cargo run               # Run in dev mode (debug logging)
cargo test              # Run all tests
```

### Client

```bash
cd client

npm install           # Install dependencies
npm run dev           # Vite dev server (web only, http://localhost:5173)
npm run build         # Production build (type-check + bundle)
npm run lint          # ESLint
npm run format        # Prettier
npm run preview       # Preview production build
npm run tauri dev     # Full desktop app (development)
npm run tauri build   # Build desktop installer for your platform
```

---

## Project Structure

```
dilla/
├── server-rs/                       # Rust server binary
│   ├── src/
│   │   ├── main.rs                  # Entrypoint
│   │   ├── api/                     # REST handlers (axum) + middleware
│   │   │   ├── mod.rs              # Route registration + AppState
│   │   │   ├── auth_handlers.rs    # Auth endpoints
│   │   │   ├── dms.rs              # Direct message endpoints
│   │   │   ├── threads.rs          # Thread endpoints
│   │   │   ├── reactions.rs        # Reaction endpoints
│   │   │   ├── uploads.rs          # File upload/download
│   │   │   ├── voice.rs            # Voice channel endpoints
│   │   │   ├── presence.rs         # Presence endpoints
│   │   │   └── federation.rs       # Federation endpoints
│   │   ├── auth.rs                  # Ed25519 challenge-response + JWT
│   │   ├── config.rs                # Env vars configuration
│   │   ├── db/                      # SQLite queries + models + migrations
│   │   ├── federation/              # WebSocket mesh + state sync
│   │   ├── presence.rs              # In-memory presence tracking
│   │   ├── voice/                   # webrtc-rs SFU + TURN credentials
│   │   └── ws/                      # WebSocket hub + events
│   ├── Cargo.toml
│   └── Dockerfile
│
├── client/                          # Tauri desktop client
│   ├── src/                         # React + TypeScript
│   │   ├── components/              # UI components
│   │   │   ├── ChannelList/
│   │   │   ├── MessageList/
│   │   │   ├── MessageInput/
│   │   │   ├── MemberList/
│   │   │   ├── DMList/
│   │   │   ├── DMView/
│   │   │   ├── ThreadPanel/
│   │   │   ├── VoiceChannel/
│   │   │   ├── VoiceControls/
│   │   │   ├── EmojiPicker/
│   │   │   ├── Reactions/
│   │   │   ├── FilePreview/
│   │   │   ├── FederationStatus/
│   │   │   ├── SearchBar/
│   │   │   ├── PresenceIndicator/
│   │   │   ├── StatusPicker/
│   │   │   ├── UserProfile/
│   │   │   ├── UserPanel/
│   │   │   └── ShortcutsModal/
│   │   ├── pages/                   # Top-level page layouts
│   │   ├── services/                # API, WebSocket, WebRTC, crypto, notifications
│   │   ├── stores/                  # Zustand state (auth, team, message, DM, thread, voice, presence, theme)
│   │   ├── hooks/                   # Custom React hooks
│   │   ├── i18n/                    # Translations (en.json)
│   │   └── themes/                  # Dark/light theme definitions
│   ├── src-tauri/                   # Rust backend
│   │   └── src/
│   │       ├── main.rs              # Tauri commands
│   │       ├── crypto.rs            # Signal Protocol (X3DH, Double Ratchet, Sender Keys)
│   │       └── keystore.rs          # Ed25519 key management (encrypted storage)
│   └── package.json
│
├── README.md
├── CONTRIBUTING.md
└── LICENSE                          # AGPLv3
```

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Server** | Rust (axum + tokio) | Single-binary backend |
| **Database** | SQLite + SQLCipher (rusqlite) | Embedded DB with encryption at rest |
| **WebSocket** | tokio-tungstenite | Real-time messaging |
| **Voice** | webrtc-rs | SFU for voice channels (Opus + VP8 codecs) |
| **Federation** | WebSocket relay + Lamport clocks | Peer-to-peer mesh sync |
| **Auth** | Ed25519 + JWT | Challenge-response authentication |
| **Client Framework** | Tauri v2 (Rust) | Lightweight desktop app shell |
| **Client UI** | React 19 + TypeScript | Frontend components |
| **Bundler** | Vite | Fast dev server + production builds |
| **State** | Zustand | Lightweight state management |
| **E2E Crypto** | Signal Protocol (Rust) | X3DH key agreement + Double Ratchet |
| **i18n** | react-i18next | Internationalization |

---

## API Reference

### Health & Version (no auth required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | `{"status": "ok", "uptime": "2h15m"}` |
| `GET` | `/api/v1/version` | `{"version": "0.1.0"}` |

### Authentication (no auth required)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/auth/challenge` | Request auth challenge (nonce) |
| `POST` | `/api/v1/auth/verify` | Submit signed challenge → get JWT |
| `POST` | `/api/v1/auth/register` | Register with invite token |
| `POST` | `/api/v1/auth/bootstrap` | First-run admin registration |

### Team Management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/team` | Get team info |
| `PATCH` | `/api/v1/team` | Update team settings |
| `GET` | `/api/v1/team/members` | List all members |
| `PATCH` | `/api/v1/team/members/{userId}` | Update member |
| `DELETE` | `/api/v1/team/members/{userId}` | Kick member |
| `POST` | `/api/v1/team/members/{userId}/ban` | Ban member |
| `DELETE` | `/api/v1/team/members/{userId}/ban` | Unban member |

### Channels & Messages

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/channels` | List channels |
| `POST` | `/api/v1/channels` | Create channel |
| `GET` | `/api/v1/channels/{id}` | Get channel |
| `PATCH` | `/api/v1/channels/{id}` | Update channel |
| `DELETE` | `/api/v1/channels/{id}` | Delete channel |
| `GET` | `/api/v1/channels/{id}/messages` | Get messages (cursor pagination) |
| `POST` | `/api/v1/channels/{id}/messages` | Send message |
| `PATCH` | `/api/v1/channels/{id}/messages/{msgId}` | Edit message |
| `DELETE` | `/api/v1/channels/{id}/messages/{msgId}` | Delete message |

### Direct Messages

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/teams/{teamId}/dms` | Create or get existing DM |
| `GET` | `/api/v1/teams/{teamId}/dms` | List DM conversations |
| `GET` | `/api/v1/teams/{teamId}/dms/{dmId}` | Get DM details |
| `POST` | `/api/v1/teams/{teamId}/dms/{dmId}/messages` | Send DM |
| `GET` | `/api/v1/teams/{teamId}/dms/{dmId}/messages` | Get DM history |

### Threads

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/teams/{teamId}/channels/{chId}/threads` | Create thread from message |
| `GET` | `/api/v1/teams/{teamId}/channels/{chId}/threads` | List channel threads |
| `GET` | `/api/v1/teams/{teamId}/threads/{threadId}` | Get thread |
| `POST` | `/api/v1/teams/{teamId}/threads/{threadId}/messages` | Reply in thread |
| `GET` | `/api/v1/teams/{teamId}/threads/{threadId}/messages` | Get thread replies |

### Reactions

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `…/messages/{msgId}/reactions/{emoji}` | Add reaction |
| `DELETE` | `…/messages/{msgId}/reactions/{emoji}` | Remove reaction |
| `GET` | `…/messages/{msgId}/reactions` | Get all reactions |

### Voice, Presence, Invites, Roles, Federation, Uploads

See the full route table in `server-rs/src/api/mod.rs`.

### WebSocket

Connect to `/ws?token=<JWT>` for real-time events. Event types include:

| Category | Events |
|----------|--------|
| Messages | `message:new`, `message:updated`, `message:deleted` |
| Typing | `typing:start`, `typing:stop`, `typing:indicator` |
| DMs | `dm:message:new`, `dm:typing:start`, `dm:created` |
| Threads | `thread:created`, `thread:message:new`, `thread:updated` |
| Presence | `presence:changed` |
| Voice | `voice:join`, `voice:offer`, `voice:answer`, `voice:ice-candidate`, `voice:speaking` |
| Members | `member:joined`, `member:left` |
| Channels | `channel:created`, `channel:updated`, `channel:deleted` |

---

## Security Model

### End-to-End Encryption

All messages are encrypted **on the client** before being sent to the server. The server only stores and relays ciphertext.

| Layer | Algorithm | Purpose |
|-------|-----------|---------|
| Identity keys | Ed25519 | User authentication |
| Key agreement | X3DH (X25519) | Initial shared secret between users |
| Message encryption | Double Ratchet (AES-256-GCM) | Forward secrecy per message |
| Group messages | Sender Keys | Efficient group encryption |
| Key storage | Argon2id KDF + AES-256-GCM | Encrypted keypair on disk |
| Database at rest | SQLCipher (AES-256) | Server-side DB encryption |
| Safety numbers | Numeric fingerprint | Verify contact identity |

### Authentication Flow

1. Client generates an Ed25519 keypair (stored encrypted on disk)
2. Client requests a challenge (random nonce) from the server
3. Client signs the nonce with its private key
4. Server verifies the signature against the stored public key
5. Server issues a JWT session token

### What the Server Can See

| Data | Visible to server? |
|------|-------------------|
| Message content | ❌ Only ciphertext |
| Who sent a message | ✅ Metadata |
| Channel membership | ✅ |
| Timestamps | ✅ |
| File contents | ❌ Only encrypted blobs |
| File metadata (name, size) | ✅ |
| Usernames | ✅ |

---

## Continuous Integration & Auto-Fix

This repository includes automated GitHub Actions workflows that detect issues and **use Claude Code AI** to fix them automatically:

- **CI Workflow** (`.github/workflows/ci.yml`) — Runs on every push and PR, checking:
  - Client linting (ESLint)
  - Client build
  - Server tests
  - Server build

- **Claude Auto-Fix Workflow** (`.github/workflows/claude-auto-fix.yml`) — **Primary fix mechanism**:
  - Automatically assigns issues with `auto-fix` label to Claude Code AI agent
  - Claude analyzes the error and creates intelligent PR with fixes
  - Follows project conventions from CLAUDE.md
  - Can handle complex logic errors, add tests, update docs

- **Fallback Auto-Fix Workflow** (`.github/workflows/auto-fix.yml`) — Simple scripted fixes:
  - Runs linters with auto-fix enabled (`npm run lint --fix`)
  - Reinstalls dependencies for build issues
  - Used when Claude is unavailable or for simple mechanical fixes

When a CI check fails, an issue is automatically created with the `auto-fix` label. Claude Code is then notified and creates an intelligent PR to fix the issue.

**Tracking Claude's work:**
```bash
# List all issues/PRs built or fixed by Claude
.github/scripts/list-claude-issues.sh --state all

# Or use GitHub CLI directly
gh issue list --label "auto-fix"
gh pr list --author "Claude"
```

For more details, see:
- [.github/AUTO_FIX.md](.github/AUTO_FIX.md) — Auto-fix workflow documentation
- [.github/CLAUDE_TRACKING.md](.github/CLAUDE_TRACKING.md) — Complete tracking guide

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for:
- Development setup
- Code style guidelines
- Commit message conventions
- Pull request process

---

## License

AGPLv3 — See [LICENSE](LICENSE) for the full text.

This means: you can use, modify, and distribute Dilla freely, but if you run a modified version as a service, you must share your source code.
