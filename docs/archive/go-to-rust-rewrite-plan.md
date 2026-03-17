# Dilla Server: Complete Go → Rust Rewrite Plan

## Executive Summary

Full rewrite of the ~13.5K LOC Go server into Rust, organized into 7 phases over the course of the migration. Each phase produces a testable, runnable server with increasing feature parity. The client (React + Tauri) requires zero changes — all REST and WebSocket contracts are preserved exactly.

---

## Technology Stack

### Rust Crate Selections

| Go Dependency | Rust Replacement | Version | Rationale |
|---|---|---|---|
| `net/http` (stdlib) | **axum** 0.8.x | Stable | Tokio-native, best DX, built-in WebSocket, Tower middleware, surpassed actix-web in adoption |
| `gorilla/websocket` | **axum::extract::ws** + **tokio-tungstenite** | Stable | Integrated with axum, same upgrade pattern |
| `mattn/go-sqlite3` (CGO) | **rusqlite** with `bundled-sqlcipher` feature | 0.38.x | Eliminates CGO entirely. SQLCipher compiled and statically linked. No cross-compilation pain |
| `hashicorp/memberlist` | **memberlist** (Rust port) | crates.io | Direct port of HashiCorp's memberlist. Async runtime agnostic, WASM-friendly. Closest API match. If insufficient, use **foca** (SWIM+Inf.+Susp.) and build the missing pieces |
| `pion/webrtc/v4` | **webrtc-rs** v0.17.x (stable branch) | 0.17.x | Use the Tokio-coupled stable branch, NOT the v0.20 alpha. Bug-fix-only but functional |
| `golang-jwt/jwt/v5` | **jsonwebtoken** | 9.x | Mature, supports HS256/RS256/EdDSA, widely used |
| `golang.org/x/crypto` | **ed25519-dalek** + **rand** | 2.x | Ed25519 signing/verification. `rand` for challenge nonces |
| `google/uuid` | **uuid** with `v4` feature | 1.x | Drop-in equivalent |
| `golang.org/x/time/rate` | **governor** + **tower** middleware | Stable | Token bucket rate limiting, integrates with axum via Tower |
| `go:embed` | **rust-embed** | 8.x | `#[derive(RustEmbed)]` on a struct, same pattern as Go embed |
| `crypto/tls` | **rustls** + **tokio-rustls** | Stable | Pure Rust TLS, no OpenSSL dependency |
| OpenTelemetry Go SDK | **opentelemetry** + **tracing** + **tracing-opentelemetry** | 0.28.x | `tracing` is the Rust standard; bridge to OTel via `tracing-opentelemetry` |
| `encoding/json` | **serde** + **serde_json** | 1.x | De facto standard, derive macros for zero-boilerplate serialization |
| `log/slog` | **tracing** + **tracing-subscriber** | 0.1.x | Structured logging with spans, async-aware |
| `flag` + `os.Getenv` | **clap** 4.x + **dotenvy** | Stable | CLI args + .env file loading |
| `time` | **chrono** | 0.4.x | DateTime, timestamps, RFC3339 formatting |

### Project Structure

