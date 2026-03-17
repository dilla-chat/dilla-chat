# Evaluating Go → Rust Migration for the Dilla Server

## Context

The Dilla server is ~13.5K LOC of Go across 49 files, covering REST API, WebSocket hub, SQLite/SQLCipher database, federation (SWIM gossip), WebRTC SFU (voice/video), presence management, and observability. The client already has significant Rust in the Tauri desktop shell (~2K LOC for Signal Protocol crypto, keystore, local DB).

---

## What You'd Gain

### 1. Single Language Stack (Rust everywhere)
- Server + Tauri desktop shell in the same language. Shared types, shared crypto primitives, shared build tooling.
- The Signal Protocol crypto in `client/src-tauri/src/crypto.rs` could be extracted into a shared crate used by both server and client.
- One ecosystem to hire for / contribute to.

### 2. Memory Safety Without GC Pauses
- Go's GC is already low-latency, but Rust eliminates GC entirely. For a real-time chat server with WebSocket fan-out and voice SFU, this means more predictable tail latencies.
- Practically: Go's GC is good enough here. The server uses `SetMaxOpenConns(1)` for SQLite serialization — that's the real bottleneck, not GC.

### 3. Stronger Type System
- Sum types (enums), exhaustive matching, no nil pointer panics. The current Go code has runtime type assertions in WebSocket event dispatch (`client.go:1453 LOC`) that would become compile-time checked.
- The 21-file API handler layer would benefit from stronger request/response typing.

### 4. Fearless Concurrency
- Rust's ownership model prevents data races at compile time. The Go server uses sync.RWMutex in 5+ places (presence, voice rooms, federation peers, typing throttle). These would become `Arc<RwLock<T>>` — similar ergonomics but with compile-time guarantees against misuse.
- The Hub's channel-based architecture maps cleanly to Tokio channels.

### 5. Smaller Binaries, Lower Memory
- Typical Rust binaries are smaller than Go binaries (no runtime). Useful for the embedded-webapp single-binary distribution model.
- Lower baseline memory footprint per connection.

### 6. No CGO Pain
- The current Go server **requires CGO** for SQLCipher (`mattn/go-sqlite3`). This complicates cross-compilation (`make cross-compile` for 6 targets). Rust has native SQLite bindings (`rusqlite`) with SQLCipher support that don't have the same cross-compilation friction.

---

## What You'd Lose / Risk

### 1. Massive Rewrite Cost
- **~13.5K LOC** is not trivial. Every handler, every query, every WebSocket event, every federation message — all rewritten.
- The API layer alone is 21 files / ~3,500 LOC of HTTP handlers.
- The database layer has 5 migration files and ~1,400 LOC of query builders.
- Estimated effort: **several months** for a team, with high regression risk.

### 2. Go's Ecosystem Advantages for This Use Case
- **gorilla/websocket** → Rust has `tokio-tungstenite`, comparable but less battle-tested at scale.
- **Pion WebRTC** → Rust has `webrtc-rs` (actually a Pion port), but it's less mature. The voice SFU (`signaling.go`: 573 LOC) is complex and Pion-specific.
- **Hashicorp Memberlist** → No direct Rust equivalent. You'd need to implement SWIM gossip from scratch or find/build an alternative. This is the **highest risk** area.
- **OpenTelemetry** → Rust's `opentelemetry` crate exists but is less polished than Go's.

### 3. Development Velocity
- Go is faster to write and iterate on for server-side CRUD + WebSocket code. Rust's borrow checker adds friction for the kind of shared-mutable-state patterns used in the Hub, presence manager, and voice rooms.
- Go's error handling is verbose but simple. Rust's `Result<T, E>` is more powerful but the `?` propagation + custom error types add boilerplate.

### 4. Compilation Times
- Go compiles in seconds. Rust (especially with Pion-equivalent WebRTC + async runtime) compiles in minutes. This slows the dev loop significantly.

### 5. Hiring / Contributor Pool
- Go server developers are more abundant than Rust server developers.

---

## Subsystem-by-Subsystem Assessment

| Subsystem | Migration Difficulty | Rust Ecosystem Ready? | Benefit |
|-----------|---------------------|----------------------|---------|
| REST API (~3.5K LOC) | Medium | Yes (axum/actix) | Moderate (better types) |
| WebSocket Hub (~2.1K LOC) | Medium | Yes (tokio-tungstenite) | Moderate (no GC jitter) |
| Database (~1.4K LOC) | Low | Yes (rusqlite, sqlx) | **High** (no CGO) |
| Federation (~1.1K LOC) | **High** | **No equivalent to Memberlist** | Low |
| Voice SFU (~700 LOC) | **High** | Partial (webrtc-rs) | Low |
| Auth (~350 LOC) | Low | Yes (ed25519-dalek, jsonwebtoken) | Low |
| Presence (~300 LOC) | Low | Yes | Low |
| Config (~150 LOC) | Low | Yes (clap, figment) | Low |
| Observability (~500 LOC) | Medium | Partial | Low |
| Webapp embed (~78 LOC) | Low | Yes (rust-embed, include_dir) | Low |

---

## Recommendation

**Decision: Full rewrite to pure Rust.** See `go-to-rust-rewrite-plan.md` for the 7-phase implementation plan. Federation uses the Rust `memberlist` crate (HashiCorp port), voice SFU uses webrtc-rs v0.17.x (Pion port). No Go sidecars — single Rust binary.

---

## Verification

This is an analysis document — no code changes to verify. The assessment is based on:
- Direct inspection of all 49 Go source files in `server/`
- `go.mod` dependency analysis
- Existing Rust code in `client/src-tauri/src/`
- Current state of Rust ecosystem equivalents (axum, tokio, rusqlite, webrtc-rs)