```
server-rs/
├── Cargo.toml
├── Cargo.lock
├── migrations/
│   ├── 001_initial.sql
│   ├── 002_bans.sql
│   ├── 003_dm_enhancements.sql
│   ├── 004_threads.sql
│   └── 005_reactions_attachments.sql
├── src/
│   ├── main.rs              # Entrypoint, wiring, graceful shutdown
│   ├── config.rs            # Config struct, env var loading
│   ├── error.rs             # AppError enum, axum IntoResponse impl
│   ├── auth.rs              # Ed25519 challenge-response, JWT, middleware
│   ├── db/
│   │   ├── mod.rs           # Database struct, connection, migrations
│   │   ├── models.rs        # All model structs (User, Team, Channel, Message, etc.)
│   │   ├── queries.rs       # User/Team/Channel/Message/Member/Role queries
│   │   ├── dm_queries.rs    # DM channel queries
│   │   ├── thread_queries.rs
│   │   ├── reaction_queries.rs
│   │   └── attachment_queries.rs
│   ├── api/
│   │   ├── mod.rs           # Router construction, middleware stack
│   │   ├── auth.rs          # POST /auth/challenge, /auth/verify, /auth/register
│   │   ├── users.rs         # GET/PATCH /users/me
│   │   ├── teams.rs         # CRUD /teams
│   │   ├── channels.rs      # CRUD /teams/{teamId}/channels
│   │   ├── messages.rs      # CRUD /teams/{teamId}/channels/{channelId}/messages
│   │   ├── roles.rs         # CRUD /teams/{teamId}/roles
│   │   ├── members.rs       # /teams/{teamId}/members, bans
│   │   ├── invites.rs       # /teams/{teamId}/invites
│   │   ├── dms.rs           # /teams/{teamId}/dms
│   │   ├── threads.rs       # /teams/{teamId}/channels/{channelId}/threads
│   │   ├── reactions.rs     # PUT/DELETE .../reactions/{emoji}
│   │   ├── uploads.rs       # POST /upload, GET/DELETE /attachments/{id}
│   │   ├── prekeys.rs       # POST/GET/DELETE /prekeys
│   │   ├── presence.rs      # GET/PUT /teams/{teamId}/presence
│   │   ├── voice.rs         # GET /teams/{teamId}/voice/{channelId}
│   │   ├── turn.rs          # GET /voice/credentials
│   │   ├── federation.rs    # /federation/* routes
│   │   └── telemetry.rs     # POST /telemetry proxy
│   ├── ws/
│   │   ├── mod.rs           # WebSocket upgrade handler
│   │   ├── hub.rs           # Hub: register/unregister/subscribe/broadcast
│   │   ├── client.rs        # Per-connection read/write loops, event dispatch
│   │   └── events.rs        # Event enum, all payload types, serialization
│   ├── voice/
│   │   ├── mod.rs
│   │   ├── sfu.rs           # WebRTC SFU: peer connections, track management
│   │   ├── room.rs          # VoiceRoom state (mute/deafen/screen/webcam)
│   │   └── turn.rs          # TURN credential providers (Cloudflare, self-hosted)
│   ├── federation/
│   │   ├── mod.rs
│   │   ├── mesh.rs          # MeshNode: SWIM gossip via memberlist crate
│   │   ├── transport.rs     # Peer-to-peer WebSocket transport
│   │   ├── sync.rs          # SyncManager: Lamport clocks, state replication
│   │   ├── join.rs          # JoinManager: new node onboarding
│   │   └── identity.rs      # FederatedIdentity: peer key management
│   ├── presence/
│   │   └── mod.rs           # PresenceManager: in-memory status, idle detection
│   ├── observability/
│   │   ├── mod.rs           # OTel init (traces, metrics, logs)
│   │   ├── middleware.rs    # HTTP tracing middleware
│   │   └── metrics.rs       # Custom counters/histograms
│   └── webapp/
│       └── mod.rs           # RustEmbed serving, SPA fallback
└── tests/
    ├── api_test.rs          # Integration tests (mirrors Go api_test.go)
    └── ws_test.rs           # WebSocket integration tests
```

---

## Phase 1: Foundation (Config, DB, Auth, Health)

**Goal:** Server starts, connects to SQLCipher DB, runs migrations, serves `/health`.

### 1.1 Cargo.toml & Dependencies

```toml
[package]
name = "dilla-server"
version = "0.1.0"
edition = "2021"

[dependencies]
# Web framework
axum = { version = "0.8", features = ["ws", "multipart"] }
tokio = { version = "1", features = ["full"] }
tower = "0.5"
tower-http = { version = "0.6", features = ["cors", "fs", "set-header", "limit"] }

# Database
rusqlite = { version = "0.38", features = ["bundled-sqlcipher", "backup"] }

# Auth & Crypto
jsonwebtoken = "9"
ed25519-dalek = { version = "2", features = ["rand_core"] }
rand = "0.8"

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Utilities
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
dotenvy = "0.15"
clap = { version = "4", features = ["derive", "env"] }
base64 = "0.22"
hex = "0.4"

# Logging
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }

# Rate limiting
governor = "0.8"

# TLS
tokio-rustls = "0.26"
rustls-pemfile = "2"

# Embed
rust-embed = "8"
mime_guess = "2"
```

### 1.2 Config (`src/config.rs`)

Port the `Config` struct with all `DILLA_*` env vars. Use `clap` derive for CLI flags and `dotenvy` for `.env` loading. All 35+ config keys preserved exactly.

### 1.3 Database (`src/db/`)

- `Database` struct wrapping `rusqlite::Connection` behind `Arc<Mutex<Connection>>`
- Execute `PRAGMA key = '{passphrase}'` immediately after opening for SQLCipher
- Enable WAL mode: `PRAGMA journal_mode = WAL`
- Embed migrations via `include_str!()`, run sequentially
- Port all model structs from Go's `models.go` (17 structs: User, Team, Channel, Message, Role, Member, Reaction, Attachment, Thread, Invite, InviteUse, PrekeyBundle, BootstrapToken, DMChannel, DMMember, Ban, IdentityBlob)
- Port all query functions from `queries.go` (~40 functions), `dm_queries.go`, `thread_queries.go`, `reaction_queries.go`, `attachment_queries.go`
- **Note:** rusqlite is synchronous. Wrap DB calls in `tokio::task::spawn_blocking` to avoid blocking the async runtime

### 1.4 Auth (`src/auth.rs`)

- `AuthService` with `Arc<RwLock<HashMap<String, Challenge>>>` for in-memory challenges
- Ed25519 signature verification via `ed25519-dalek`
- JWT generation/validation via `jsonwebtoken` (HS256, 7-day expiry)
- Background task: clean expired challenges every 5 minutes
- Bootstrap token generation for first-user setup
- `auth_middleware`: axum extractor that validates `Authorization: Bearer {token}` header, injects `UserId` into request extensions

### 1.5 Health & Version Endpoints

- `GET /api/v1/health` → `{"status": "ok", "uptime": "..."}`
- `GET /api/v1/version` → `{"version": "...", "go_version": null, "rust_version": "..."}`
- `GET /api/v1/config` → `{"domain": "...", "rp_id": "..."}`

### 1.6 Main Entrypoint (`src/main.rs`)

Wire together: load config → init logging → open DB → run migrations → bootstrap token check → create auth service → bind TCP → serve with graceful shutdown on SIGINT/SIGTERM.

**Deliverable:** `cargo run` starts server, creates encrypted DB, runs migrations, serves health endpoint.

---

## Phase 2: REST API (CRUD Operations)

**Goal:** Full REST API parity. All endpoints return identical JSON shapes.

### 2.1 Router & Middleware Stack (`src/api/mod.rs`)

Build the axum Router with Tower middleware layers, in order:
1. CORS (from config `allowed_origins`)
2. Security headers (X-Frame-Options: DENY, CSP, HSTS, X-Content-Type-Options)
3. Request body size limit (1MB default)
4. Rate limiting (governor, per-IP token bucket)
5. Request logging (tracing spans)
6. Auth middleware (on protected routes)

### 2.2 Auth Endpoints (`src/api/auth.rs`)

- `POST /api/v1/auth/challenge` → generate nonce + challenge_id
- `POST /api/v1/auth/verify` → verify Ed25519 signature, return JWT
- `POST /api/v1/auth/register` → create user (requires invite token or bootstrap token)
- `POST /api/v1/auth/bootstrap` → first-user setup with bootstrap token

### 2.3 User, Team, Channel, Message, Role, Member, Invite CRUD

Port all 21 handler files from `server/internal/api/`. Each handler becomes an axum handler function with typed extractors:

```rust
async fn create_message(
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
    Extension(user_id): Extension<UserId>,
    Json(body): Json<CreateMessageRequest>,
) -> Result<Json<MessageResponse>, AppError> { ... }
```

### 2.4 Upload/Download (`src/api/uploads.rs`)

- `POST /api/v1/teams/{teamId}/upload` — multipart form, configurable max size (default 25MB)
- `GET /api/v1/teams/{teamId}/attachments/{id}` — stream file from disk
- `DELETE /api/v1/teams/{teamId}/attachments/{id}` — delete file + DB record

### 2.5 Error Handling (`src/error.rs`)

Single `AppError` enum implementing `IntoResponse`:

```rust
enum AppError {
    NotFound(String),
    Unauthorized(String),
    Forbidden(String),
    BadRequest(String),
    Conflict(String),
    Internal(String),
}
```

Always returns `{"error": "message"}` JSON with appropriate HTTP status.

**Deliverable:** All REST endpoints work. Can be tested against the existing React client with zero client changes.

---

## Phase 3: WebSocket Hub

**Goal:** Real-time messaging, typing indicators, presence, channel subscriptions.

### 3.1 Hub (`src/ws/hub.rs`)

Port the single-dispatcher architecture using Tokio channels:

```rust
struct Hub {
    clients: Arc<RwLock<HashMap<String, ClientHandle>>>,
    channels: Arc<RwLock<HashMap<String, HashSet<String>>>>,
    user_index: Arc<RwLock<HashMap<String, Vec<String>>>>,

    register_tx: mpsc::Sender<RegisterMsg>,
    unregister_tx: mpsc::Sender<String>,
    broadcast_tx: mpsc::Sender<BroadcastMsg>,
    direct_tx: mpsc::Sender<DirectMsg>,
    // ...

    db: Database,
    typing_throttle: Arc<RwLock<HashMap<String, i64>>>,
}
```

Hub::run() is a `tokio::select!` loop over all channels — direct translation of Go's `select {}`.

### 3.2 Client (`src/ws/client.rs`)

Per-connection:
- `read_pump`: tokio task reading from WebSocket, parsing events, dispatching to hub
- `write_pump`: tokio task draining `mpsc::Receiver<Vec<u8>>` to WebSocket
- Ping/pong every 54 seconds, 60-second read deadline
- Rate limiting: 10 messages/second per client
- 256-element bounded send channel (drop on full)

### 3.3 Events (`src/ws/events.rs`)

Port all ~50 event types as a Rust enum with serde tagging:

```rust
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
enum ClientEvent {
    #[serde(rename = "message:send")]
    MessageSend(MessageSendPayload),
    #[serde(rename = "typing:start")]
    TypingStart(TypingPayload),
    #[serde(rename = "voice:join")]
    VoiceJoin(VoiceJoinPayload),
    // ... all events
}
```

This replaces the Go runtime string-matching with compile-time exhaustive matching.

### 3.4 Request/Response Over WS

Port the sync:init, messages:list, threads:list, dms:list, etc. request/response actions that the client uses for initial data loading over WebSocket.

### 3.5 Callbacks

Wire hub callbacks for federation/presence/voice integration (same pattern as Go: `Option<Box<dyn Fn(...) + Send + Sync>>`).

**Deliverable:** Full real-time messaging works. Messages sent via WebSocket appear in other clients. Typing indicators, presence updates, channel subscriptions all functional.

---

## Phase 4: Presence Manager

**Goal:** Online/idle/DND/offline status tracking with auto-idle detection.

### 4.1 PresenceManager (`src/presence/mod.rs`)

- In-memory `HashMap<String, PresenceState>` behind `Arc<RwLock<_>>`
- `set_online(user_id)`, `set_offline(user_id)`, `update_status(user_id, status_type, custom_text)`
- `record_activity(user_id)` — updates last_activity timestamp
- Background task: check every 30 seconds, mark users idle after 5 minutes of inactivity
- `on_federation` callback for gossipping presence to peers
- REST endpoints: `GET /presence`, `GET /presence/{userId}`, `PUT /presence`

**Deliverable:** User presence shows correctly in client, auto-idle works.

---

## Phase 5: Voice SFU

**Goal:** Voice/video calling with WebRTC SFU.

### 5.1 SFU (`src/voice/sfu.rs`)

Port the Pion WebRTC SFU using **webrtc-rs v0.17.x** (stable branch):
- `handle_join(channel_id, user_id)` → create PeerConnection, add audio transceiver (Opus 48kHz), create offer
- `handle_answer(channel_id, user_id, sdp)` → set remote description
- `handle_ice_candidate(channel_id, user_id, candidate)` → add ICE candidate
- `handle_leave(channel_id, user_id)` → close PeerConnection, remove from room
- Screen sharing: VP8 video track, add/remove dynamically with renegotiation
- Webcam: VP8 video track, same pattern
- `renegotiate_all(channel_id)` — rebuild offers for all peers when tracks change

### 5.2 Room State (`src/voice/room.rs`)

`VoiceRoom` with per-user state:
- muted, deafened, speaking, screen_sharing, webcam_sharing
- Track mute/deafen/screen/webcam events from WebSocket
- Broadcast state changes to all room members

### 5.3 TURN Providers (`src/voice/turn.rs`)

- `CloudflareTurnClient`: HTTP API call to Cloudflare TURN service
- `SelfHostedTurnClient`: HMAC-SHA1 credential generation with shared secret
- Both implement `TurnCredentialProvider` trait
- `GET /api/v1/voice/credentials` endpoint

### 5.4 webrtc-rs v0.17.x Considerations

- v0.17.x is Tokio-coupled (matches our stack)
- Bug-fix-only branch, no new features
- API is a direct port of Pion, so Go → Rust translation is mostly mechanical
- Known limitations: some edge cases in ICE gathering, but functional for SFU pattern
- **Risk mitigation:** If webrtc-rs v0.17.x has gaps, contribute patches upstream or fork. The codebase is a direct Pion port so the fix patterns are well-understood. Pin to a known-good commit if needed

**Deliverable:** Voice calls work. Users can join/leave voice channels, hear each other, share screens.

---

## Phase 6: Federation

**Goal:** Multi-node cluster with SWIM gossip, message replication, state sync.

### 6.1 Crate Selection: `memberlist` (Rust port)

The `memberlist` crate on crates.io is a direct port of HashiCorp's Go memberlist:
- Same SWIM protocol semantics
- Async runtime agnostic
- Supports custom broadcasts (for message replication)
- Transport layer abstraction (TCP, QUIC, custom)

**Fallback:** If the Rust `memberlist` crate proves too immature, use **foca** (SWIM+Inf.+Susp.) which is more library-first but requires more manual wiring.

### 6.2 MeshNode (`src/federation/mesh.rs`)

- Wrap `memberlist::Memberlist` instance
- Configure for LAN or WAN based on peer addresses
- Implement `memberlist::Delegate` trait for:
  - `NotifyMsg` — receive federation events (message:new, message:edit, message:delete, presence:changed, voice events)
  - `NodeMeta` — advertise node name, API address
  - `GetBroadcasts` — return queued replication messages
- Peer tracking: `Arc<RwLock<HashMap<String, Peer>>>`

### 6.3 Transport (`src/federation/transport.rs`)

- Peer-to-peer WebSocket connections for large payloads (state sync)
- TLS support via rustls
- Reconnection logic with exponential backoff

### 6.4 Sync Manager (`src/federation/sync.rs`)

- Lamport timestamp counter: `Arc<AtomicU64>`
- `ReplicationMessage` struct with all fields for cross-node message delivery
- State sync on join: request full channel/message/member/role state from existing peer
- Conflict resolution: higher Lamport timestamp wins

### 6.5 Federation Events

Port all federation event types:
- `message:new`, `message:edit`, `message:delete`
- `presence:changed`
- `voice:user:joined`, `voice:user:left`
- `state:sync:req`, `state:sync`

### 6.6 Join Flow (`src/federation/join.rs`)

- Generate join tokens with `POST /api/v1/federation/join-token`
- New node contacts existing node via `GET /api/v1/federation/join/{token}`
- Receives cluster config + peer list
- Joins memberlist cluster
- Triggers state sync

**Deliverable:** Multiple dilla-server instances can form a cluster. Messages sent on one node appear on all nodes.

---

## Phase 7: Polish & Parity

**Goal:** Feature-complete parity with Go server, production-ready.

### 7.1 Observability (`src/observability/`)

- OpenTelemetry init: traces + metrics + logs via OTLP (gRPC or HTTP)
- `tracing-opentelemetry` bridge for automatic span export
- HTTP middleware: request duration histogram, status code counter
- WebSocket metrics: connected gauge, message counter by event type
- DB query tracing via custom wrapper
- Telemetry proxy endpoint: `POST /api/v1/telemetry`

### 7.2 Webapp Embedding (`src/webapp/mod.rs`)

```rust
#[derive(RustEmbed)]
#[folder = "dist/"]
struct Asset;
```

- Serve embedded files with correct MIME types
- Hashed assets: `Cache-Control: public, max-age=31536000, immutable`
- SPA fallback: non-API, non-WS routes → `index.html`
- Skip paths: `/api/`, `/ws`, `/federation/`, `/health`

### 7.3 DMs & Group DMs

Port all DM endpoints:
- Create/get DM channel between two users
- Group DM with member add/remove
- DM message CRUD
- DM WebSocket events (dm:message:new, dm:typing:start, etc.)

### 7.4 Threads

Port thread endpoints:
- Create thread from parent message
- Thread message CRUD
- Thread WebSocket events

### 7.5 Reactions

Port reaction endpoints:
- Add/remove emoji reaction on message
- Reaction WebSocket events

### 7.6 Integration Tests

Port `api_test.go` (762 LOC) to Rust integration tests:
- Spin up test server with in-memory SQLite
- Test all API endpoints with actual HTTP calls
- WebSocket integration tests for message flow
- Federation tests with two in-process nodes

### 7.7 Build & Deployment

**Makefile targets:**
```makefile
build:           cargo build --release
dev:             cargo run
test:            cargo test
webapp:          # copy client/dist → server-rs/dist, cargo build
cross-compile:   # cross for linux/macos/windows (amd64+arm64)
docker:          # multi-stage: rust builder → alpine runtime
```

**Cross-compilation:** Use `cross` tool for cross-platform builds. Unlike Go+CGO, Rust's `bundled-sqlcipher` compiles SQLCipher from source for each target — no external C toolchain needed.

**Docker:**
```dockerfile
FROM rust:1.82-alpine AS builder
RUN apk add musl-dev
COPY . .
RUN cargo build --release

FROM alpine:3.21
COPY --from=builder /app/target/release/dilla-server /usr/local/bin/
ENTRYPOINT ["dilla-server"]
```

---

## Migration Order & Dependencies

```
Phase 1: Foundation ──────────────────────────────────────┐
  config.rs, db/*, auth.rs, main.rs, health endpoint      │
                                                           ▼
Phase 2: REST API ────────────────────────────────────────┐
  All 17 API handler files, error.rs, middleware           │
                                                           ▼
Phase 3: WebSocket Hub ───────────────────────────────────┐
  hub.rs, client.rs, events.rs (50+ event types)           │
                                                           ▼
Phase 4: Presence ────────────────────────────────────────┐
  presence/mod.rs, idle detection, REST endpoints          │
                                                           ▼
Phase 5: Voice SFU ───────────────────────────── (parallel with 6)
  sfu.rs, room.rs, turn.rs                                 │
                                                           │
Phase 6: Federation ──────────────────────────── (parallel with 5)
  mesh.rs, transport.rs, sync.rs, join.rs, identity.rs     │
                                                           ▼
Phase 7: Polish ──────────────────────────────────────────┘
  OTel, webapp embed, DMs, threads, reactions, tests, Docker
```

Phases 5 and 6 can be developed in parallel since they're independent subsystems that only integrate via callbacks wired in `main.rs`.

---

## Shared Crate Opportunity

Extract `dilla-crypto` as a workspace crate shared between server-rs and client/src-tauri:

```
dilla-chat/
├── crates/
│   └── dilla-crypto/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           ├── ed25519.rs      # Keypair generation, signing, verification
│           ├── x3dh.rs         # X3DH key agreement (from crypto.rs)
│           ├── double_ratchet.rs # Double Ratchet (from crypto.rs)
│           └── aes_gcm.rs      # AES-256-GCM encryption
├── server-rs/
│   └── Cargo.toml              # depends on dilla-crypto
└── client/src-tauri/
    └── Cargo.toml              # depends on dilla-crypto
```

This eliminates code duplication and ensures both ends use identical crypto.

---

## Risk Mitigations

| Risk | Mitigation |
|---|---|
| webrtc-rs v0.17.x has bugs | Contribute fixes upstream or maintain a pinned fork. The codebase is a Pion port — fix patterns map 1:1 from Go |
| Rust memberlist crate is too immature | Switch to foca (SWIM+extensions). More work but proven in production by others |
| SQLCipher bundled build fails on target | rusqlite's `bundled-sqlcipher` is well-tested on all major platforms. Fallback: link system SQLCipher |
| Performance regression in async SQLite | Use `tokio::task::spawn_blocking` for all rusqlite calls. Consider r2d2 connection pool |
| Compilation times slow dev loop | Use `cargo-watch` + `mold` linker. Split into workspace crates for incremental compilation |
| Client breaks due to API contract change | Run Go and Rust servers side-by-side in CI. Diff all endpoint responses. Zero-tolerance for contract changes |

---

## Success Criteria

1. **Byte-identical API contracts** — every endpoint returns the same JSON structure
2. **WebSocket event parity** — all 50+ events work identically
3. **Federation interop** — Rust nodes can join a cluster with Go nodes during migration (optional but ideal)
4. **No CGO** — `ldd dilla-server` shows no libsqlite3 dependency
5. **Cross-compilation** — single `cargo build` (via `cross`) for 6 targets without toolchain gymnastics
6. **All Go tests pass** — port and pass all integration tests
7. **Single binary with embedded webapp** — same deployment model as Go version
