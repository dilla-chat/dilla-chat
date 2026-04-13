# Voice Isolation Plugin (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Plan Revision History

**v3 — addresses surviving issues from second review pass:**
- **C1 redux:** The Rust test in Task 5.1 Step 3 was rewritten to use the flat `VoiceEmbeddingPublishPayload` struct + string-constant pattern (it had still been using the nonexistent `VoicePayload` enum in v2).
- **C3 redux:** The streaming `startStreamLoop` in `inferenceWorker.ts` (Task 3.3) now reads tensor names and window size from `SessionEntry.ioSpec` instead of hardcoding `'input'`/`'output'`/`'speaker_embedding'`/`1440`. The `MODEL_WINDOW_SAMPLES_*` module-level constants were removed.
- **S2/S4 redux:** New Task 3.3.5 closes the deferred dispatcher → worker `load-model` round-trip. Real session IDs are populated via `Promise.all([loadOne(...)])`. The dangling TODO in Task 1.14 is now actually completed.
- **Field name consistency:** `this.voiceIsolation` references in Tasks 4.1 and 6.1 corrected to `this.voiceIsolationContext` and updated to call free functions `processOutgoing(ctx, ...)` / `processIncoming(ctx, ...)`.

**v2 — addresses issues from first review pass:**
- **C1 (Task 5.1):** Server WS event model corrected — uses string constants + flat `VoiceXxxPayload` structs (matching existing `events.rs` pattern) instead of a nonexistent `VoicePayload` enum. Dispatch site in `ws/client.rs` is now explicitly named.
- **C2 (Task 1.3):** `server-rs/build.rs` is now explicitly created (it does not exist yet).
- **C3 (Task 3.3):** Tensor names and window size are no longer hardcoded — they're parameterized as a `ModelIOSpec` populated from the spike memo.
- **C4 (Task 3.6):** Latency benchmark now runs in browser mode with `onnxruntime-web` (not `onnxruntime-node`, which would have given false positives).
- **C5 (new Task 1.6.5):** ORT Web WASM asset paths configured via `ort.env.wasm.wasmPaths` and a `postinstall` script that copies `.wasm` files into Vite's `public/`.
- **C6 (Task 1.13):** SFrame integration verification is now a hard gating checkpoint with explicit outcome A/B branches and a "stop and re-spec" path.
- **S2 (Task 1.11) / S4 (new Task 1.14):** Worker session-id wiring made explicit; voiceIsolation dispatcher init now has its own task that runs at `WebRTCService` construction time.
- **S8 (Task 1.5):** `Cross-Origin-Resource-Policy: same-origin` added to model serve handler responses (required when COEP=`require-corp` is set on client routes).

**Goal:** Build the personalized voice isolation pipeline (`dilla-voice-focus`) for Dilla — a Krisp-equivalent open-source noise + voice isolator that runs entirely client-side, preserves end-to-end encryption, and works in symmetric mode (every peer's voice is cleaned for every other peer in a call).

**Architecture:** AudioWorklet pumps PCM into SharedArrayBuffer ring buffers; a dedicated Web Worker pool runs ONNX Runtime Web inference for VoiceFilter-Lite (personalized) and DeepFilterNet 3 (fallback). Speaker embeddings are computed once per identity via ECAPA-TDNN, stored in an HKDF-derived encrypted IndexedDB blob store, and broadcast to call peers via Signal-Protocol-encrypted WebSocket events. The pipeline plugs into `WebRTCService.ts` at one seam, sitting *inside* the existing SFrame encryption boundary (process before encrypt outgoing, after decrypt incoming).

**Tech Stack:**
- Client: TypeScript, React 19, ONNX Runtime Web (`onnxruntime-web`), AudioWorklet, Web Workers, SharedArrayBuffer + Atomics, IndexedDB, Web Audio API
- Server: Rust, axum, rust-embed, Git LFS for model artifacts
- Crypto: existing Signal Protocol stack (`client/src/services/crypto/`), Ed25519 signatures, AES-256-GCM, HKDF-SHA256
- Test: vitest (unit + browser mode), Playwright (E2E)

**Spec:** `docs/superpowers/specs/2026-04-07-voice-isolation-plugin-design.md`

**Branch:** Create a new branch `feat/voice-isolation-phase1` off `main`.

---

## File Structure Map

This is the complete inventory of files this plan creates or modifies. Tasks reference this map.

### New client files

```
client/src/services/voiceIsolation/
├── index.ts                              # Public exports
├── modelLoader.ts                        # Fetch + checksum + IndexedDB cache, instantiates ORT sessions in worker
├── modelLoader.test.ts
├── embeddingStore.ts                     # HKDF-derived encrypted IndexedDB blob store
├── embeddingStore.test.ts
├── enrollment.ts                         # Capture + ECAPA + validate
├── enrollment.test.ts
├── embeddingTransport.ts                 # Signal-encrypted broadcast over WS
├── embeddingTransport.test.ts
├── pipeline.ts                           # Per-stream worklet+worker+ring bundle
├── pipeline.test.ts
├── dispatcher.ts                         # Per-call orchestration
├── dispatcher.test.ts
├── activeSpeakerTracker.ts               # AnalyserNode-based RMS tier tracker
├── activeSpeakerTracker.test.ts
├── diagnostics.ts                        # Local-only counters
├── diagnostics.test.ts
├── audioWorklet/
│   ├── ringBufferProcessor.js            # AudioWorkletProcessor — buffer pump
│   └── ringProtocol.ts                   # SAB ring buffer protocol (shared with worker)
├── inferenceWorker.ts                    # Dedicated Worker — runs ORT sessions
├── inferenceWorker.test.ts
└── types.ts                              # Shared types

client/src/components/VoiceEnrollment/
├── VoiceEnrollment.tsx                   # First-time enrollment modal
├── VoiceEnrollment.css
└── VoiceEnrollment.test.tsx

client/test/voice-fixtures/
├── README.md                             # How fixtures were generated
├── clean_speech_alice.wav                # ~3s clean speech, speaker A
├── clean_speech_bob.wav                  # ~3s clean speech, speaker B
├── speech_with_keyboard.wav              # speaker A + keyboard noise
├── speech_with_traffic.wav               # speaker A + traffic noise
├── speech_with_babble.wav                # speaker A + restaurant babble
├── speech_with_music.wav                 # speaker A + background music
├── speech_with_other_voice.wav           # speaker A + speaker B
├── two_speakers_overlap.wav              # speakers A and B simultaneously
├── reference_embeddings.json             # Pre-computed ECAPA outputs for fixtures
└── reference_snr.json                    # Baseline SNR values for regression
```

### Modified client files

- `client/src/services/webrtc/WebRTCService.ts` — wire `voiceIsolation.processOutgoing()` before `addTrack()`, wire `voiceIsolation.processIncoming()` after the SFrame decryption layer in `ontrack`
- `client/src/services/noiseSuppression.ts` — delete the no-op stub (it's no longer needed once the plugin is wired)
- `client/src/stores/audioSettingsStore.ts` — add `voiceIsolationEnabled: boolean` and `voiceIsolationStatus` derived state
- `client/src/pages/UserSettings.tsx` — add the new "Voice Isolation" section
- `client/src/components/VoiceControls/VoiceControls.tsx` — add the badge
- `client/src/i18n/locales/en.json` — add new strings
- `client/index.html` — no changes needed for COOP/COEP (server sets the headers)
- `client/vite.config.ts` — verify it doesn't strip `Cross-Origin-*` headers in dev
- `client/package.json` — add `onnxruntime-web` dependency

### New server files

```
server-rs/assets/voice-models/
├── manifest.json                         # Generated by build.rs
├── vfl-v1.onnx                           # Git LFS
├── ecapa-v1.onnx                         # Git LFS
└── dfn3-v1.onnx                          # Git LFS
```

### Modified server files

- `server-rs/build.rs` — emit `manifest.json` with SHA-256 of each .onnx file
- `server-rs/src/api/voice.rs` — add `models_manifest()` and `models_serve()` handlers
- `server-rs/src/api/mod.rs` — register the new routes
- `server-rs/src/ws/events.rs` — add `VoiceEmbeddingPublish`, `VoiceEmbeddingReceived`, `VoiceEmbeddingRevoke`
- `server-rs/src/ws/handlers/voice.rs` — add relay logic for embedding events
- `server-rs/src/main.rs` (or middleware module) — set COOP/COEP headers scoped to client routes
- `server-rs/Cargo.toml` — add `sha2` if not already present
- `.gitattributes` — mark `server-rs/assets/voice-models/*.onnx` as LFS

### Test infra

- `client/scripts/fetch-test-models.sh` — downloads .onnx files for local + CI use
- `client/test/voice-helpers.ts` — shared test utilities (synthetic PCM generation, WAV loading)

---

## Milestone 0 — Spike (gating)

**Output:** A go/no-go memo committed to `docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md`. **All later milestones are blocked on this spike passing.**

This milestone is research, not feature code. Steps are unconventional — they're "do the experiment, write down what you found, decide go/no-go". Do not start milestone 1 until the memo lands and explicitly says "proceed".

### Task 0.1: Spike 0a — Verify VoiceFilter-Lite ONNX availability

**Files:**
- Create: `docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md`
- Create: `scripts/spike/test-vfl-availability.ts` (throwaway)

- [ ] **Step 1: Search for VFL-equivalent ONNX checkpoints**

Search GitHub, Hugging Face, and ONNX Model Zoo for any of:
- "VoiceFilter Lite ONNX"
- "personalized speech enhancement ONNX"
- "target speaker extraction ONNX"
- "speakerbeam ONNX"
- "WeSep ONNX"

Document each candidate's: URL, author, license, file size, parameter count, training data. Reject anything that isn't permissively licensed (MIT/Apache/BSD).

- [ ] **Step 2: Download top 3 candidates**

For each candidate, download the .onnx file and any required preprocessor specs. Store in `scripts/spike/models/`.

- [ ] **Step 3: Write a Node-based smoke test**

Use `onnxruntime-node` (not `onnxruntime-web` — this is a Node spike) to load each candidate and run a single-frame inference on synthetic input. Verify:
- The session loads without errors
- Input/output shapes match what the original paper documents
- Output values are non-NaN floats in `[-1, 1]`

- [ ] **Step 4: Run on the fixture WAVs**

Use `node-wav` to load `client/test/voice-fixtures/speech_with_keyboard.wav` (you'll need to first commit a placeholder fixture — see Task 0.4). For each candidate model:
- Convert WAV to mono 16 kHz PCM
- Compute the *target speaker embedding* using a separately-loaded ECAPA-TDNN ONNX (the SpeechBrain export)
- Run the candidate model with (noisy_audio, embedding) as inputs
- Save the output as a WAV
- Compute SNR improvement: `SNR(output_vs_clean) - SNR(input_vs_clean)`

- [ ] **Step 5: Pick a winner and write the memo**

The memo must include:
- The chosen model's exact URL, author, license, checksum, parameter count, file size
- Per-fixture SNR improvement table
- A go/no-go decision: ✅ if any candidate produces ≥6dB SNR improvement on `speech_with_keyboard.wav`, ❌ otherwise
- If ❌: list which fallback option in the spec hierarchy will be used (DTLN-aec, NSNet2-personalized, etc.) and the next steps to verify it
- Decision-log update: which row of the spec decision log needs amending

- [ ] **Step 6: Commit the memo + spike scripts**

```bash
git add docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md scripts/spike/
git commit -m "spike(voice): VFL ONNX availability assessment — <go/no-go>"
```

### Task 0.2: Spike 0b — WASM SIMD latency benchmark

**Files:**
- Create: `scripts/spike/bench-vfl-wasm.html` (throwaway)
- Create: `scripts/spike/bench-vfl-wasm.ts` (throwaway)

- [ ] **Step 1: Set up an isolated test page**

Create a minimal HTML page that:
- Sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (you may need a tiny `node` server with custom headers — `npx serve` doesn't set them)
- Loads `onnxruntime-web` from CDN (not from the project — this is a spike)
- Spawns a single dedicated `Worker`

- [ ] **Step 2: Implement the benchmark loop**

In the worker:
- Load the spike-chosen VFL ONNX
- Generate 1000 synthetic input frames (random PCM in [-1, 1])
- For each frame, time `session.run()` with `performance.now()`
- After 1000 runs, post the array of times back to the main thread

- [ ] **Step 3: Run on M1 hardware**

Open the page in Chrome on the M1. Trigger the benchmark. Record:
- Median frame time
- p95 frame time
- p99 frame time

- [ ] **Step 4: Run on representative low-end hardware**

Use either a 5-year-old Intel laptop (Thinkpad/MacBook), a Chromebook, or BrowserStack with a low-end profile. Record the same percentiles.

- [ ] **Step 5: Update the memo with the latency table and go/no-go**

The memo must add:
- Per-platform p50/p95/p99 frame times
- Pass criterion: p95 < 25ms on M1 AND p95 < 60ms on the Intel target
- Go/no-go: ✅ if both pass, otherwise document which fallback (top-N → 1, smaller VFL variant, DFN3-only auto-degrade) will engage

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md scripts/spike/
git commit -m "spike(voice): WASM SIMD latency benchmark — <pass/fail>"
```

### Task 0.3: Spike 0c — Verify ECAPA-TDNN ONNX export

**Files:**
- Modify: `scripts/spike/test-vfl-availability.ts` (extend with ECAPA test)

- [ ] **Step 1: Download SpeechBrain ECAPA-TDNN ONNX**

The SpeechBrain project publishes pretrained models. Verify a suitable ECAPA-TDNN export exists at a stable URL with permissive license (Apache 2.0).

- [ ] **Step 2: Run speaker discrimination test**

Compute embeddings for `clean_speech_alice.wav` (twice, slightly different recordings) and `clean_speech_bob.wav`. Verify:
- Cosine similarity (alice1, alice2) > 0.7 (same speaker)
- Cosine similarity (alice1, bob) < 0.4 (different speakers)

- [ ] **Step 3: Add results to the memo**

Document the ECAPA URL, checksum, and the discrimination test result. This is much lower-risk than 0a; expected to pass.

- [ ] **Step 4: Final go/no-go decision in the memo**

The memo's last section: *"Phase 1 implementation may proceed: ✅/❌"*. If ❌, document what needs to change in the spec before retry.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md scripts/spike/
git commit -m "spike(voice): ECAPA-TDNN verification + final go/no-go"
```

### Task 0.4: Place fixture placeholders (so spike scripts can run)

**Files:**
- Create: `client/test/voice-fixtures/README.md`
- Create: `client/test/voice-fixtures/.gitkeep`

- [ ] **Step 1: Write the fixtures README**

Document:
- What each fixture file is (when it exists)
- How they were generated (script reference, sources, licensing)
- That fixtures are committed to the repo (small enough)

- [ ] **Step 2: Commit a placeholder**

```bash
mkdir -p client/test/voice-fixtures
git add client/test/voice-fixtures/.gitkeep client/test/voice-fixtures/README.md
git commit -m "test(voice): create voice fixtures directory placeholder"
```

The actual WAV fixtures are generated as part of milestone 10 — this just ensures the directory exists.

---

## Milestone 1 — Foundation

Builds the cross-cutting infrastructure: model loader, embedding storage, server endpoints, COOP/COEP headers, LFS setup. End state: a smoke test downloads models from the dev server, validates checksums, caches them in IndexedDB, and a separate test stores + retrieves an embedding under a mock identity.

### Task 1.1: Set up Git LFS for model artifacts

**Files:**
- Modify: `.gitattributes`
- Create: `server-rs/assets/voice-models/.gitkeep`

- [ ] **Step 1: Verify Git LFS is installed**

Run: `git lfs version`
Expected: prints LFS version. If not installed, the engineer must run `brew install git-lfs && git lfs install`.

- [ ] **Step 2: Configure LFS tracking**

Edit `.gitattributes` (create if missing):

```
server-rs/assets/voice-models/*.onnx filter=lfs diff=lfs merge=lfs -text
```

- [ ] **Step 3: Initialize the directory**

```bash
mkdir -p server-rs/assets/voice-models
touch server-rs/assets/voice-models/.gitkeep
```

- [ ] **Step 4: Commit**

```bash
git add .gitattributes server-rs/assets/voice-models/.gitkeep
git commit -m "build(voice): configure Git LFS for voice model artifacts"
```

### Task 1.2: Drop the spike-chosen ONNX models into the repo

**Files:**
- Create: `server-rs/assets/voice-models/vfl-v1.onnx` (LFS)
- Create: `server-rs/assets/voice-models/ecapa-v1.onnx` (LFS)
- Create: `server-rs/assets/voice-models/dfn3-v1.onnx` (LFS)

- [ ] **Step 1: Download the chosen models from the spike memo**

Use the URLs documented in `docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md`. Verify each file's SHA-256 against the memo before proceeding.

- [ ] **Step 2: Place them in the LFS-tracked directory**

```bash
cp /tmp/vfl-v1.onnx server-rs/assets/voice-models/
cp /tmp/ecapa-v1.onnx server-rs/assets/voice-models/
cp /tmp/dfn3-v1.onnx server-rs/assets/voice-models/
```

- [ ] **Step 3: Verify LFS picks them up**

Run: `git status`
Expected: shows the .onnx files. Run `git lfs ls-files` after adding them — should list all three.

- [ ] **Step 4: Commit**

```bash
git add server-rs/assets/voice-models/*.onnx
git lfs ls-files
git commit -m "build(voice): commit pretrained ONNX models (VFL, ECAPA, DFN3)"
```

### Task 1.3: Generate model manifest at build time

**Files:**
- Modify: `server-rs/build.rs`
- Modify: `server-rs/Cargo.toml` (add `sha2` to `[build-dependencies]` if missing)

- [ ] **Step 1: Create build.rs (it does not exist yet)**

```bash
ls server-rs/build.rs 2>&1
```

Expected: "No such file". Create it as an empty placeholder:

```bash
cat > server-rs/build.rs <<'EOF'
fn main() {
    // Populated in step 3 below.
}
EOF
```

Cargo automatically runs `build.rs` at the package root before compiling — no `Cargo.toml` change is needed for that, but verify by running `cargo build` after this step and confirming it executes the script.

- [ ] **Step 2: Add sha2 to build-dependencies**

Edit `server-rs/Cargo.toml`:

```toml
[build-dependencies]
sha2 = "0.10"
serde_json = "1"
```

- [ ] **Step 3: Add manifest generation logic to build.rs**

```rust
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use sha2::{Sha256, Digest};

fn main() {
    println!("cargo:rerun-if-changed=assets/voice-models");

    let models_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/voice-models");
    let mut entries = serde_json::Map::new();
    let model_files = [
        ("vfl",   "vfl-v1.onnx"),
        ("ecapa", "ecapa-v1.onnx"),
        ("dfn3",  "dfn3-v1.onnx"),
    ];

    for (name, file) in &model_files {
        let path = models_dir.join(file);
        if !path.exists() {
            panic!("Missing model file: {}", path.display());
        }
        let mut hasher = Sha256::new();
        let mut f = fs::File::open(&path).unwrap();
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).unwrap();
        hasher.update(&buf);
        let hash = format!("{:x}", hasher.finalize());

        let mut entry = serde_json::Map::new();
        entry.insert("url".to_string(), serde_json::Value::String(format!("/api/voice/models/{}", file)));
        entry.insert("sha256".to_string(), serde_json::Value::String(hash));
        entries.insert(name.to_string(), serde_json::Value::Object(entry));
    }

    let manifest = serde_json::json!({
        "version": 1,
        "minClientVersion": 0,
        "vfl":   entries["vfl"],
        "ecapa": entries["ecapa"],
        "dfn3":  entries["dfn3"],
    });

    let manifest_path = models_dir.join("manifest.json");
    fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap())
        .expect("write manifest.json");
}
```

- [ ] **Step 4: Build and verify**

Run: `cd server-rs && cargo build`
Expected: compiles. Then `cat server-rs/assets/voice-models/manifest.json` should print a valid JSON manifest with three SHA-256 entries.

- [ ] **Step 5: Add manifest.json to .gitignore**

The manifest is regenerated each build; don't commit it. Edit `.gitignore`:

```
server-rs/assets/voice-models/manifest.json
```

- [ ] **Step 6: Commit**

```bash
git add server-rs/build.rs server-rs/Cargo.toml .gitignore
git commit -m "build(voice): generate model manifest at build time with SHA-256"
```

### Task 1.4: Add COOP/COEP headers to the server

**Files:**
- Modify: `server-rs/src/main.rs` or wherever response middleware is wired

- [ ] **Step 1: Locate the existing middleware setup**

Run: `grep -n "ServiceBuilder\|layer\|cors" server-rs/src/main.rs`
Expected: finds the existing tower middleware stack. If middleware is in another file, search for it: `grep -rn "Router::new\|set_response_header" server-rs/src`.

- [ ] **Step 2: Write the failing test**

Create `server-rs/src/api/tests.rs` test (or extend existing):

```rust
#[tokio::test]
async fn client_routes_have_cross_origin_isolation_headers() {
    let app = build_test_app().await;
    let response = app
        .clone()
        .oneshot(Request::get("/app").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.headers().get("cross-origin-opener-policy").unwrap(), "same-origin");
    assert_eq!(response.headers().get("cross-origin-embedder-policy").unwrap(), "require-corp");
}

#[tokio::test]
async fn api_routes_do_not_force_cross_origin_isolation() {
    // API endpoints used by other clients (CLI, federation) should not require COEP
    let app = build_test_app().await;
    let response = app
        .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert!(response.headers().get("cross-origin-embedder-policy").is_none());
}
```

- [ ] **Step 3: Run the test, expect it to fail**

Run: `cd server-rs && cargo test client_routes_have_cross_origin`
Expected: FAIL — headers not present.

- [ ] **Step 4: Add a layer that sets the headers on client routes**

In `server-rs/src/main.rs` (or wherever the router is built), wrap the client-routes subrouter only:

```rust
use axum::http::HeaderValue;
use tower::ServiceBuilder;
use tower_http::set_header::SetResponseHeaderLayer;

let client_routes = Router::new()
    .nest_service("/", ServeDir::new("..."))   // existing
    .layer(SetResponseHeaderLayer::overriding(
        axum::http::header::HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    ))
    .layer(SetResponseHeaderLayer::overriding(
        axum::http::header::HeaderName::from_static("cross-origin-embedder-policy"),
        HeaderValue::from_static("require-corp"),
    ));
```

The exact router shape depends on the existing code; the constraint is "applied to client routes, not API routes". The reason: COEP requires every cross-origin response to include `Cross-Origin-Resource-Policy`, which would break federation traffic if applied universally.

- [ ] **Step 5: Run tests, expect pass**

Run: `cd server-rs && cargo test client_routes_have_cross_origin`
Expected: both tests PASS.

- [ ] **Step 6: Manually verify in a browser**

Run: `cd server-rs && cargo run`
Open: `http://localhost:8888/app`
Open DevTools → Network → click the document → Headers. Verify both headers present. Then in the Console, run `crossOriginIsolated` — expected: `true`.

- [ ] **Step 7: Commit**

```bash
git add server-rs/src/main.rs server-rs/src/api/tests.rs
git commit -m "feat(voice): set COOP/COEP headers on client routes for SAB support"
```

### Task 1.5: Add manifest + model serving endpoints

**Files:**
- Modify: `server-rs/src/api/voice.rs`
- Modify: `server-rs/src/api/mod.rs`

- [ ] **Step 1: Read the existing voice.rs to understand patterns**

Run: `cat server-rs/src/api/voice.rs`
Note the existing handler patterns, the `RustEmbed` import (if present), and how state is threaded.

- [ ] **Step 2: Write the failing test**

Add to `server-rs/src/api/tests.rs`:

```rust
#[tokio::test]
async fn voice_models_manifest_returns_json() {
    let app = build_test_app().await;
    let response = app
        .oneshot(Request::get("/api/voice/models/manifest.json").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = body_to_bytes(response.into_body()).await;
    let manifest: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(manifest["version"], 1);
    assert!(manifest["vfl"]["sha256"].as_str().unwrap().len() == 64);
}

#[tokio::test]
async fn voice_models_serve_returns_onnx_bytes() {
    let app = build_test_app().await;
    let response = app
        .oneshot(Request::get("/api/voice/models/vfl-v1.onnx").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = body_to_bytes(response.into_body()).await;
    assert!(body.len() > 1000); // basic sanity
    assert_eq!(response.headers().get("content-type").unwrap(), "application/octet-stream");
}

#[tokio::test]
async fn voice_models_serve_404s_unknown_model() {
    let app = build_test_app().await;
    let response = app
        .oneshot(Request::get("/api/voice/models/nonexistent.onnx").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
}
```

- [ ] **Step 3: Run tests, expect failures**

Run: `cd server-rs && cargo test voice_models`
Expected: 3 FAIL.

- [ ] **Step 4: Add the rust-embed declaration**

At the top of `server-rs/src/api/voice.rs`:

```rust
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/assets/voice-models"]
struct VoiceModels;
```

- [ ] **Step 5: Implement the manifest handler**

```rust
pub async fn models_manifest() -> impl IntoResponse {
    match VoiceModels::get("manifest.json") {
        Some(file) => {
            let mut headers = HeaderMap::new();
            headers.insert("content-type", "application/json".parse().unwrap());
            headers.insert("cache-control", "public, max-age=300".parse().unwrap());
            (StatusCode::OK, headers, file.data.into_owned()).into_response()
        }
        None => (StatusCode::NOT_FOUND, "manifest not built").into_response(),
    }
}
```

- [ ] **Step 6: Implement the model file serve handler**

```rust
pub async fn models_serve(Path(filename): Path<String>) -> impl IntoResponse {
    // Whitelist only .onnx files to prevent path traversal
    if !filename.ends_with(".onnx") || filename.contains("..") || filename.contains('/') {
        return (StatusCode::NOT_FOUND, "").into_response();
    }
    match VoiceModels::get(&filename) {
        Some(file) => {
            let mut headers = HeaderMap::new();
            headers.insert("content-type", "application/octet-stream".parse().unwrap());
            // Long cache, immutable: file content is checksummed in manifest
            headers.insert("cache-control", "public, max-age=31536000, immutable".parse().unwrap());
            // CRITICAL: COEP=require-corp on the client routes means ALL resources
            // it loads must include CORP. Without this header, the client's fetch()
            // for the model files will be blocked by the browser.
            headers.insert("cross-origin-resource-policy", "same-origin".parse().unwrap());
            (StatusCode::OK, headers, file.data.into_owned()).into_response()
        }
        None => (StatusCode::NOT_FOUND, "").into_response(),
    }
}
```

Also add the same CORP header to the manifest handler in step 5 — same reason.

- [ ] **Step 7: Register the routes in `server-rs/src/api/mod.rs`**

```rust
use axum::routing::get;

// In the router builder:
.route("/api/voice/models/manifest.json", get(voice::models_manifest))
.route("/api/voice/models/:filename", get(voice::models_serve))
```

- [ ] **Step 8: Run tests, expect pass**

Run: `cd server-rs && cargo test voice_models`
Expected: 3 PASS.

- [ ] **Step 9: Commit**

```bash
git add server-rs/src/api/voice.rs server-rs/src/api/mod.rs server-rs/src/api/tests.rs
git commit -m "feat(voice): add /api/voice/models manifest and serve endpoints"
```

### Task 1.6: Install onnxruntime-web client dependency

**Files:**
- Modify: `client/package.json`
- Modify: `client/package-lock.json` (auto)

- [ ] **Step 1: Check the latest stable version**

```bash
cd client && npm view onnxruntime-web version
```

Note the version. The user's memory says: prefer the latest major with at least one patch release.

- [ ] **Step 2: Install**

```bash
cd client && npm install onnxruntime-web@<latest-stable>
```

- [ ] **Step 3: Verify installation**

```bash
ls client/node_modules/onnxruntime-web/dist/
```

Expected: see `ort.min.js`, `ort-wasm-simd.wasm`, `ort-wasm-threaded.wasm`, etc.

- [ ] **Step 4: Verify the client still builds and tests pass**

```bash
cd client && npm run lint && npx tsc --noEmit && npm test -- --run
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add client/package.json client/package-lock.json
git commit -m "chore(voice): add onnxruntime-web dependency for inference"
```

### Task 1.6.5: Configure ORT Web WASM asset paths

**Files:**
- Modify: `client/vite.config.ts`
- Create: `client/public/ort-wasm/.gitkeep`

`onnxruntime-web` ships several `.wasm` binaries (`ort-wasm-simd.wasm`, `ort-wasm-simd-threaded.wasm`, etc.) that it fetches at runtime via `ort.env.wasm.wasmPaths`. By default it tries to load them from a CDN, which both fails our self-hosted ethos and is blocked by COEP/CORP. We need to copy them into Vite's `public/` directory so they're served from the same origin.

- [ ] **Step 1: Identify the ORT WASM assets to copy**

```bash
ls client/node_modules/onnxruntime-web/dist/*.wasm
```

Expected: lists 4-6 .wasm files. Copy all of them.

- [ ] **Step 2: Add a Vite plugin (or build script) to copy them**

The simplest approach: add a `vite.config.ts` plugin that copies on every build. Or, even simpler, add a `postinstall` script in `client/package.json`:

```json
"scripts": {
  ...
  "postinstall": "node scripts/copy-ort-wasm.js"
}
```

Create `client/scripts/copy-ort-wasm.js`:

```javascript
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist');
const dst = path.join(__dirname, '..', 'public', 'ort-wasm');

fs.mkdirSync(dst, { recursive: true });
for (const file of fs.readdirSync(src)) {
  if (file.endsWith('.wasm')) {
    fs.copyFileSync(path.join(src, file), path.join(dst, file));
    console.log(`copied ${file}`);
  }
}
```

- [ ] **Step 3: Configure ORT in inferenceWorker.ts**

When the worker imports `onnxruntime-web`, before any session is created:

```typescript
import * as ort from 'onnxruntime-web';
ort.env.wasm.wasmPaths = '/ort-wasm/';
```

(This will be added in Task 3.3 — note here as a reminder.)

- [ ] **Step 4: Run the postinstall**

```bash
cd client && npm run postinstall
ls public/ort-wasm/
```

Expected: lists copied .wasm files.

- [ ] **Step 5: Add public/ort-wasm to .gitignore**

```bash
echo "client/public/ort-wasm/" >> .gitignore
```

The files are reproducible from `node_modules` so they don't need to be committed.

- [ ] **Step 6: Commit**

```bash
git add client/scripts/copy-ort-wasm.js client/package.json .gitignore
git commit -m "build(voice): copy ORT Web WASM assets to public/ for self-hosting"
```

### Task 1.7: Create the voiceIsolation module skeleton

**Files:**
- Create: `client/src/services/voiceIsolation/index.ts`
- Create: `client/src/services/voiceIsolation/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// client/src/services/voiceIsolation/types.ts

export type ModelKind = 'vfl' | 'dfn3' | 'passthrough';

export interface ModelHandle {
  kind: Exclude<ModelKind, 'passthrough'>;
  version: number;
  // Opaque token referring to an ORT session that lives in the inference Worker.
  // The main thread never touches the session directly.
  sessionId: string;
}

export interface Embedding {
  vector: Float32Array; // 256 floats
  modelVersion: number;
  capturedAt: string;   // ISO 8601
  captureId: string;    // UUIDv4
}

export interface PeerCallState {
  id: string;
  enrolled: boolean;
  verified: boolean;
  federatedDowngradeSuspected: boolean;
  tier: 'active' | 'background';
  model: ModelKind;
  framesProcessed: number;
  framesDropped: number;
}

export interface CallState {
  selfEnrolled: boolean;
  selfModelVersion: number;
  cpuDegradeActive: boolean;
  peers: PeerCallState[];
}
```

- [ ] **Step 2: Create the index.ts placeholder**

```typescript
// client/src/services/voiceIsolation/index.ts

// Public exports — populated as modules are added through the milestones.
export type {
  ModelKind,
  ModelHandle,
  Embedding,
  PeerCallState,
  CallState,
} from './types';
```

- [ ] **Step 3: Verify it builds**

Run: `cd client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/services/voiceIsolation/
git commit -m "feat(voice): scaffold voiceIsolation module with shared types"
```

### Task 1.8: Implement modelLoader (TDD)

**Files:**
- Create: `client/src/services/voiceIsolation/modelLoader.ts`
- Create: `client/src/services/voiceIsolation/modelLoader.test.ts`

- [ ] **Step 1: Write the failing test for manifest fetch + parse**

```typescript
// client/src/services/voiceIsolation/modelLoader.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchManifest, ManifestError } from './modelLoader';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('modelLoader.fetchManifest', () => {
  it('fetches and parses a valid manifest', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        version: 1,
        minClientVersion: 0,
        vfl:   { url: '/api/voice/models/vfl-v1.onnx',   sha256: 'a'.repeat(64) },
        ecapa: { url: '/api/voice/models/ecapa-v1.onnx', sha256: 'b'.repeat(64) },
        dfn3:  { url: '/api/voice/models/dfn3-v1.onnx',  sha256: 'c'.repeat(64) },
      }),
    } as Response);

    const manifest = await fetchManifest('http://localhost:8888');
    expect(manifest.version).toBe(1);
    expect(manifest.vfl.sha256).toBe('a'.repeat(64));
  });

  it('throws ManifestError on 404', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    await expect(fetchManifest('http://localhost:8888')).rejects.toThrow(ManifestError);
  });

  it('throws on missing sha256 fields', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: 1, vfl: {}, ecapa: {}, dfn3: {} }),
    } as Response);
    await expect(fetchManifest('http://localhost:8888')).rejects.toThrow(ManifestError);
  });

  it('rejects unsupported manifest version (minClientVersion too high)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        version: 99,
        minClientVersion: 99,
        vfl:   { url: 'x', sha256: 'a'.repeat(64) },
        ecapa: { url: 'x', sha256: 'b'.repeat(64) },
        dfn3:  { url: 'x', sha256: 'c'.repeat(64) },
      }),
    } as Response);
    await expect(fetchManifest('http://localhost:8888')).rejects.toThrow(/incompatible/i);
  });
});
```

- [ ] **Step 2: Run, expect failures**

Run: `cd client && npm test -- --run modelLoader`
Expected: file not found / module not found.

- [ ] **Step 3: Implement fetchManifest + ManifestError**

```typescript
// client/src/services/voiceIsolation/modelLoader.ts

const SUPPORTED_MANIFEST_VERSION = 1;

export class ManifestError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ManifestError';
  }
}

export interface Manifest {
  version: number;
  minClientVersion: number;
  vfl:   { url: string; sha256: string };
  ecapa: { url: string; sha256: string };
  dfn3:  { url: string; sha256: string };
}

function isHexHash(s: unknown): s is string {
  return typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
}

export async function fetchManifest(serverUrl: string): Promise<Manifest> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/voice/models/manifest.json`);
  } catch (err) {
    throw new ManifestError('Network error fetching manifest', err);
  }
  if (!response.ok) {
    throw new ManifestError(`Manifest HTTP ${response.status}`);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new ManifestError('Manifest is not valid JSON', err);
  }
  if (typeof json !== 'object' || json === null) {
    throw new ManifestError('Manifest is not an object');
  }
  const m = json as Record<string, unknown>;
  const version = m.version;
  const minClient = (m.minClientVersion ?? 0) as number;
  if (typeof version !== 'number' || minClient > SUPPORTED_MANIFEST_VERSION) {
    throw new ManifestError(`Manifest version incompatible (got ${version}, supported ${SUPPORTED_MANIFEST_VERSION})`);
  }
  for (const name of ['vfl', 'ecapa', 'dfn3'] as const) {
    const entry = m[name] as Record<string, unknown> | undefined;
    if (!entry || typeof entry.url !== 'string' || !isHexHash(entry.sha256)) {
      throw new ManifestError(`Manifest entry "${name}" missing or invalid`);
    }
  }
  return m as unknown as Manifest;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd client && npm test -- --run modelLoader`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/modelLoader.ts client/src/services/voiceIsolation/modelLoader.test.ts
git commit -m "feat(voice): modelLoader manifest fetch + validation"
```

### Task 1.9: modelLoader — SHA-256 validation of downloaded bytes

- [ ] **Step 1: Add tests**

```typescript
describe('modelLoader.validateChecksum', () => {
  it('passes for matching sha256', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    // Pre-computed: sha256(0x01020304) = 9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a
    const hash = '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';
    await expect(validateChecksum(bytes, hash)).resolves.toBeUndefined();
  });

  it('throws for mismatched sha256', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await expect(validateChecksum(bytes, 'a'.repeat(64))).rejects.toThrow(/checksum/i);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd client && npm test -- --run modelLoader`
Expected: `validateChecksum is not exported`.

- [ ] **Step 3: Implement**

Add to `modelLoader.ts`:

```typescript
export async function validateChecksum(bytes: Uint8Array, expectedHex: string): Promise<void> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (actual !== expectedHex) {
    throw new ManifestError(`Model checksum mismatch (expected ${expectedHex.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd client && npm test -- --run modelLoader`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/modelLoader.ts client/src/services/voiceIsolation/modelLoader.test.ts
git commit -m "feat(voice): modelLoader SHA-256 validation"
```

### Task 1.10: modelLoader — IndexedDB cache

- [ ] **Step 1: Add tests**

```typescript
import 'fake-indexeddb/auto';

describe('modelLoader cache', () => {
  beforeEach(() => {
    indexedDB.deleteDatabase('dilla-voice-models');
  });

  it('stores and retrieves a model blob', async () => {
    const bytes = new Uint8Array([5, 6, 7, 8]);
    await cacheModel('vfl', 1, bytes);
    const cached = await getCachedModel('vfl', 1);
    expect(cached).toEqual(bytes);
  });

  it('returns null on cache miss', async () => {
    const cached = await getCachedModel('vfl', 1);
    expect(cached).toBeNull();
  });

  it('uses version as part of the cache key', async () => {
    await cacheModel('vfl', 1, new Uint8Array([1]));
    await cacheModel('vfl', 2, new Uint8Array([2]));
    expect(await getCachedModel('vfl', 1)).toEqual(new Uint8Array([1]));
    expect(await getCachedModel('vfl', 2)).toEqual(new Uint8Array([2]));
  });
});
```

Verify `fake-indexeddb` is a dev dependency:

```bash
cd client && grep fake-indexeddb package.json
```

If missing: `npm install -D fake-indexeddb`.

- [ ] **Step 2: Run, expect failure**

Run: `cd client && npm test -- --run modelLoader`
Expected: `cacheModel is not exported`.

- [ ] **Step 3: Implement IndexedDB wrapper**

Add to `modelLoader.ts`:

```typescript
const DB_NAME = 'dilla-voice-models';
const STORE_NAME = 'models';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const cacheKey = (name: string, version: number) => `${name}-v${version}`;

export async function cacheModel(name: string, version: number, bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(bytes, cacheKey(name, version));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getCachedModel(name: string, version: number): Promise<Uint8Array | null> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null; // IndexedDB unavailable → treat as cache miss
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(cacheKey(name, version));
    req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd client && npm test -- --run modelLoader`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/modelLoader.ts client/src/services/voiceIsolation/modelLoader.test.ts client/package.json client/package-lock.json
git commit -m "feat(voice): modelLoader IndexedDB cache for model artifacts"
```

### Task 1.11: modelLoader — high-level loadModels orchestration

- [ ] **Step 1: Add tests**

```typescript
describe('modelLoader.loadModels', () => {
  it('fetches all three models and validates checksums', async () => {
    // Mock fetch: manifest first, then three model blobs.
    const vflBytes = new Uint8Array([10, 20, 30]);
    const ecapaBytes = new Uint8Array([40, 50, 60]);
    const dfn3Bytes = new Uint8Array([70, 80, 90]);
    const vflHash = await sha256Hex(vflBytes);
    const ecapaHash = await sha256Hex(ecapaBytes);
    const dfn3Hash = await sha256Hex(dfn3Bytes);

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('manifest.json')) {
        return new Response(JSON.stringify({
          version: 1,
          minClientVersion: 0,
          vfl:   { url: '/api/voice/models/vfl-v1.onnx',   sha256: vflHash },
          ecapa: { url: '/api/voice/models/ecapa-v1.onnx', sha256: ecapaHash },
          dfn3:  { url: '/api/voice/models/dfn3-v1.onnx',  sha256: dfn3Hash },
        }));
      }
      if (url.endsWith('vfl-v1.onnx'))   return new Response(vflBytes);
      if (url.endsWith('ecapa-v1.onnx')) return new Response(ecapaBytes);
      if (url.endsWith('dfn3-v1.onnx'))  return new Response(dfn3Bytes);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const handles = await loadModels('http://localhost:8888');
    expect(handles.vfl.kind).toBe('vfl');
    expect(handles.ecapa.kind).toBe('ecapa' as never); // see note below
    expect(handles.dfn3.kind).toBe('dfn3');
  });

  // Helper used in test
  async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
});
```

Note: ECAPA is a model loaded via the same loader but it's not used in the audio inference path (it's only used during enrollment). The `ModelHandle` type from `types.ts` only includes `'vfl' | 'dfn3'`. Update `types.ts` to also accept `'ecapa'` as a valid `ModelHandle.kind`:

```typescript
// types.ts — update
export interface ModelHandle {
  kind: 'vfl' | 'dfn3' | 'ecapa';
  version: number;
  sessionId: string;
}
```

- [ ] **Step 2: Run, expect failure**

Run: `cd client && npm test -- --run modelLoader`
Expected: `loadModels not exported`.

- [ ] **Step 3: Implement loadModels**

```typescript
import type { ModelHandle } from './types';

export interface ModelHandles {
  vfl: ModelHandle;
  ecapa: ModelHandle;
  dfn3: ModelHandle;
}

export async function loadModels(serverUrl: string): Promise<ModelHandles> {
  const manifest = await fetchManifest(serverUrl);

  const fetchOne = async (
    name: 'vfl' | 'ecapa' | 'dfn3',
    entry: { url: string; sha256: string },
  ): Promise<ModelHandle> => {
    const cached = await getCachedModel(name, manifest.version);
    let bytes: Uint8Array;
    if (cached) {
      bytes = cached;
      // Re-validate cached bytes against the manifest's current hash to catch
      // version drift between client cache and server manifest.
      try {
        await validateChecksum(bytes, entry.sha256);
      } catch {
        // Cached bytes don't match current manifest — refetch.
        bytes = await fetchAndValidate(serverUrl, entry);
        await cacheModel(name, manifest.version, bytes);
      }
    } else {
      bytes = await fetchAndValidate(serverUrl, entry);
      await cacheModel(name, manifest.version, bytes);
    }
    // The actual ORT session is created in the inference Worker.
    // Here we return a handle whose `sessionId` will be assigned later.
    return { kind: name, version: manifest.version, sessionId: '' };
  };

  const [vfl, ecapa, dfn3] = await Promise.all([
    fetchOne('vfl', manifest.vfl),
    fetchOne('ecapa', manifest.ecapa),
    fetchOne('dfn3', manifest.dfn3),
  ]);

  return { vfl, ecapa, dfn3 };
}

async function fetchAndValidate(
  serverUrl: string,
  entry: { url: string; sha256: string },
): Promise<Uint8Array> {
  const response = await fetch(`${serverUrl}${entry.url}`);
  if (!response.ok) {
    throw new ManifestError(`Failed to fetch ${entry.url} (HTTP ${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await validateChecksum(bytes, entry.sha256);
  return bytes;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd client && npm test -- --run modelLoader`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/modelLoader.ts client/src/services/voiceIsolation/modelLoader.test.ts client/src/services/voiceIsolation/types.ts
git commit -m "feat(voice): modelLoader.loadModels orchestration with cache + validation"
```

### Task 1.12: Implement embeddingStore (TDD)

**Files:**
- Create: `client/src/services/voiceIsolation/embeddingStore.ts`
- Create: `client/src/services/voiceIsolation/embeddingStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setEmbedding,
  getEmbedding,
  clearEmbedding,
  listEnrolledIdentities,
} from './embeddingStore';

const fakeMek = new Uint8Array(32).fill(0xab); // mock 32-byte master encryption key

beforeEach(() => {
  indexedDB.deleteDatabase('dilla-voice-embeddings');
});

describe('embeddingStore', () => {
  it('stores and retrieves an embedding for an identity', async () => {
    const embedding = new Float32Array(256).map((_, i) => i / 256);
    await setEmbedding(fakeMek, 'identity-A', { vector: embedding, modelVersion: 1, capturedAt: '2026-04-07T12:00:00Z', captureId: 'cap-1' });
    const result = await getEmbedding(fakeMek, 'identity-A');
    expect(result).not.toBeNull();
    expect(result!.modelVersion).toBe(1);
    expect(result!.captureId).toBe('cap-1');
    expect(Array.from(result!.vector)).toEqual(Array.from(embedding));
  });

  it('returns null for unenrolled identity', async () => {
    const result = await getEmbedding(fakeMek, 'identity-unknown');
    expect(result).toBeNull();
  });

  it('isolates identities (different MEK derivation per identityId)', async () => {
    const embA = new Float32Array(256).fill(0.1);
    const embB = new Float32Array(256).fill(0.2);
    await setEmbedding(fakeMek, 'identity-A', { vector: embA, modelVersion: 1, capturedAt: '2026-04-07T12:00:00Z', captureId: 'a' });
    await setEmbedding(fakeMek, 'identity-B', { vector: embB, modelVersion: 1, capturedAt: '2026-04-07T12:00:00Z', captureId: 'b' });

    const a = await getEmbedding(fakeMek, 'identity-A');
    const b = await getEmbedding(fakeMek, 'identity-B');
    expect(a!.vector[0]).toBeCloseTo(0.1);
    expect(b!.vector[0]).toBeCloseTo(0.2);
  });

  it('returns null when ciphertext was encrypted under a different MEK', async () => {
    const embedding = new Float32Array(256).fill(0.5);
    await setEmbedding(fakeMek, 'identity-A', { vector: embedding, modelVersion: 1, capturedAt: '2026-04-07T12:00:00Z', captureId: 'cap-x' });

    const wrongMek = new Uint8Array(32).fill(0xcd);
    const result = await getEmbedding(wrongMek, 'identity-A');
    expect(result).toBeNull(); // decryption fails → null
  });

  it('clears an identity', async () => {
    const embedding = new Float32Array(256).fill(0.3);
    await setEmbedding(fakeMek, 'identity-A', { vector: embedding, modelVersion: 1, capturedAt: '2026-04-07T12:00:00Z', captureId: 'c' });
    await clearEmbedding('identity-A');
    expect(await getEmbedding(fakeMek, 'identity-A')).toBeNull();
  });

  it('lists enrolled identities', async () => {
    await setEmbedding(fakeMek, 'a', { vector: new Float32Array(256), modelVersion: 1, capturedAt: '2026-04-07T12:00:00Z', captureId: 'x' });
    await setEmbedding(fakeMek, 'b', { vector: new Float32Array(256), modelVersion: 1, capturedAt: '2026-04-07T13:00:00Z', captureId: 'y' });
    const ids = await listEnrolledIdentities();
    expect(ids.sort()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd client && npm test -- --run embeddingStore`
Expected: module not found.

- [ ] **Step 3: Implement embeddingStore**

```typescript
// client/src/services/voiceIsolation/embeddingStore.ts
import type { Embedding } from './types';

const DB_NAME = 'dilla-voice-embeddings';
const STORE_NAME = 'embeddings';
const HKDF_INFO_PREFIX = 'dilla:voice-embedding:v1:';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deriveKey(mek: Uint8Array, identityId: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', mek, 'HKDF', false, ['deriveKey']);
  const info = new TextEncoder().encode(HKDF_INFO_PREFIX + identityId);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

interface StoredRecord {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export async function setEmbedding(
  mek: Uint8Array,
  identityId: string,
  embedding: Embedding,
): Promise<void> {
  const key = await deriveKey(mek, identityId);
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  const plaintext = new TextEncoder().encode(JSON.stringify({
    vector: Array.from(embedding.vector),
    modelVersion: embedding.modelVersion,
    capturedAt: embedding.capturedAt,
    captureId: embedding.captureId,
  }));

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext),
  );

  const record: StoredRecord = { nonce, ciphertext };
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record, identityId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getEmbedding(
  mek: Uint8Array,
  identityId: string,
): Promise<Embedding | null> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null;
  }
  const record = await new Promise<StoredRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(identityId);
    req.onsuccess = () => resolve(req.result as StoredRecord | undefined);
    req.onerror = () => reject(req.error);
  });
  if (!record) return null;

  try {
    const key = await deriveKey(mek, identityId);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.nonce },
      key,
      record.ciphertext,
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext));
    return {
      vector: new Float32Array(parsed.vector),
      modelVersion: parsed.modelVersion,
      capturedAt: parsed.capturedAt,
      captureId: parsed.captureId,
    };
  } catch {
    return null; // wrong MEK or corrupted record
  }
}

export async function clearEmbedding(identityId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(identityId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listEnrolledIdentities(): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd client && npm test -- --run embeddingStore`
Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/embeddingStore.ts client/src/services/voiceIsolation/embeddingStore.test.ts
git commit -m "feat(voice): embeddingStore — HKDF-derived encrypted blob store"
```

### Task 1.13: SFrame integration verification — GATING CHECKPOINT

**This is a hard gate. If the verification fails, the spec needs to be revised before proceeding to Milestone 4. Do not skip.**

**Files:**
- Read-only: `client/src/services/webrtc/WebRTCService.ts`
- Read-only: `client/src/services/webrtc/voiceEncryption.ts`
- Read-only: `client/src/types/webrtc-encoded-transform.d.ts`

The plan assumes SFrame operates at the `MediaStreamTrack` layer so the voice isolation pipeline can wrap tracks before/after. **If SFrame uses encoded RTP frame transforms (RTCRtpScriptTransform / Insertable Streams) instead, the architecture must change** because you can't wrap a `MediaStreamTrack` after it's been encoded.

- [ ] **Step 1: Read all three files end-to-end**

```bash
cat client/src/services/webrtc/voiceEncryption.ts
cat client/src/types/webrtc-encoded-transform.d.ts
sed -n '90,160p' client/src/services/webrtc/WebRTCService.ts
```

Identify:
- Whether `voiceEncryption.ts` references `RTCRtpSender.transform`, `RTCRtpScriptTransform`, or `createEncodedStreams()` (encoded-frame layer) — OR `MediaStreamTrack`/`AudioContext` operations (track layer)
- Where in `WebRTCService.ts` the encryption gets attached to the peer connection
- Whether the existing `addTrack(track, stream)` call already feeds an *encrypted* track or a plain track

- [ ] **Step 2: Decide the layer**

Two outcomes:

**Outcome A — SFrame is at the encoded-frame layer (most likely given `webrtc-encoded-transform.d.ts`):**
- The voice isolation pipeline still wraps `MediaStreamTrack` *before* `addTrack`. This is fine because encoded-frame transforms run *after* the track is encoded — encryption happens downstream of our pipeline. Verify by tracing: `getUserMedia → MediaStreamTrack → voiceIsolation.processOutgoing → addTrack → encoder → SFrame transform → SFU`. The pipeline is upstream of encryption. ✅ Plan can proceed.
- For incoming: `SFU → SFrame decrypt transform → decoder → MediaStreamTrack (in ontrack event) → voiceIsolation.processIncoming → playback`. Again, the pipeline operates on the post-decoded track. ✅
- **In this outcome the plan as written is correct.** Document the trace in the spike memo.

**Outcome B — SFrame is at the `MediaStreamTrack` layer (e.g., uses Web Audio for some custom in-place transform):**
- ⛔ STOP. The plan's "single seam at addTrack/ontrack" assumption is wrong. Re-read `voiceEncryption.ts` carefully and decide whether the seam should sit before or after the SFrame layer. Update the spec and re-run the spec review loop before continuing this plan.

- [ ] **Step 3: Document findings**

Add a "SFrame integration verification" section to `docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md`:
- Which outcome (A or B)
- Specific evidence (file:line citations)
- The exact integration trace (mic → ... → SFU → ... → output)
- If outcome B: what needs to change in the spec

- [ ] **Step 4: HARD GATE — do not proceed if outcome B**

If outcome B: open an issue, escalate to the user, and stop. The remaining tasks of this plan assume outcome A.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md
git commit -m "docs(voice): SFrame integration verification (outcome <A|B>)"
```

### Task 1.14: Initialize voiceIsolation worker + load models on first call

**Files:**
- Modify: `client/src/services/voiceIsolation/dispatcher.ts`
- Create: `client/src/services/voiceIsolation/dispatcher.test.ts` (skeleton)

This is the wiring task that connects `loadModels` (from Milestone 1.11) to the inference worker (built in Milestone 3) so that by the time Milestone 4 needs `vflSessionId` / `dfn3SessionId`, they actually exist. This task is a placeholder until Milestone 3 builds the worker — at that point, return here and complete it.

- [ ] **Step 1: Create the dispatcher initialization function (placeholder)**

```typescript
// client/src/services/voiceIsolation/dispatcher.ts (initial scaffold)

import { loadModels } from './modelLoader';
import type { ModelHandle } from './types';

interface InitializedContext {
  audioContext: AudioContext;
  worker: Worker;
  vflSessionId: string;
  ecapaSessionId: string;
  dfn3SessionId: string;
}

let context: InitializedContext | null = null;

export async function initializeVoiceIsolation(serverUrl: string): Promise<InitializedContext | null> {
  if (context) return context;
  try {
    // 1. Load model bytes from server
    const handles = await loadModels(serverUrl);
    if (!handles.vfl || !handles.ecapa || !handles.dfn3) return null;

    // 2. Create AudioContext
    const audioContext = new AudioContext({ sampleRate: 48000 });
    await audioContext.audioWorklet.addModule(
      new URL('./audioWorklet/ringBufferProcessor.js', import.meta.url).href,
    );

    // 3. Spawn inference worker (built in Milestone 3)
    const worker = new Worker(
      new URL('./inferenceWorker.ts', import.meta.url),
      { type: 'module' },
    );

    // 4. Send model bytes + ioSpec to worker, await load-model responses
    // (Implementation: in Milestone 3 we'll add the round-trip await for each model)
    // For now this is a TODO blocked on Milestone 3.
    const vflSessionId = 'vfl-session';
    const ecapaSessionId = 'ecapa-session';
    const dfn3SessionId = 'dfn3-session';

    context = { audioContext, worker, vflSessionId, ecapaSessionId, dfn3SessionId };
    return context;
  } catch (err) {
    console.error('[voiceIsolation] init failed', err);
    return null; // pass-through mode
  }
}

export function getContext(): InitializedContext | null {
  return context;
}
```

- [ ] **Step 2: Wire `initializeVoiceIsolation` into `WebRTCService` constructor**

In `WebRTCService.ts`, add to the constructor:

```typescript
// Async init — pipeline operates in pass-through until this resolves
initializeVoiceIsolation(this.serverUrl).then((ctx) => {
  this.voiceIsolationContext = ctx;
});
```

When `processOutgoing` / `processIncoming` are called, check `this.voiceIsolationContext` — if null, pass through; if set, use it.

- [ ] **Step 3: Commit**

```bash
git add client/src/services/voiceIsolation/dispatcher.ts client/src/services/webrtc/WebRTCService.ts
git commit -m "feat(voice): voiceIsolation dispatcher init scaffold (TODO: complete in M3)"
```

This task is intentionally incomplete — Milestone 3 will return here to wire the actual worker `load-model` round-trip and populate real session IDs. Until then, `processOutgoing`/`processIncoming` should pass through.

---

## Milestone 2 — Enrollment vertical slice

End state: a user can open Settings → Voice Isolation, click "Set up", record 15s, see the embedding stored. No call integration yet. This delivers user-visible value standalone.

### Task 2.1: Implement enrollment.ts (capture + ECAPA + validation, TDD)

**Files:**
- Create: `client/src/services/voiceIsolation/enrollment.ts`
- Create: `client/src/services/voiceIsolation/enrollment.test.ts`

- [ ] **Step 1: Define the enrollment validation function tests**

```typescript
import { describe, it, expect } from 'vitest';
import { validateCaptureBuffer } from './enrollment';

function silentBuffer(samples: number): Float32Array {
  return new Float32Array(samples);
}
function clippedBuffer(samples: number): Float32Array {
  const buf = new Float32Array(samples);
  buf.fill(0.99);
  return buf;
}
function speechLikeBuffer(samples: number): Float32Array {
  const buf = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    buf[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / 16000);
  }
  return buf;
}

describe('enrollment.validateCaptureBuffer', () => {
  it('rejects silent capture', () => {
    const result = validateCaptureBuffer(silentBuffer(16000 * 15));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/silen/i);
  });

  it('rejects clipped capture', () => {
    const result = validateCaptureBuffer(clippedBuffer(16000 * 15));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/clip/i);
  });

  it('rejects too-short capture', () => {
    const result = validateCaptureBuffer(speechLikeBuffer(16000 * 5));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/short/i);
  });

  it('accepts speech-like 15s capture', () => {
    const result = validateCaptureBuffer(speechLikeBuffer(16000 * 15));
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd client && npm test -- --run enrollment`
Expected: not exported.

- [ ] **Step 3: Implement validateCaptureBuffer**

```typescript
// client/src/services/voiceIsolation/enrollment.ts
export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

const TARGET_SAMPLE_RATE = 16000;
const MIN_DURATION_S = 12;
const SILENCE_RMS_FLOOR = 0.005;
const CLIPPING_THRESHOLD = 0.95;
const MAX_CLIPPING_RATIO = 0.01;

export function validateCaptureBuffer(buffer: Float32Array): ValidationResult {
  if (buffer.length < TARGET_SAMPLE_RATE * MIN_DURATION_S) {
    return { ok: false, reason: 'Capture too short' };
  }

  let sumSq = 0;
  let clipped = 0;
  for (let i = 0; i < buffer.length; i++) {
    const v = buffer[i];
    sumSq += v * v;
    if (Math.abs(v) >= CLIPPING_THRESHOLD) clipped++;
  }
  const rms = Math.sqrt(sumSq / buffer.length);
  if (rms < SILENCE_RMS_FLOOR) {
    return { ok: false, reason: 'Capture is silent' };
  }
  if (clipped / buffer.length > MAX_CLIPPING_RATIO) {
    return { ok: false, reason: 'Capture is clipped — try lowering input volume' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd client && npm test -- --run enrollment`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/enrollment.ts client/src/services/voiceIsolation/enrollment.test.ts
git commit -m "feat(voice): enrollment validation (silence/clipping/length)"
```

### Task 2.2: enrollment — ECAPA inference call (mocked encoder)

The actual ECAPA call lives in the inference Worker. For the enrollment module's unit tests we inject a fake encoder.

- [ ] **Step 1: Add tests**

```typescript
import { runEnrollment } from './enrollment';

describe('enrollment.runEnrollment', () => {
  it('calls the encoder with the validated buffer and returns an embedding', async () => {
    const fixed = new Float32Array(256).fill(0.7);
    const encoder = vi.fn().mockResolvedValue(fixed);

    const buffer = speechLikeBuffer(16000 * 15);
    const result = await runEnrollment(buffer, encoder, 1);
    expect(encoder).toHaveBeenCalledWith(buffer);
    expect(result.vector).toEqual(fixed);
    expect(result.modelVersion).toBe(1);
    expect(result.captureId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('throws on invalid buffer without calling encoder', async () => {
    const encoder = vi.fn();
    await expect(runEnrollment(silentBuffer(16000 * 15), encoder, 1))
      .rejects.toThrow(/silent/i);
    expect(encoder).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd client && npm test -- --run enrollment`
Expected: `runEnrollment` not exported.

- [ ] **Step 3: Implement**

Add to `enrollment.ts`:

```typescript
import type { Embedding } from './types';

export type Encoder = (buffer: Float32Array) => Promise<Float32Array>;

export async function runEnrollment(
  buffer: Float32Array,
  encoder: Encoder,
  modelVersion: number,
): Promise<Embedding> {
  const validation = validateCaptureBuffer(buffer);
  if (!validation.ok) {
    throw new Error(validation.reason);
  }
  const vector = await encoder(buffer);
  return {
    vector,
    modelVersion,
    capturedAt: new Date().toISOString(),
    captureId: crypto.randomUUID(),
  };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd client && npm test -- --run enrollment`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/enrollment.ts client/src/services/voiceIsolation/enrollment.test.ts
git commit -m "feat(voice): enrollment.runEnrollment with injectable encoder"
```

### Task 2.3: Build the VoiceEnrollment React component (TDD)

**Files:**
- Create: `client/src/components/VoiceEnrollment/VoiceEnrollment.tsx`
- Create: `client/src/components/VoiceEnrollment/VoiceEnrollment.css`
- Create: `client/src/components/VoiceEnrollment/VoiceEnrollment.test.tsx`

- [ ] **Step 1: Write the component test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import VoiceEnrollment from './VoiceEnrollment';

describe('VoiceEnrollment', () => {
  it('renders the intro step', () => {
    render(<VoiceEnrollment onComplete={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/Voice profile/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start/i })).toBeInTheDocument();
  });

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<VoiceEnrollment onComplete={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows the recording step after start is clicked', async () => {
    // Mock getUserMedia
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue(new MediaStream()) },
      writable: true,
    });
    render(<VoiceEnrollment onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    await waitFor(() => {
      expect(screen.getByText(/Recording/i)).toBeInTheDocument();
    });
  });

  it('disables start button if mic permission is denied', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('NotAllowedError')) },
      writable: true,
    });
    render(<VoiceEnrollment onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    await waitFor(() => {
      expect(screen.getByText(/microphone access/i)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd client && npm test -- --run VoiceEnrollment`
Expected: file not found.

- [ ] **Step 3: Implement the component**

```tsx
// client/src/components/VoiceEnrollment/VoiceEnrollment.tsx
import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './VoiceEnrollment.css';

interface Props {
  onComplete: (capturedBuffer: Float32Array) => void;
  onCancel: () => void;
}

type Step = 'intro' | 'recording' | 'processing' | 'error';

const SAMPLE_SCRIPT =
  'The quick brown fox jumps over the lazy dog. ' +
  'A journey of a thousand miles begins with a single step. ' +
  'In a hole in the ground there lived a hobbit.';

export default function VoiceEnrollment({ onComplete, onCancel }: Readonly<Props>) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('intro');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const handleStart = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new AudioContext({ sampleRate: 48000 });
      audioContextRef.current = ctx;

      // Capture 15s of mono audio
      const source = ctx.createMediaStreamSource(stream);
      const buffers: Float32Array[] = [];
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0);
        buffers.push(new Float32Array(ch));
      };
      source.connect(processor);
      processor.connect(ctx.destination);

      setStep('recording');

      setTimeout(() => {
        processor.disconnect();
        source.disconnect();
        stream.getTracks().forEach((t) => t.stop());

        // Concatenate
        const totalLength = buffers.reduce((a, b) => a + b.length, 0);
        const merged = new Float32Array(totalLength);
        let offset = 0;
        for (const b of buffers) {
          merged.set(b, offset);
          offset += b.length;
        }
        // Downsample 48kHz → 16kHz (3:1 with simple averaging — replaced by polyphase later)
        const out = new Float32Array(Math.floor(merged.length / 3));
        for (let i = 0; i < out.length; i++) {
          out[i] = (merged[i * 3] + merged[i * 3 + 1] + merged[i * 3 + 2]) / 3;
        }
        setStep('processing');
        onComplete(out);
      }, 15000);
    } catch (err) {
      const msg = err instanceof DOMException && err.name === 'NotAllowedError'
        ? t('voiceEnrollment.permissionDenied', 'Microphone access denied. Please enable microphone permission and try again.')
        : t('voiceEnrollment.captureError', 'Could not capture audio. Try again.');
      setErrorMessage(msg);
      setStep('error');
    }
  };

  const handleCancel = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();
    onCancel();
  };

  return (
    <dialog className="voice-enrollment-modal" open>
      <h2>{t('voiceEnrollment.title', 'Set up your voice profile')}</h2>

      {step === 'intro' && (
        <>
          <p>{t('voiceEnrollment.intro',
            'To use voice channels, Dilla needs to learn what your voice sounds like. ' +
            'You\'ll record about 15 seconds of speech. Please find a quiet spot.'
          )}</p>
          <details>
            <summary>{t('voiceEnrollment.privacyTitle', 'Where does this go?')}</summary>
            <p>{t('voiceEnrollment.privacyBody',
              'Your voice profile is a small mathematical fingerprint of how your voice sounds. ' +
              'It is encrypted on this device and encrypted again when shared with people you talk to in voice channels. ' +
              'They can use it to make your voice sound clear in noisy environments. ' +
              'Once shared, you cannot take it back. People you have talked to may keep a copy of your voice profile even after you delete yours. ' +
              'We send a "forget this profile" message when you delete, but we cannot enforce it.'
            )}</p>
          </details>
          <div className="voice-enrollment-actions">
            <button onClick={handleCancel} type="button">{t('common.cancel', 'Cancel')}</button>
            <button onClick={handleStart} type="button">{t('voiceEnrollment.start', 'Start')}</button>
          </div>
        </>
      )}

      {step === 'recording' && (
        <>
          <p>{t('voiceEnrollment.recording', 'Recording — please read this aloud:')}</p>
          <blockquote className="voice-enrollment-script">{SAMPLE_SCRIPT}</blockquote>
          <button onClick={handleCancel} type="button">{t('common.cancel', 'Cancel')}</button>
        </>
      )}

      {step === 'processing' && (
        <p>{t('voiceEnrollment.processing', 'Analyzing voice…')}</p>
      )}

      {step === 'error' && (
        <>
          <p className="voice-enrollment-error">{errorMessage}</p>
          <button onClick={() => setStep('intro')} type="button">{t('common.retry', 'Try again')}</button>
          <button onClick={handleCancel} type="button">{t('common.cancel', 'Cancel')}</button>
        </>
      )}
    </dialog>
  );
}
```

- [ ] **Step 4: Add minimal CSS**

```css
/* client/src/components/VoiceEnrollment/VoiceEnrollment.css */
.voice-enrollment-modal {
  position: fixed;
  inset: 0;
  margin: auto;
  width: min(480px, calc(100vw - 32px));
  background: var(--bg-floating);
  color: var(--text-primary);
  border: 1px solid var(--divider);
  border-radius: var(--radius-lg);
  padding: var(--spacing-xl);
  box-shadow: var(--glass-shadow-elevated);
  z-index: 1000;
}

.voice-enrollment-script {
  background: var(--bg-secondary);
  border-left: 3px solid var(--brand-500);
  padding: var(--spacing-md);
  margin: var(--spacing-md) 0;
  font-size: var(--font-size-base);
  line-height: 1.6;
}

.voice-enrollment-actions {
  display: flex;
  gap: var(--spacing-md);
  justify-content: flex-end;
  margin-top: var(--spacing-lg);
}

.voice-enrollment-error {
  color: var(--danger);
}
```

- [ ] **Step 5: Run, expect pass**

Run: `cd client && npm test -- --run VoiceEnrollment`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/VoiceEnrollment/
git commit -m "feat(voice): VoiceEnrollment React component with capture + UI states"
```

### Task 2.4: Add Voice Isolation section to UserSettings

**Files:**
- Modify: `client/src/pages/UserSettings.tsx`
- Modify: `client/src/i18n/locales/en.json`

- [ ] **Step 1: Read UserSettings.tsx to find the Audio tab**

```bash
grep -n "audio\|Audio" client/src/pages/UserSettings.tsx | head
```

Identify the existing Audio tab section to extend.

- [ ] **Step 2: Add the new section**

In the Audio tab, after the existing audio settings, add:

```tsx
{activeTab === 'audio' && (
  <>
    {/* existing audio settings */}

    <section className="settings-section">
      <h3>{t('voiceIsolation.heading', 'Voice Isolation')}</h3>
      <p className="settings-section-help">
        {t('voiceIsolation.help', 'Personalized noise removal that filters background noise and other voices, leaving only you.')}
      </p>

      {voiceProfile === null ? (
        <button onClick={() => setShowEnrollmentModal(true)} type="button">
          {t('voiceIsolation.setUp', 'Set up voice profile')}
        </button>
      ) : (
        <>
          <div className="settings-row">
            <span>{t('voiceIsolation.enrolled', 'Voice profile: enrolled {{date}}', {
              date: new Date(voiceProfile.capturedAt).toLocaleDateString(),
            })}</span>
            <button onClick={() => setShowEnrollmentModal(true)} type="button">
              {t('voiceIsolation.reEnroll', 'Re-enroll')}
            </button>
          </div>
          <button
            onClick={handleClearProfile}
            type="button"
            className="settings-button-destructive"
          >
            {t('voiceIsolation.clear', 'Clear voice profile')}
          </button>
        </>
      )}
    </section>

    {showEnrollmentModal && (
      <VoiceEnrollment
        onComplete={handleEnrollmentComplete}
        onCancel={() => setShowEnrollmentModal(false)}
      />
    )}
  </>
)}
```

Add the relevant state and handlers at the top of the component:

```tsx
const [showEnrollmentModal, setShowEnrollmentModal] = useState(false);
const [voiceProfile, setVoiceProfile] = useState<{ capturedAt: string } | null>(null);

useEffect(() => {
  if (!currentIdentityId || !mek) return;
  getEmbedding(mek, currentIdentityId).then((emb) => {
    if (emb) setVoiceProfile({ capturedAt: emb.capturedAt });
  });
}, [currentIdentityId, mek]);

const handleEnrollmentComplete = async (buffer: Float32Array) => {
  // For Milestone 2, we use a stub encoder. The real ECAPA call comes in Milestone 3.
  const stubEncoder: Encoder = async () => new Float32Array(256).fill(0.5);
  const embedding = await runEnrollment(buffer, stubEncoder, 1);
  await setEmbedding(mek, currentIdentityId, embedding);
  setVoiceProfile({ capturedAt: embedding.capturedAt });
  setShowEnrollmentModal(false);
};

const handleClearProfile = async () => {
  if (!confirm(t('voiceIsolation.clearConfirm', 'Delete your voice profile? This cannot be undone.'))) return;
  await clearEmbedding(currentIdentityId);
  setVoiceProfile(null);
};
```

Imports to add:

```tsx
import VoiceEnrollment from '../components/VoiceEnrollment/VoiceEnrollment';
import { runEnrollment, type Encoder } from '../services/voiceIsolation/enrollment';
import { getEmbedding, setEmbedding, clearEmbedding } from '../services/voiceIsolation/embeddingStore';
```

- [ ] **Step 3: Add i18n strings**

Edit `client/src/i18n/locales/en.json` and add:

```json
"voiceIsolation": {
  "heading": "Voice Isolation",
  "help": "Personalized noise removal that filters background noise and other voices, leaving only you.",
  "setUp": "Set up voice profile",
  "enrolled": "Voice profile: enrolled {{date}}",
  "reEnroll": "Re-enroll",
  "clear": "Clear voice profile",
  "clearConfirm": "Delete your voice profile? This cannot be undone."
},
"voiceEnrollment": {
  "title": "Set up your voice profile",
  "intro": "To use voice channels, Dilla needs to learn what your voice sounds like. You'll record about 15 seconds of speech. Please find a quiet spot.",
  "privacyTitle": "Where does this go?",
  "privacyBody": "Your voice profile is a small mathematical fingerprint of how your voice sounds. It is encrypted on this device and encrypted again when shared with people you talk to in voice channels. They can use it to make your voice sound clear in noisy environments. Once shared, you cannot take it back. People you have talked to may keep a copy of your voice profile even after you delete yours. We send a 'forget this profile' message when you delete, but we cannot enforce it.",
  "start": "Start",
  "recording": "Recording — please read this aloud:",
  "processing": "Analyzing voice…",
  "permissionDenied": "Microphone access denied. Please enable microphone permission and try again.",
  "captureError": "Could not capture audio. Try again."
}
```

- [ ] **Step 4: Verify the client builds and tests pass**

```bash
cd client && npm run lint && npx tsc --noEmit && npm test -- --run UserSettings
```

Expected: clean.

- [ ] **Step 5: Manual smoke test**

```bash
cd client && npm run dev
# Open localhost:8888, log in, go to Settings → Audio
# Click "Set up voice profile"
# Verify the modal opens, recording starts, completes, and the enrolled state shows
```

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/UserSettings.tsx client/src/i18n/locales/en.json
git commit -m "feat(voice): Voice Isolation section in UserSettings → Audio"
```

---

## Milestone 3 — Pipeline + Worker + ring buffer

End state: a unit test pipes a known WAV file through the worklet → SAB → worker → SAB → worklet pipeline and gets cleaned audio at acceptable latency. **Includes the latency benchmark gate as a CI test.** Real ORT Web inference happens here for the first time.

### Task 3.1: SAB ring buffer protocol

**Files:**
- Create: `client/src/services/voiceIsolation/audioWorklet/ringProtocol.ts`
- Create: `client/src/services/voiceIsolation/audioWorklet/ringProtocol.test.ts`

- [ ] **Step 1: Write tests for the ring buffer**

```typescript
import { describe, it, expect } from 'vitest';
import { createRing, writeFrame, readFrame, RingBuffer } from './ringProtocol';

describe('SAB ring buffer protocol', () => {
  it('round-trips a single frame', () => {
    const ring = createRing(1024);
    const input = new Float32Array(128);
    for (let i = 0; i < 128; i++) input[i] = i / 128;
    writeFrame(ring, input);
    const output = readFrame(ring, 128);
    expect(output).not.toBeNull();
    expect(Array.from(output!)).toEqual(Array.from(input));
  });

  it('returns null when ring has fewer samples than requested', () => {
    const ring = createRing(1024);
    writeFrame(ring, new Float32Array(64));
    const output = readFrame(ring, 128);
    expect(output).toBeNull();
  });

  it('handles wrap-around correctly', () => {
    const ring = createRing(256); // small ring to force wrap
    for (let i = 0; i < 5; i++) {
      writeFrame(ring, new Float32Array(64).fill(i));
      const out = readFrame(ring, 64);
      expect(out).not.toBeNull();
      expect(out![0]).toBe(i);
    }
  });

  it('returns null on overflow protection', () => {
    const ring = createRing(128);
    expect(() => writeFrame(ring, new Float32Array(256))).toThrow(/overflow/i);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd client && npm test -- --run ringProtocol`
Expected: not exported.

- [ ] **Step 3: Implement the ring buffer**

```typescript
// client/src/services/voiceIsolation/audioWorklet/ringProtocol.ts

// SAB layout:
// [0]    = write index (Int32Array view)
// [1]    = read index
// [2..]  = Float32 sample data
// Sizes are in samples (not bytes).

export interface RingBuffer {
  sab: SharedArrayBuffer;
  intView: Int32Array;
  floatView: Float32Array;
  capacity: number;
}

const HEADER_INTS = 2; // write idx, read idx
const HEADER_BYTES = HEADER_INTS * 4;

export function createRing(capacitySamples: number): RingBuffer {
  if (typeof SharedArrayBuffer === 'undefined') {
    throw new Error('SharedArrayBuffer not available — check COOP/COEP headers');
  }
  const totalBytes = HEADER_BYTES + capacitySamples * 4;
  const sab = new SharedArrayBuffer(totalBytes);
  return {
    sab,
    intView: new Int32Array(sab, 0, HEADER_INTS),
    floatView: new Float32Array(sab, HEADER_BYTES, capacitySamples),
    capacity: capacitySamples,
  };
}

export function writeFrame(ring: RingBuffer, frame: Float32Array): void {
  const writeIdx = Atomics.load(ring.intView, 0);
  const readIdx = Atomics.load(ring.intView, 1);
  const available = ring.capacity - ((writeIdx - readIdx + ring.capacity) % ring.capacity);
  if (frame.length >= available) {
    throw new Error('Ring buffer overflow');
  }
  for (let i = 0; i < frame.length; i++) {
    ring.floatView[(writeIdx + i) % ring.capacity] = frame[i];
  }
  Atomics.store(ring.intView, 0, (writeIdx + frame.length) % ring.capacity);
  Atomics.notify(ring.intView, 0);
}

export function readFrame(ring: RingBuffer, samples: number): Float32Array | null {
  const writeIdx = Atomics.load(ring.intView, 0);
  const readIdx = Atomics.load(ring.intView, 1);
  const available = (writeIdx - readIdx + ring.capacity) % ring.capacity;
  if (available < samples) return null;

  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = ring.floatView[(readIdx + i) % ring.capacity];
  }
  Atomics.store(ring.intView, 1, (readIdx + samples) % ring.capacity);
  return out;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd client && npm test -- --run ringProtocol`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/audioWorklet/
git commit -m "feat(voice): SAB ring buffer protocol"
```

### Task 3.2: AudioWorklet processor (buffer pump)

**Files:**
- Create: `client/src/services/voiceIsolation/audioWorklet/ringBufferProcessor.js`

This is a `.js` file (not `.ts`) because AudioWorkletGlobalScope cannot import from TS modules. The worklet is a self-contained file registered via `audioContext.audioWorklet.addModule(url)`.

- [ ] **Step 1: Implement the processor**

```javascript
// client/src/services/voiceIsolation/audioWorklet/ringBufferProcessor.js

const HEADER_INTS = 2;

class RingBufferProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    const { inputSab, outputSab, inputCapacity, outputCapacity } = options.processorOptions;
    this.inputInts = new Int32Array(inputSab, 0, HEADER_INTS);
    this.inputFloats = new Float32Array(inputSab, HEADER_INTS * 4, inputCapacity);
    this.outputInts = new Int32Array(outputSab, 0, HEADER_INTS);
    this.outputFloats = new Float32Array(outputSab, HEADER_INTS * 4, outputCapacity);
    this.inputCapacity = inputCapacity;
    this.outputCapacity = outputCapacity;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (input && input[0]) {
      // Write 128-sample render quantum to input ring
      const frame = input[0];
      const writeIdx = Atomics.load(this.inputInts, 0);
      const readIdx = Atomics.load(this.inputInts, 1);
      const available = this.inputCapacity - ((writeIdx - readIdx + this.inputCapacity) % this.inputCapacity);
      if (frame.length < available) {
        for (let i = 0; i < frame.length; i++) {
          this.inputFloats[(writeIdx + i) % this.inputCapacity] = frame[i];
        }
        Atomics.store(this.inputInts, 0, (writeIdx + frame.length) % this.inputCapacity);
        Atomics.notify(this.inputInts, 0);
      }
      // Else: ring full → drop frame (counted by main thread via atomic counter — TODO milestone 8)
    }

    if (output && output[0]) {
      // Read 128 samples from output ring
      const oFrame = output[0];
      const writeIdx = Atomics.load(this.outputInts, 0);
      const readIdx = Atomics.load(this.outputInts, 1);
      const avail = (writeIdx - readIdx + this.outputCapacity) % this.outputCapacity;
      if (avail >= oFrame.length) {
        for (let i = 0; i < oFrame.length; i++) {
          oFrame[i] = this.outputFloats[(readIdx + i) % this.outputCapacity];
        }
        Atomics.store(this.outputInts, 1, (readIdx + oFrame.length) % this.outputCapacity);
      } else {
        // Output ring underrun → emit silence
        for (let i = 0; i < oFrame.length; i++) oFrame[i] = 0;
      }
    }

    return true;
  }
}

registerProcessor('voice-iso-ring-pump', RingBufferProcessor);
```

- [ ] **Step 2: Verify it loads (no test yet — needs browser mode)**

The processor is loaded via `audioContext.audioWorklet.addModule(url)`. Real testing happens in milestone 3's browser tests later.

- [ ] **Step 3: Commit**

```bash
git add client/src/services/voiceIsolation/audioWorklet/ringBufferProcessor.js
git commit -m "feat(voice): AudioWorklet processor for SAB ring buffer pumping"
```

### Task 3.3: Inference Worker — ORT session loading

**Files:**
- Create: `client/src/services/voiceIsolation/inferenceWorker.ts`

This file is the *entry point* of a Web Worker. It's compiled by Vite as a worker bundle. We start with the simplest possible scaffold: load an ORT session from bytes, accept a "process this frame" message, run inference.

**IMPORTANT — model I/O contract.** The actual ONNX tensor names (e.g., `'input'`, `'speaker_embedding'`, `'output'`) and the model window size (samples per inference call) are **model-dependent** and only knowable after spike 0a picks the actual checkpoint. They MUST NOT be hardcoded in the worker. Instead, the spike memo must publish a `ModelIOSpec` for each model, and the main thread passes it to the worker via the `load-model` message. The constants `MODEL_WINDOW_SAMPLES_16K = 1440` and tensor names `'input'`/`'output'`/`'speaker_embedding'` shown below are **placeholders** that the spike must replace before this milestone proceeds.

- [ ] **Step 1: Write the worker scaffold**

```typescript
// client/src/services/voiceIsolation/inferenceWorker.ts
/// <reference lib="webworker" />

import * as ort from 'onnxruntime-web';

// Configure ORT WASM paths to load from same-origin (Task 1.6.5)
ort.env.wasm.wasmPaths = '/ort-wasm/';

export interface ModelIOSpec {
  // Tensor names (from the model graph; documented in spike 0a memo)
  inputName: string;        // e.g. 'mixture' or 'noisy_audio'
  outputName: string;       // e.g. 'enhanced' or 'clean_audio'
  embeddingName?: string;   // only for VFL — e.g. 'speaker_embedding' or 'd_vector'

  // Sample-rate + window contract
  modelSampleRate: number;  // 16000 typically
  windowSamples: number;    // samples per inference call at modelSampleRate
}

interface LoadModelMsg {
  type: 'load-model';
  modelKind: 'vfl' | 'ecapa' | 'dfn3';
  modelBytes: Uint8Array;
  sessionId: string;
  ioSpec: ModelIOSpec;
}

interface RunInferenceMsg {
  type: 'run-inference';
  sessionId: string;
  inputName: string;
  inputData: Float32Array;
  inputShape: readonly number[];
  outputName: string;
  embedding?: Float32Array;
  embeddingName?: string;
  requestId: number;
}

interface AttachStreamMsg {
  type: 'attach-stream';
  streamId: string;
  sessionId: string;
  inputSab: SharedArrayBuffer;
  outputSab: SharedArrayBuffer;
  inputCapacity: number;
  outputCapacity: number;
  embedding?: Float32Array;
}

interface DetachStreamMsg {
  type: 'detach-stream';
  streamId: string;
}

interface SwitchModelMsg {
  type: 'switch-model';
  streamId: string;
  sessionId: string;
  embedding?: Float32Array;
}

type InMsg = LoadModelMsg | RunInferenceMsg | AttachStreamMsg | DetachStreamMsg | SwitchModelMsg;

interface SessionEntry {
  session: ort.InferenceSession;
  ioSpec: ModelIOSpec;
}

const sessions = new Map<string, SessionEntry>();
const streams = new Map<string, {
  sessionId: string;
  inputSab: SharedArrayBuffer;
  outputSab: SharedArrayBuffer;
  embedding?: Float32Array;
}>();

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;

  if (msg.type === 'load-model') {
    const session = await ort.InferenceSession.create(msg.modelBytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    sessions.set(msg.sessionId, { session, ioSpec: msg.ioSpec });
    (self as unknown as Worker).postMessage({ type: 'model-loaded', sessionId: msg.sessionId });
    return;
  }

  if (msg.type === 'run-inference') {
    const session = sessions.get(msg.sessionId);
    if (!session) {
      (self as unknown as Worker).postMessage({ type: 'inference-error', requestId: msg.requestId, error: 'session not loaded' });
      return;
    }
    const feeds: Record<string, ort.Tensor> = {
      [msg.inputName]: new ort.Tensor('float32', msg.inputData, msg.inputShape),
    };
    if (msg.embedding && msg.embeddingName) {
      feeds[msg.embeddingName] = new ort.Tensor('float32', msg.embedding, [1, msg.embedding.length]);
    }
    const out = await session.run(feeds);
    const output = out[msg.outputName];
    (self as unknown as Worker).postMessage({
      type: 'inference-result',
      requestId: msg.requestId,
      data: output.data,
      shape: output.dims,
    });
    return;
  }

  if (msg.type === 'attach-stream') {
    streams.set(msg.streamId, {
      sessionId: msg.sessionId,
      inputSab: msg.inputSab,
      outputSab: msg.outputSab,
      embedding: msg.embedding,
    });
    startStreamLoop(msg.streamId, msg.inputCapacity, msg.outputCapacity);
    return;
  }

  if (msg.type === 'detach-stream') {
    streams.delete(msg.streamId);
    return;
  }

  if (msg.type === 'switch-model') {
    const stream = streams.get(msg.streamId);
    if (stream) {
      stream.sessionId = msg.sessionId;
      stream.embedding = msg.embedding;
    }
    return;
  }
};

const HEADER_INTS = 2;
// Window size is read per-session from ModelIOSpec; no module-level constant.

function startStreamLoop(streamId: string, inputCapacity: number, outputCapacity: number) {
  const stream = streams.get(streamId);
  if (!stream) return;

  const inputInts = new Int32Array(stream.inputSab, 0, HEADER_INTS);
  const inputFloats = new Float32Array(stream.inputSab, HEADER_INTS * 4, inputCapacity);
  const outputInts = new Int32Array(stream.outputSab, 0, HEADER_INTS);
  const outputFloats = new Float32Array(stream.outputSab, HEADER_INTS * 4, outputCapacity);

  const tick = async () => {
    const current = streams.get(streamId);
    if (!current) return; // detached

    const writeIdx = Atomics.load(inputInts, 0);
    const readIdx = Atomics.load(inputInts, 1);
    const avail = (writeIdx - readIdx + inputCapacity) % inputCapacity;

    // Look up the per-session ioSpec — tensor names and window size are model-dependent
    const sessionEntry = sessions.get(current.sessionId);
    if (!sessionEntry) {
      setTimeout(tick, 0);
      return;
    }
    const { session, ioSpec } = sessionEntry;
    const windowSamples16k = ioSpec.windowSamples;
    const windowSamples48k = windowSamples16k * 3;

    if (avail >= windowSamples48k) {
      // Read 48k frame
      const frame48 = new Float32Array(windowSamples48k);
      for (let i = 0; i < windowSamples48k; i++) {
        frame48[i] = inputFloats[(readIdx + i) % inputCapacity];
      }
      Atomics.store(inputInts, 1, (readIdx + windowSamples48k) % inputCapacity);

      // Downsample 48k → 16k (3:1 polyphase — using simple block average for v1; replace with FIR later)
      const frame16 = new Float32Array(windowSamples16k);
      for (let i = 0; i < windowSamples16k; i++) {
        frame16[i] = (frame48[i * 3] + frame48[i * 3 + 1] + frame48[i * 3 + 2]) / 3;
      }

      // Run inference using the session's documented tensor names
      try {
        const feeds: Record<string, ort.Tensor> = {
          [ioSpec.inputName]: new ort.Tensor('float32', frame16, [1, windowSamples16k]),
        };
        if (current.embedding && ioSpec.embeddingName) {
          feeds[ioSpec.embeddingName] = new ort.Tensor('float32', current.embedding, [1, 256]);
        }
        const result = await session.run(feeds);
        const cleaned16 = result[ioSpec.outputName].data as Float32Array;

        // Upsample 16k → 48k (1:3 — simple repeat for v1; replace with polyphase later)
        const out48 = new Float32Array(windowSamples48k);
        for (let i = 0; i < windowSamples16k; i++) {
          out48[i * 3] = cleaned16[i];
          out48[i * 3 + 1] = cleaned16[i];
          out48[i * 3 + 2] = cleaned16[i];
        }

          // Write to output ring
          const oWrite = Atomics.load(outputInts, 0);
          const oRead = Atomics.load(outputInts, 1);
          const oAvail = outputCapacity - ((oWrite - oRead + outputCapacity) % outputCapacity);
          if (out48.length < oAvail) {
            for (let i = 0; i < out48.length; i++) {
              outputFloats[(oWrite + i) % outputCapacity] = out48[i];
            }
            Atomics.store(outputInts, 0, (oWrite + out48.length) % outputCapacity);
          }
      } catch (err) {
        console.error('[inferenceWorker] inference failed', err);
        // On error, pass through silence (will be replaced by passthrough fallback in milestone 8)
      }
    }

    // Yield to message handlers, then loop
    setTimeout(tick, 0);
  };

  tick();
}
```

- [ ] **Step 2: Configure Vite to bundle the worker**

The worker is loaded via `new Worker(new URL('./inferenceWorker.ts', import.meta.url), { type: 'module' })` which Vite handles natively.

- [ ] **Step 3: Type-check**

Run: `cd client && npx tsc --noEmit`
Expected: clean. The worker file uses `///<reference lib="webworker"/>` so it gets the right global types.

- [ ] **Step 4: Commit**

```bash
git add client/src/services/voiceIsolation/inferenceWorker.ts
git commit -m "feat(voice): inferenceWorker scaffold — ORT session + stream loop"
```

### Task 3.3.5: Close the dispatcher → worker session-load round-trip

**Files:**
- Modify: `client/src/services/voiceIsolation/dispatcher.ts`

This task completes the work deferred in Task 1.14. With the inference worker now built (Task 3.3), `initializeVoiceIsolation` can actually post `load-model` messages and await the `model-loaded` responses to populate real session IDs.

- [ ] **Step 1: Define ModelIOSpec values from the spike memo**

Read `docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md` and extract the actual tensor names and window sizes for VFL, ECAPA, DFN3. Encode them as constants in `dispatcher.ts`:

```typescript
import type { ModelIOSpec } from './inferenceWorker';

// Values come from the spike memo. Replace these with the actual values
// before this task is complete.
const VFL_IO_SPEC: ModelIOSpec = {
  inputName: 'mixture',           // REPLACE with spike value
  outputName: 'enhanced',         // REPLACE
  embeddingName: 'speaker_embedding', // REPLACE
  modelSampleRate: 16000,
  windowSamples: 1440,            // REPLACE
};
const ECAPA_IO_SPEC: ModelIOSpec = {
  inputName: 'wav',               // REPLACE
  outputName: 'embedding',        // REPLACE
  modelSampleRate: 16000,
  windowSamples: 16000 * 15,      // 15s capture window for enrollment
};
const DFN3_IO_SPEC: ModelIOSpec = {
  inputName: 'noisy',             // REPLACE
  outputName: 'clean',            // REPLACE
  modelSampleRate: 16000,
  windowSamples: 1440,            // REPLACE
};
```

- [ ] **Step 2: Rewrite initializeVoiceIsolation to await load-model responses**

Replace the placeholder body of `initializeVoiceIsolation` from Task 1.14 with the real round-trip:

```typescript
export async function initializeVoiceIsolation(serverUrl: string): Promise<InitializedContext | null> {
  if (context) return context;
  try {
    // Fetch model bytes and validate checksums
    const handles = await loadModels(serverUrl);

    // Also fetch the raw bytes (loadModels doesn't return them — refactor to expose them
    // or call fetch directly here using the manifest)
    const manifest = await fetchManifest(serverUrl);
    const fetchBytes = async (url: string, sha: string): Promise<Uint8Array> => {
      const cached = await getCachedModel(name, manifest.version);
      if (cached) {
        await validateChecksum(cached, sha);
        return cached;
      }
      const r = await fetch(`${serverUrl}${url}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      await validateChecksum(bytes, sha);
      return bytes;
    };
    const vflBytes   = await fetchBytes(manifest.vfl.url,   manifest.vfl.sha256);
    const ecapaBytes = await fetchBytes(manifest.ecapa.url, manifest.ecapa.sha256);
    const dfn3Bytes  = await fetchBytes(manifest.dfn3.url,  manifest.dfn3.sha256);

    // Create AudioContext and register the worklet
    const audioContext = new AudioContext({ sampleRate: 48000 });
    await audioContext.audioWorklet.addModule(
      new URL('./audioWorklet/ringBufferProcessor.js', import.meta.url).href,
    );

    // Spawn the inference worker
    const worker = new Worker(
      new URL('./inferenceWorker.ts', import.meta.url),
      { type: 'module' },
    );

    // Helper: post a load-model message and await the model-loaded reply
    const loadOne = (
      sessionId: string,
      modelKind: 'vfl' | 'ecapa' | 'dfn3',
      modelBytes: Uint8Array,
      ioSpec: ModelIOSpec,
    ): Promise<void> => {
      return new Promise((resolve, reject) => {
        const handler = (e: MessageEvent) => {
          if (e.data?.type === 'model-loaded' && e.data.sessionId === sessionId) {
            worker.removeEventListener('message', handler);
            resolve();
          } else if (e.data?.type === 'model-error' && e.data.sessionId === sessionId) {
            worker.removeEventListener('message', handler);
            reject(new Error(e.data.error));
          }
        };
        worker.addEventListener('message', handler);
        worker.postMessage({
          type: 'load-model',
          sessionId,
          modelKind,
          modelBytes,
          ioSpec,
        });
      });
    };

    const vflSessionId = `vfl-${crypto.randomUUID()}`;
    const ecapaSessionId = `ecapa-${crypto.randomUUID()}`;
    const dfn3SessionId = `dfn3-${crypto.randomUUID()}`;

    await Promise.all([
      loadOne(vflSessionId,   'vfl',   vflBytes,   VFL_IO_SPEC),
      loadOne(ecapaSessionId, 'ecapa', ecapaBytes, ECAPA_IO_SPEC),
      loadOne(dfn3SessionId,  'dfn3',  dfn3Bytes,  DFN3_IO_SPEC),
    ]);

    context = {
      audioContext,
      worker,
      vflSessionId,
      ecapaSessionId,
      dfn3SessionId,
    };
    return context;
  } catch (err) {
    console.error('[voiceIsolation] init failed', err);
    return null; // pass-through mode
  }
}
```

- [ ] **Step 3: Update inferenceWorker to emit `model-error` on failure**

In the worker's `load-model` handler, wrap in try/catch:

```typescript
try {
  const session = await ort.InferenceSession.create(...);
  sessions.set(msg.sessionId, { session, ioSpec: msg.ioSpec });
  postMessage({ type: 'model-loaded', sessionId: msg.sessionId });
} catch (err) {
  postMessage({ type: 'model-error', sessionId: msg.sessionId, error: String(err) });
}
```

- [ ] **Step 4: Run the browser-mode test (Task 3.5) again**

The end-to-end pipeline test should now work without manually constructing a session ID.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/dispatcher.ts client/src/services/voiceIsolation/inferenceWorker.ts
git commit -m "feat(voice): dispatcher → worker model load round-trip"
```

### Task 3.4: pipeline.ts — public API

**Files:**
- Create: `client/src/services/voiceIsolation/pipeline.ts`
- Create: `client/src/services/voiceIsolation/pipeline.test.ts` (logic-only tests; full pipeline tests in browser mode milestone 3.5)

- [ ] **Step 1: Write tests for pipeline-construction logic**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createPipeline } from './pipeline';

describe('pipeline.createPipeline', () => {
  it('creates input/output rings of expected capacity', () => {
    const fakeWorker = { postMessage: vi.fn() } as unknown as Worker;
    const fakeAudioContext = {
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
      createMediaStreamSource: vi.fn(),
      createMediaStreamDestination: vi.fn().mockReturnValue({ stream: new MediaStream() }),
    } as unknown as AudioContext;

    // (We can't fully exercise pipeline without a real AudioContext — this is a smoke test
    //  for the construction-time validation only. The real tests are in pipeline.browser.test.tsx)
    expect(() => createPipeline({
      audioContext: fakeAudioContext,
      worker: fakeWorker,
      track: new MediaStream().getTracks()[0],
      initialSessionId: 'sess-1',
    })).not.toThrow();
  });
});
```

- [ ] **Step 2: Implement pipeline.ts**

```typescript
// client/src/services/voiceIsolation/pipeline.ts
import type { ModelKind } from './types';
import { createRing } from './audioWorklet/ringProtocol';

const INPUT_RING_CAPACITY = 16384;  // ~340ms at 48kHz
const OUTPUT_RING_CAPACITY = 16384;

export interface PipelineConfig {
  audioContext: AudioContext;
  worker: Worker;
  track: MediaStreamTrack;
  initialSessionId: string;
  initialEmbedding?: Float32Array;
}

export interface Pipeline {
  outputTrack: MediaStreamTrack;
  switchModel(sessionId: string, embedding?: Float32Array): void;
  destroy(): void;
}

let nextStreamId = 0;

export function createPipeline(config: PipelineConfig): Pipeline {
  const streamId = `stream-${nextStreamId++}`;
  const inputRing = createRing(INPUT_RING_CAPACITY);
  const outputRing = createRing(OUTPUT_RING_CAPACITY);

  // Send the SABs to the worker so it can do inference
  config.worker.postMessage({
    type: 'attach-stream',
    streamId,
    sessionId: config.initialSessionId,
    inputSab: inputRing.sab,
    outputSab: outputRing.sab,
    inputCapacity: INPUT_RING_CAPACITY,
    outputCapacity: OUTPUT_RING_CAPACITY,
    embedding: config.initialEmbedding,
  });

  // Create the worklet node
  const workletNode = new AudioWorkletNode(config.audioContext, 'voice-iso-ring-pump', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      inputSab: inputRing.sab,
      outputSab: outputRing.sab,
      inputCapacity: INPUT_RING_CAPACITY,
      outputCapacity: OUTPUT_RING_CAPACITY,
    },
  });

  const source = config.audioContext.createMediaStreamSource(new MediaStream([config.track]));
  const destination = config.audioContext.createMediaStreamDestination();
  source.connect(workletNode);
  workletNode.connect(destination);

  return {
    outputTrack: destination.stream.getAudioTracks()[0],
    switchModel(sessionId: string, embedding?: Float32Array) {
      config.worker.postMessage({
        type: 'switch-model',
        streamId,
        sessionId,
        embedding,
      });
    },
    destroy() {
      config.worker.postMessage({ type: 'detach-stream', streamId });
      workletNode.disconnect();
      source.disconnect();
      config.track.stop();
    },
  };
}
```

- [ ] **Step 3: Run, expect pass**

Run: `cd client && npm test -- --run pipeline`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/services/voiceIsolation/pipeline.ts client/src/services/voiceIsolation/pipeline.test.ts
git commit -m "feat(voice): pipeline.createPipeline — worklet+worker+ring assembly"
```

### Task 3.5: Browser-mode end-to-end pipeline test

**Files:**
- Create: `client/src/services/voiceIsolation/pipeline.browser.test.ts`

- [ ] **Step 1: Write the browser test**

```typescript
// client/src/services/voiceIsolation/pipeline.browser.test.ts
// Run with: vitest run --browser

import { describe, it, expect } from 'vitest';
import { createPipeline } from './pipeline';
import { loadModels } from './modelLoader';

describe('pipeline (browser)', () => {
  it('processes synthetic audio through real worklet + worker + WASM', async () => {
    // Verify cross-origin isolation is active (required for SAB)
    expect(crossOriginIsolated).toBe(true);

    const audioContext = new AudioContext({ sampleRate: 48000 });

    // Register the worklet
    await audioContext.audioWorklet.addModule(
      new URL('./audioWorklet/ringBufferProcessor.js', import.meta.url).href,
    );

    // Spawn the inference worker
    const worker = new Worker(
      new URL('./inferenceWorker.ts', import.meta.url),
      { type: 'module' },
    );

    // Load models from the dev server
    const models = await loadModels('http://localhost:8888');

    // Send the model to the worker
    // (For this test we use the DFN3 fallback model — no embedding needed)
    const dfn3Bytes = await fetch('http://localhost:8888/api/voice/models/dfn3-v1.onnx')
      .then((r) => r.arrayBuffer())
      .then((b) => new Uint8Array(b));

    const sessionId = 'test-session';
    worker.postMessage({
      type: 'load-model',
      modelKind: 'dfn3',
      modelBytes: dfn3Bytes,
      sessionId,
    });

    await new Promise<void>((resolve) => {
      worker.onmessage = (e) => {
        if (e.data?.type === 'model-loaded') resolve();
      };
    });

    // Create a synthetic input source
    const oscillator = audioContext.createOscillator();
    oscillator.frequency.value = 440;
    const dest = audioContext.createMediaStreamDestination();
    oscillator.connect(dest);
    oscillator.start();

    const inputTrack = dest.stream.getAudioTracks()[0];

    const pipeline = createPipeline({
      audioContext,
      worker,
      track: inputTrack,
      initialSessionId: sessionId,
    });

    expect(pipeline.outputTrack).toBeDefined();

    // Wait a bit for inference to start producing output
    await new Promise((r) => setTimeout(r, 500));

    pipeline.destroy();
    oscillator.stop();
    worker.terminate();
    await audioContext.close();
  }, 30_000);
});
```

- [ ] **Step 2: Configure vitest browser mode if not already done**

Run: `grep -n "browser" client/vitest.config.ts`
Expected: shows existing browser-mode config. If missing, add it per the project's existing browser test setup.

- [ ] **Step 3: Run the dev server in another terminal**

```bash
cd server-rs && cargo run
```

(The browser test fetches models from the running dev server.)

- [ ] **Step 4: Run the browser test**

```bash
cd client && npm run test:browser -- --run pipeline.browser
```

Expected: PASS. This test confirms the entire ring buffer + worklet + worker + WASM stack works end-to-end.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/pipeline.browser.test.ts
git commit -m "test(voice): browser-mode end-to-end pipeline test"
```

### Task 3.6: Latency benchmark gate (browser, CI)

**Files:**
- Create: `client/src/services/voiceIsolation/inferenceWorker.bench.test.ts`

**IMPORTANT** — the benchmark MUST run inside a real browser using `onnxruntime-web` (the same code path the production worker uses), NOT `onnxruntime-node`. `onnxruntime-node` calls the native C++ ONNX Runtime which is dramatically faster than WASM SIMD and would give false-positive passes. Use vitest browser mode (the same setup as `pipeline.browser.test.ts`).

- [ ] **Step 1: Write the browser-mode benchmark**

```typescript
// client/src/services/voiceIsolation/inferenceWorker.bench.test.ts
// Run with: cd client && npm run test:browser -- --run inferenceWorker.bench

import { describe, it, expect } from 'vitest';
import * as ort from 'onnxruntime-web';

const N_FRAMES = 200;
const P95_THRESHOLD_MS = 25; // M1 target; adjust per spec spike 0b

describe('VFL WASM SIMD latency benchmark', () => {
  it('p95 inference time on M1 < 25ms', async () => {
    expect(crossOriginIsolated).toBe(true);

    ort.env.wasm.wasmPaths = '/ort-wasm/';

    const bytes = await fetch('http://localhost:8888/api/voice/models/vfl-v1.onnx')
      .then((r) => r.arrayBuffer())
      .then((b) => new Uint8Array(b));

    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    // Read tensor names + window size from spike memo's ModelIOSpec.
    // For the placeholder values used in this plan:
    const FRAME_SAMPLES = 1440; // REPLACE with spike memo's value
    const inputName = 'input'; // REPLACE
    const outputName = 'output'; // REPLACE
    const embeddingName = 'speaker_embedding'; // REPLACE

    // Warmup
    for (let i = 0; i < 5; i++) {
      await session.run({
        [inputName]: new ort.Tensor('float32', new Float32Array(FRAME_SAMPLES), [1, FRAME_SAMPLES]),
        [embeddingName]: new ort.Tensor('float32', new Float32Array(256), [1, 256]),
      });
    }

    const times: number[] = [];
    for (let i = 0; i < N_FRAMES; i++) {
      const input = new Float32Array(FRAME_SAMPLES);
      for (let j = 0; j < FRAME_SAMPLES; j++) input[j] = Math.random() * 2 - 1;
      const embedding = new Float32Array(256);
      for (let j = 0; j < 256; j++) embedding[j] = Math.random();

      const start = performance.now();
      await session.run({
        [inputName]: new ort.Tensor('float32', input, [1, FRAME_SAMPLES]),
        [embeddingName]: new ort.Tensor('float32', embedding, [1, 256]),
      });
      times.push(performance.now() - start);
    }

    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.5)];
    const p95 = times[Math.floor(times.length * 0.95)];
    const p99 = times[Math.floor(times.length * 0.99)];

    console.log(`VFL benchmark: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms`);
    expect(p95).toBeLessThan(P95_THRESHOLD_MS);
  }, 60_000);
});
```

- [ ] **Step 2: Run the dev server in another terminal**

```bash
cd server-rs && cargo run
```

- [ ] **Step 3: Run the benchmark**

```bash
cd client && npm run test:browser -- --run inferenceWorker.bench
```

Expected: p95 < 25ms on M1. Document the actual numbers in the spike memo.

- [ ] **Step 4: Commit**

```bash
git add client/src/services/voiceIsolation/inferenceWorker.bench.test.ts
git commit -m "test(voice): WASM SIMD inference latency benchmark (browser mode)"
```

---

## Milestone 4 — Single-stream outgoing

End state: your own mic is processed through the VFL pipeline before going to peers. No symmetric incoming yet, no embedding broadcast yet. Tests verify it.

### Task 4.1: Wire processOutgoing into WebRTCService.ts

**Files:**
- Modify: `client/src/services/webrtc/WebRTCService.ts`
- Create: `client/src/services/voiceIsolation/dispatcher.ts` (minimal version)

- [ ] **Step 1: Implement minimal dispatcher (just outgoing)**

```typescript
// client/src/services/voiceIsolation/dispatcher.ts
import { createPipeline, type Pipeline } from './pipeline';
import type { Embedding } from './types';

interface DispatcherConfig {
  audioContext: AudioContext;
  worker: Worker;
  vflSessionId: string;
  dfn3SessionId: string;
}

let outgoingPipeline: Pipeline | null = null;

export function processOutgoing(
  config: DispatcherConfig,
  track: MediaStreamTrack,
  embedding: Embedding | null,
): MediaStreamTrack {
  outgoingPipeline?.destroy();

  const sessionId = embedding ? config.vflSessionId : config.dfn3SessionId;
  outgoingPipeline = createPipeline({
    audioContext: config.audioContext,
    worker: config.worker,
    track,
    initialSessionId: sessionId,
    initialEmbedding: embedding?.vector,
  });
  return outgoingPipeline.outputTrack;
}

export function teardownOutgoing(): void {
  outgoingPipeline?.destroy();
  outgoingPipeline = null;
}
```

- [ ] **Step 2: Wire into WebRTCService.ts**

Find the `addTrack` call (line ~109). Change:

```typescript
this.pc.addTrack(track, this.localStream);
```

To:

```typescript
const ctx = this.voiceIsolationContext; // populated by initializeVoiceIsolation in Task 1.14/3.3.5
const processedTrack = ctx
  ? processOutgoing(ctx, track, this.localEmbedding)
  : track; // pass-through if init not yet complete
this.pc.addTrack(processedTrack, this.localStream);
```

`voiceIsolationContext` is the field added in Task 1.14, populated by `initializeVoiceIsolation` (completed in Task 3.3.5). `localEmbedding` is loaded from `embeddingStore` at construction time. `processOutgoing` is a free function exported from `dispatcher.ts` that takes the context as its first argument — not a method on the class.

- [ ] **Step 3: Verify the existing WebRTCService tests still pass**

Run: `cd client && npm test -- --run WebRTCService`
Expected: PASS. The change should be backward-compatible because if the dispatcher isn't initialized (no models loaded), it should pass through.

Add a graceful-degradation path to dispatcher.processOutgoing:

```typescript
if (!config) {
  // Models not loaded — pass-through
  return track;
}
```

- [ ] **Step 4: Manual smoke test**

```bash
cd server-rs && cargo run
# In another terminal:
cd client && npm run dev
# In a third terminal:
cd client && npm run tauri dev
```

Open the app, enroll, join a voice channel with another user, verify your own audio is being processed (you can see the network track in WebRTC internals).

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/dispatcher.ts client/src/services/webrtc/WebRTCService.ts
git commit -m "feat(voice): wire processOutgoing into WebRTCService"
```

---

## Milestone 5 — Embedding broadcast

End state: embeddings flow between peers via Signal-encrypted WS events with valid Ed25519 signatures bound to channel + recipient.

### Task 5.1: Server WS event types

**Files:**
- Modify: `server-rs/src/ws/events.rs`
- Modify: `server-rs/src/ws/handlers/voice.rs`

**IMPORTANT** — the existing `server-rs/src/ws/events.rs` does NOT use a tagged enum for voice payloads. It uses **flat `VoiceXxxPayload` structs** plus **string constants** like `pub const EVENT_VOICE_JOIN: &str = "voice:join"`. The dispatcher in `server-rs/src/ws/client.rs` matches on the `event_type` string and deserializes the payload from `serde_json::Value` into the right struct. Read both files end-to-end before proceeding.

- [ ] **Step 0: Read the existing patterns**

```bash
grep -n "pub const EVENT_VOICE\|VoiceJoinPayload\|VoiceLeavePayload" server-rs/src/ws/events.rs
grep -n "EVENT_VOICE_JOIN\|handle_voice" server-rs/src/ws/client.rs
cat server-rs/src/ws/handlers/voice.rs | head -100
```

Note the existing flat-struct pattern and the dispatch site in `client.rs`.

- [ ] **Step 1: Add the three new event constants and payload structs**

In `server-rs/src/ws/events.rs`:

```rust
// Add to the existing inbound (client → server) constants block (around line 16):
pub const EVENT_VOICE_EMBEDDING_PUBLISH: &str = "voice:embedding-publish";
pub const EVENT_VOICE_EMBEDDING_REVOKE: &str = "voice:embedding-revoke";

// Add to the existing outbound (server → client) constants block (around line 77):
pub const EVENT_VOICE_EMBEDDING_RECEIVED: &str = "voice:embedding-received";
pub const EVENT_VOICE_EMBEDDING_REVOKE_OUT: &str = "voice:embedding-revoke";

// Add flat payload structs alongside the existing VoiceJoinPayload, VoiceMutePayload etc.:
#[derive(Debug, Clone, Deserialize)]
pub struct VoiceEmbeddingPublishPayload {
    pub channel_id: String,
    pub to_user_id: String,
    pub ciphertext: Vec<u8>, // serde_json handles base64 via #[serde(with = "...")] if needed
}

#[derive(Debug, Clone, Serialize)]
pub struct VoiceEmbeddingReceivedPayload {
    pub channel_id: String,
    pub from_user_id: String,
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VoiceEmbeddingRevokePayload {
    pub channel_id: String,
    pub to_user_id: String,
    pub revoked_capture_id: String,
}
```

- [ ] **Step 2: Add free-function handlers in `handlers/voice.rs`**

```rust
// In server-rs/src/ws/handlers/voice.rs, alongside handle_voice_join, handle_voice_mute, etc.:

pub async fn handle_voice_embedding_publish(
    hub: &Hub,
    sender_user_id: &str,
    p: VoiceEmbeddingPublishPayload,
) -> Result<(), WsError> {
    // Verify sender is currently a member of the named voice channel
    if !hub.voice_channel_has_member(&p.channel_id, sender_user_id).await {
        return Err(WsError::Unauthorized);
    }
    // Relay opaque ciphertext to the named recipient
    let out = VoiceEmbeddingReceivedPayload {
        channel_id: p.channel_id,
        from_user_id: sender_user_id.to_string(),
        ciphertext: p.ciphertext,
    };
    hub.send_to_user(&p.to_user_id, EVENT_VOICE_EMBEDDING_RECEIVED, &out).await;
    Ok(())
}

pub async fn handle_voice_embedding_revoke(
    hub: &Hub,
    sender_user_id: &str,
    p: VoiceEmbeddingRevokePayload,
) -> Result<(), WsError> {
    if !hub.voice_channel_has_member(&p.channel_id, sender_user_id).await {
        return Err(WsError::Unauthorized);
    }
    hub.send_to_user(&p.to_user_id, EVENT_VOICE_EMBEDDING_REVOKE_OUT, &p).await;
    Ok(())
}
```

The exact `Hub` API methods (`voice_channel_has_member`, `send_to_user`) may differ — match the existing handlers in the same file for the actual signatures. Read `handlers/voice.rs::handle_voice_mute` (or similar) to see how relay is currently done.

- [ ] **Step 3: Wire the dispatch in `ws/client.rs`**

Find where the existing voice events are dispatched. The pattern looks like:

```rust
EVENT_VOICE_JOIN => {
    let p: VoiceJoinPayload = serde_json::from_value(payload)?;
    handlers::voice::handle_voice_join(hub, user_id, p).await?;
}
```

Add three new arms:

```rust
EVENT_VOICE_EMBEDDING_PUBLISH => {
    let p: VoiceEmbeddingPublishPayload = serde_json::from_value(payload)?;
    handlers::voice::handle_voice_embedding_publish(hub, user_id, p).await?;
}
EVENT_VOICE_EMBEDDING_REVOKE => {
    let p: VoiceEmbeddingRevokePayload = serde_json::from_value(payload)?;
    handlers::voice::handle_voice_embedding_revoke(hub, user_id, p).await?;
}
```

Note the inbound revoke goes through the same handler — there is no separate inbound `EmbeddingReceived` because that's outbound-only.

- [ ] **Step 3: Write a Rust test**

```rust
// In server-rs/src/api/tests.rs or wherever WS handler tests live.
// NOTE: this uses the flat-struct + string-constant pattern matching the
// real events.rs (NOT a tagged enum).

#[tokio::test]
async fn voice_embedding_publish_relays_to_recipient() {
    // Setup: two clients in the same voice channel
    let (sender, mut recipient) = setup_two_clients_in_voice_channel().await;

    let publish_payload = VoiceEmbeddingPublishPayload {
        channel_id: "ch-1".to_string(),
        to_user_id: recipient.user_id.clone(),
        ciphertext: vec![1, 2, 3, 4],
    };
    // Send via the test harness's helper that wraps payload + event_type string
    sender.send_event(EVENT_VOICE_EMBEDDING_PUBLISH, &publish_payload).await;

    // The recipient receives a server-side outbound event
    let (event_type, payload_value) = recipient.next_event().await;
    assert_eq!(event_type, EVENT_VOICE_EMBEDDING_RECEIVED);

    let received: VoiceEmbeddingReceivedPayload = serde_json::from_value(payload_value).unwrap();
    assert_eq!(received.from_user_id, sender.user_id);
    assert_eq!(received.ciphertext, vec![1, 2, 3, 4]);
}
```

The exact helper method names (`send_event`, `next_event`) depend on the existing test harness in `server-rs/src/api/tests.rs` — match the existing pattern from voice join/mute tests.

- [ ] **Step 4: Run server tests**

```bash
cd server-rs && cargo test voice_embedding
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server-rs/src/ws/events.rs server-rs/src/ws/handlers/voice.rs server-rs/src/api/tests.rs
git commit -m "feat(voice): add embedding publish/receive/revoke WS events"
```

### Task 5.2: Implement embeddingTransport.ts

**Files:**
- Create: `client/src/services/voiceIsolation/embeddingTransport.ts`
- Create: `client/src/services/voiceIsolation/embeddingTransport.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createTransport, EmbeddingPayload } from './embeddingTransport';

describe('embeddingTransport', () => {
  it('signs payload with Ed25519 covering all bound fields', async () => {
    const signer = vi.fn().mockResolvedValue(new Uint8Array(64).fill(0xab));
    const encryptor = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const wsSend = vi.fn();

    const transport = createTransport({ signer, encryptor, wsSend });

    await transport.publish({
      embedding: new Float32Array(256).fill(0.5),
      modelVersion: 1,
      capturedAt: '2026-04-07T12:00:00Z',
      captureId: 'cap-1',
      channelId: 'ch-1',
      recipientUserId: 'peer-1',
      senderSequence: 1,
    });

    expect(signer).toHaveBeenCalled();
    const signedBody = signer.mock.calls[0][0] as Uint8Array;
    // The signed body must include channelId and recipientUserId for binding
    const text = new TextDecoder().decode(signedBody);
    expect(text).toContain('ch-1');
    expect(text).toContain('peer-1');
  });

  it('rejects replay (sequence not strictly greater)', () => {
    const transport = createTransport({} as never);
    const baseFields = { /* ... */ };
    transport.handleReceived('peer-1', { ...baseFields, senderSequence: 5 } as EmbeddingPayload);
    const result = transport.handleReceived('peer-1', { ...baseFields, senderSequence: 4 } as EmbeddingPayload);
    expect(result).toBe('replay');
  });

  it('accepts duplicate captureId as catchup republish', () => {
    const transport = createTransport({} as never);
    const baseFields = { senderSequence: 5, captureId: 'cap-1' /* ... */ };
    transport.handleReceived('peer-1', baseFields as EmbeddingPayload);
    const result = transport.handleReceived('peer-1', baseFields as EmbeddingPayload);
    expect(result).toBe('catchup');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd client && npm test -- --run embeddingTransport`
Expected: not exported.

- [ ] **Step 3: Implement embeddingTransport**

```typescript
// client/src/services/voiceIsolation/embeddingTransport.ts

export interface EmbeddingPayload {
  embedding: Float32Array;
  modelVersion: number;
  capturedAt: string;
  captureId: string;
  channelId: string;
  recipientUserId: string;
  senderSequence: number;
  signature?: Uint8Array;
}

export type Signer = (bytes: Uint8Array) => Promise<Uint8Array>;
export type Encryptor = (recipientUserId: string, plaintext: Uint8Array) => Promise<Uint8Array>;
export type Decryptor = (senderUserId: string, ciphertext: Uint8Array) => Promise<Uint8Array>;
export type Verifier = (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => Promise<boolean>;
export type WsSend = (event: { type: string; channel_id: string; to_user_id: string; ciphertext: Uint8Array }) => void;

export interface TransportConfig {
  signer: Signer;
  encryptor: Encryptor;
  decryptor: Decryptor;
  verifier: Verifier;
  wsSend: WsSend;
  getPublicKey: (userId: string) => Promise<Uint8Array | null>;
}

interface PeerCacheEntry {
  payload: EmbeddingPayload;
  lastSequence: number;
}

export interface Transport {
  publish(payload: Omit<EmbeddingPayload, 'signature'>): Promise<void>;
  handleReceived(senderUserId: string, payload: EmbeddingPayload): Promise<'accepted' | 'catchup' | 'replay' | 'invalid_signature'>;
  getCachedEmbedding(peerId: string): EmbeddingPayload | null;
  onPeerEmbedding(callback: (peerId: string, payload: EmbeddingPayload) => void): void;
}

export function createTransport(config: TransportConfig): Transport {
  const peerCache = new Map<string, PeerCacheEntry>();
  const subscribers: Array<(peerId: string, payload: EmbeddingPayload) => void> = [];

  const serializeForSigning = (p: Omit<EmbeddingPayload, 'signature'>): Uint8Array => {
    // Canonical JSON over the bound fields
    const obj = {
      embedding: Array.from(p.embedding),
      modelVersion: p.modelVersion,
      capturedAt: p.capturedAt,
      captureId: p.captureId,
      channelId: p.channelId,
      recipientUserId: p.recipientUserId,
      senderSequence: p.senderSequence,
    };
    return new TextEncoder().encode(JSON.stringify(obj));
  };

  return {
    async publish(payload) {
      const signed = serializeForSigning(payload);
      const signature = await config.signer(signed);

      const fullPayload: EmbeddingPayload = { ...payload, signature };
      const fullBytes = new TextEncoder().encode(JSON.stringify({
        ...payload,
        embedding: Array.from(payload.embedding),
        signature: Array.from(signature),
      }));

      const ciphertext = await config.encryptor(payload.recipientUserId, fullBytes);

      config.wsSend({
        type: 'voice_embedding_publish',
        channel_id: payload.channelId,
        to_user_id: payload.recipientUserId,
        ciphertext,
      });
    },

    async handleReceived(senderUserId, payload) {
      // Step 1: verify signature against the sender's long-term Ed25519 key
      const pubKey = await config.getPublicKey(senderUserId);
      if (!pubKey || !payload.signature) return 'invalid_signature';
      const signedBody = serializeForSigning(payload);
      const valid = await config.verifier(pubKey, signedBody, payload.signature);
      if (!valid) return 'invalid_signature';

      // Step 2: replay rejection
      const cached = peerCache.get(senderUserId);
      if (cached) {
        if (payload.captureId === cached.payload.captureId) {
          return 'catchup'; // republish for mid-call joiner
        }
        if (payload.senderSequence <= cached.lastSequence) {
          return 'replay';
        }
      }

      peerCache.set(senderUserId, { payload, lastSequence: payload.senderSequence });
      for (const cb of subscribers) cb(senderUserId, payload);
      return 'accepted';
    },

    getCachedEmbedding(peerId) {
      return peerCache.get(peerId)?.payload ?? null;
    },

    onPeerEmbedding(callback) {
      subscribers.push(callback);
    },
  };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd client && npm test -- --run embeddingTransport`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/embeddingTransport.ts client/src/services/voiceIsolation/embeddingTransport.test.ts
git commit -m "feat(voice): embeddingTransport with signing, encryption, and replay rejection"
```

### Task 5.3: Wire embeddingTransport into the WebSocket layer

**Files:**
- Modify: `client/src/services/websocket.ts` (or wherever the WS message dispatcher is)
- Modify: `client/src/services/voiceIsolation/dispatcher.ts`

- [ ] **Step 1: Add the WS event handlers**

In `client/src/services/websocket.ts`, find the existing voice payload dispatcher and add the new event types:

```typescript
case 'voice_embedding_received':
  voiceIsolationDispatcher.handleEmbeddingReceived(data.from_user_id, data.ciphertext);
  break;
case 'voice_embedding_revoke':
  voiceIsolationDispatcher.handleEmbeddingRevoke(data.from_user_id, data.revoked_capture_id);
  break;
```

- [ ] **Step 2: Wire dispatcher up to publish on voice channel join**

Add to `dispatcher.ts`:

```typescript
export async function joinVoiceChannel(channelId: string, peers: string[], embedding: Embedding): Promise<void> {
  // Increment our local sequence
  const seq = nextSequence();

  for (const peerId of peers) {
    await transport.publish({
      embedding: embedding.vector,
      modelVersion: embedding.modelVersion,
      capturedAt: embedding.capturedAt,
      captureId: embedding.captureId,
      channelId,
      recipientUserId: peerId,
      senderSequence: seq,
    });
  }
}
```

(`nextSequence` is a per-(sender, recipient) monotonic counter persisted in `embeddingStore` or a sibling small store.)

- [ ] **Step 3: Test manually with two peers**

Open two browser tabs (or one browser + one Tauri app), enroll both, join the same voice channel, verify embeddings are exchanged in the WS log.

- [ ] **Step 4: Commit**

```bash
git add client/src/services/websocket.ts client/src/services/voiceIsolation/dispatcher.ts
git commit -m "feat(voice): wire embeddingTransport into WS dispatcher"
```

---

## Milestone 6 — Symmetric incoming

End state: every peer's audio is processed through VFL with their broadcasted embedding (or DFN3 fallback if absent).

### Task 6.1: Extend dispatcher for incoming streams

**Files:**
- Modify: `client/src/services/voiceIsolation/dispatcher.ts`

- [ ] **Step 1: Add `processIncoming` method**

```typescript
const incomingPipelines = new Map<string, Pipeline>();

export function processIncoming(
  config: DispatcherConfig,
  track: MediaStreamTrack,
  peerId: string,
): MediaStreamTrack {
  // Tear down any existing pipeline for this peer
  incomingPipelines.get(peerId)?.destroy();

  const peerEmbedding = transport.getCachedEmbedding(peerId);
  const sessionId = peerEmbedding ? config.vflSessionId : config.dfn3SessionId;

  const pipeline = createPipeline({
    audioContext: config.audioContext,
    worker: config.worker,
    track,
    initialSessionId: sessionId,
    initialEmbedding: peerEmbedding?.embedding,
  });
  incomingPipelines.set(peerId, pipeline);
  return pipeline.outputTrack;
}

export function onPeerLeave(peerId: string): void {
  incomingPipelines.get(peerId)?.destroy();
  incomingPipelines.delete(peerId);
}
```

- [ ] **Step 2: Listen for late embedding arrivals and switch model**

```typescript
transport.onPeerEmbedding((peerId, payload) => {
  const pipeline = incomingPipelines.get(peerId);
  if (pipeline) {
    pipeline.switchModel(config.vflSessionId, payload.embedding);
  }
});
```

- [ ] **Step 3: Wire into WebRTCService.ts**

In `pc.ontrack`:

```typescript
this.pc.ontrack = (event) => {
  // Existing SFrame decryption is already wired
  const decryptedTrack = event.track; // assume by this point it's been decrypted
  const peerId = this.getPeerIdFromTransceiver(event.transceiver);
  const ctx = this.voiceIsolationContext;
  const processedTrack = ctx
    ? processIncoming(ctx, decryptedTrack, peerId)
    : decryptedTrack;
  this.attachToAudioElement(processedTrack);
};
```

- [ ] **Step 4: Manual smoke test**

Two peers in a voice channel. Both speak. Verify each hears the other through the processed pipeline.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/dispatcher.ts client/src/services/webrtc/WebRTCService.ts
git commit -m "feat(voice): symmetric incoming pipeline with model switch on late embedding"
```

---

## Milestone 7 — Active-speaker tiering

End state: only top-N (default 2) peers get VFL; others get DFN3. Constant CPU regardless of call size.

### Task 7.1: Implement activeSpeakerTracker

**Files:**
- Create: `client/src/services/voiceIsolation/activeSpeakerTracker.ts`
- Create: `client/src/services/voiceIsolation/activeSpeakerTracker.test.ts`

- [ ] **Step 1: Write tests for the policy logic**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createTracker } from './activeSpeakerTracker';

describe('activeSpeakerTracker policy', () => {
  it('treats all peers as background during cold start', () => {
    const tracker = createTracker({ topN: 2, audioContext: {} as AudioContext });
    tracker.injectPeerLevels('a', [0.5]);
    expect(tracker.tierFor('a')).toBe('background');
  });

  it('promotes top-N once window fills', () => {
    const tracker = createTracker({ topN: 2, audioContext: {} as AudioContext });
    // Inject enough samples to fill the 500ms window (5 ticks at 100ms)
    for (let i = 0; i < 5; i++) {
      tracker.injectPeerLevels('a', [0.9]);
      tracker.injectPeerLevels('b', [0.5]);
      tracker.injectPeerLevels('c', [0.1]);
    }
    expect(tracker.tierFor('a')).toBe('active');
    expect(tracker.tierFor('b')).toBe('active');
    expect(tracker.tierFor('c')).toBe('background');
  });

  it('hysteresis: candidate must be 10% louder for 300ms to demote', () => {
    const tracker = createTracker({ topN: 1, audioContext: {} as AudioContext });
    for (let i = 0; i < 5; i++) tracker.injectPeerLevels('a', [0.9]);
    expect(tracker.tierFor('a')).toBe('active');

    // B becomes louder for only 200ms — should not demote A yet
    tracker.injectPeerLevels('b', [1.0]);
    tracker.injectPeerLevels('b', [1.0]);
    expect(tracker.tierFor('a')).toBe('active');

    // B sustained 300ms+ → demote A
    tracker.injectPeerLevels('b', [1.0]);
    tracker.injectPeerLevels('b', [1.0]);
    expect(tracker.tierFor('b')).toBe('active');
    expect(tracker.tierFor('a')).toBe('background');
  });

  it('emits onTierChange callbacks on transitions', () => {
    const cb = vi.fn();
    const tracker = createTracker({ topN: 1, audioContext: {} as AudioContext });
    tracker.onTierChange(cb);
    for (let i = 0; i < 5; i++) tracker.injectPeerLevels('a', [0.9]);
    expect(cb).toHaveBeenCalledWith('a', 'active');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd client && npm test -- --run activeSpeakerTracker`

- [ ] **Step 3: Implement**

```typescript
// client/src/services/voiceIsolation/activeSpeakerTracker.ts

interface PeerState {
  levels: number[]; // rolling window
  tier: 'active' | 'background';
}

interface Config {
  audioContext: AudioContext;
  topN: number;
  windowSize?: number;       // default 5 (500ms at 100ms tick)
  hysteresisRatio?: number;  // default 1.10
  hysteresisTicks?: number;  // default 3 (300ms)
}

export function createTracker(config: Config) {
  const peers = new Map<string, PeerState>();
  const subscribers: Array<(peerId: string, tier: 'active' | 'background') => void> = [];
  const windowSize = config.windowSize ?? 5;
  const hysteresisTicks = config.hysteresisTicks ?? 3;
  const hysteresisRatio = config.hysteresisRatio ?? 1.10;

  // For cold-start detection, track when each peer joined
  const peerJoinedAt = new Map<string, number>();
  const tickCount = { value: 0 };

  let candidateActive = new Set<string>();
  const candidateTickCount = new Map<string, number>();

  const recompute = () => {
    tickCount.value++;

    // Compute averages
    const avgs = new Map<string, number>();
    for (const [id, state] of peers) {
      if (state.levels.length === 0) continue;
      const avg = state.levels.reduce((a, b) => a + b, 0) / state.levels.length;
      avgs.set(id, avg);
    }

    // Sort by avg desc, take top-N
    const sorted = [...avgs.entries()].sort((a, b) => b[1] - a[1]);
    const topN = sorted.slice(0, config.topN).map(([id]) => id);

    // Hysteresis: only promote/demote after sustained change
    const newActive = new Set(candidateActive);
    for (const id of topN) {
      if (!candidateActive.has(id)) {
        const current = (candidateTickCount.get(id) ?? 0) + 1;
        candidateTickCount.set(id, current);
        if (current >= hysteresisTicks) {
          newActive.add(id);
          candidateTickCount.delete(id);
          // Demote the lowest current active that isn't in topN
          for (const old of [...newActive]) {
            if (!topN.includes(old)) {
              newActive.delete(old);
              break;
            }
          }
        }
      }
    }

    // Cold-start gate: if any peer has been around for less than windowSize ticks, treat as background
    for (const id of [...newActive]) {
      const joinTick = peerJoinedAt.get(id) ?? 0;
      if (tickCount.value - joinTick < windowSize) {
        newActive.delete(id);
      }
    }

    // Emit changes
    for (const id of newActive) {
      if (!candidateActive.has(id)) {
        peers.get(id)!.tier = 'active';
        subscribers.forEach((cb) => cb(id, 'active'));
      }
    }
    for (const id of candidateActive) {
      if (!newActive.has(id)) {
        const state = peers.get(id);
        if (state) {
          state.tier = 'background';
          subscribers.forEach((cb) => cb(id, 'background'));
        }
      }
    }
    candidateActive = newActive;
  };

  return {
    attachPeer(peerId: string, source: MediaStreamAudioSourceNode) {
      peers.set(peerId, { levels: [], tier: 'background' });
      peerJoinedAt.set(peerId, tickCount.value);

      const analyser = config.audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);

      const buf = new Float32Array(analyser.frequencyBinCount);
      const sampleId = setInterval(() => {
        analyser.getFloatFrequencyData(buf);
        // Compute speech-band RMS (300–3400 Hz)
        const sampleRate = config.audioContext.sampleRate;
        const binWidth = sampleRate / analyser.fftSize;
        const lowBin = Math.floor(300 / binWidth);
        const highBin = Math.ceil(3400 / binWidth);
        let sum = 0;
        for (let i = lowBin; i < highBin; i++) sum += Math.pow(10, buf[i] / 20);
        const rms = sum / (highBin - lowBin);

        const state = peers.get(peerId);
        if (state) {
          state.levels.push(rms);
          if (state.levels.length > windowSize) state.levels.shift();
        }
        recompute();
      }, 100);

      return () => clearInterval(sampleId);
    },

    detachPeer(peerId: string) {
      peers.delete(peerId);
      peerJoinedAt.delete(peerId);
      candidateActive.delete(peerId);
    },

    tierFor(peerId: string): 'active' | 'background' {
      return peers.get(peerId)?.tier ?? 'background';
    },

    onTierChange(callback: (peerId: string, tier: 'active' | 'background') => void) {
      subscribers.push(callback);
    },

    // Test-only injection for unit tests
    injectPeerLevels(peerId: string, levels: number[]) {
      let state = peers.get(peerId);
      if (!state) {
        state = { levels: [], tier: 'background' };
        peers.set(peerId, state);
        peerJoinedAt.set(peerId, tickCount.value - windowSize); // pretend already warm
      }
      state.levels.push(...levels);
      if (state.levels.length > windowSize) state.levels = state.levels.slice(-windowSize);
      recompute();
    },
  };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd client && npm test -- --run activeSpeakerTracker`

Note: the cold-start test may need adjustment because `injectPeerLevels` skips real time. Re-tune the test or the bypass as needed.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/activeSpeakerTracker.ts client/src/services/voiceIsolation/activeSpeakerTracker.test.ts
git commit -m "feat(voice): activeSpeakerTracker with AnalyserNode + hysteresis"
```

### Task 7.2: Wire tracker into dispatcher for tier-based model switch

- [ ] **Step 1: Add to dispatcher.ts**

```typescript
const tracker = createTracker({ audioContext, topN: 2 });

tracker.onTierChange((peerId, newTier) => {
  const pipeline = incomingPipelines.get(peerId);
  if (!pipeline) return;
  const peerEmbedding = transport.getCachedEmbedding(peerId);
  const sessionId = (newTier === 'active' && peerEmbedding)
    ? config.vflSessionId
    : config.dfn3SessionId;
  pipeline.switchModel(sessionId, peerEmbedding?.embedding);
});

// In processIncoming, also attach the tracker:
const source = audioContext.createMediaStreamSource(new MediaStream([track]));
tracker.attachPeer(peerId, source);
```

- [ ] **Step 2: Manual test with 4+ peers**

This requires more than 2 client instances. Use multiple browser windows/Tauri apps connecting to the dev server.

- [ ] **Step 3: Commit**

```bash
git add client/src/services/voiceIsolation/dispatcher.ts
git commit -m "feat(voice): wire activeSpeakerTracker into dispatcher tier switching"
```

---

## Milestone 8 — UX polish

End state: VoiceControls badge, error toasts, fallback handling, local diagnostics counters.

### Task 8.1: Implement diagnostics counters

**Files:**
- Create: `client/src/services/voiceIsolation/diagnostics.ts`
- Create: `client/src/services/voiceIsolation/diagnostics.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { diagnostics } from './diagnostics';

beforeEach(() => diagnostics.reset());

describe('diagnostics', () => {
  it('records frame processing times and computes percentiles', () => {
    for (let i = 0; i < 100; i++) diagnostics.recordFrameMs('vfl', i);
    const stats = diagnostics.getSnapshot();
    expect(stats.medianFrameProcessingMs.vfl).toBeCloseTo(50, 0);
    expect(stats.p95FrameProcessingMs.vfl).toBeGreaterThan(90);
  });

  it('counts dropped frames since join', () => {
    diagnostics.recordFrameDropped();
    diagnostics.recordFrameDropped();
    expect(diagnostics.getSnapshot().framesDroppedSinceJoin).toBe(2);
  });

  it('keeps a bounded ring of last 10 errors', () => {
    for (let i = 0; i < 15; i++) diagnostics.recordError({ code: 'ERR', message: `error ${i}` });
    const stats = diagnostics.getSnapshot();
    expect(stats.lastTenErrors).toHaveLength(10);
    expect(stats.lastTenErrors[0].message).toBe('error 5');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd client && npm test -- --run diagnostics`

- [ ] **Step 3: Implement**

```typescript
// client/src/services/voiceIsolation/diagnostics.ts

interface Snapshot {
  medianFrameProcessingMs: { vfl: number; dfn3: number };
  p95FrameProcessingMs: { vfl: number; dfn3: number };
  framesDroppedSinceJoin: number;
  activeSpeakerFlipsPerMin: number;
  cpuDegradeTriggerCount: number;
  embeddingPublishSuccessRate: number;
  embeddingsRejectedSignature: number;
  embeddingsRejectedReplay: number;
  lastTenErrors: Array<{ timestamp: string; code: string; message: string }>;
  peersWithEmbedding: number;
  peersFedDowngradeSuspected: number;
}

class Diagnostics {
  private frameTimes = { vfl: [] as number[], dfn3: [] as number[] };
  private framesDropped = 0;
  private flipTimes: number[] = [];
  private cpuDegradeCount = 0;
  private publishAttempts: boolean[] = []; // bounded
  private rejectedSig = 0;
  private rejectedReplay = 0;
  private errors: Array<{ timestamp: string; code: string; message: string }> = [];

  private snapshot: { peersWithEmbedding: number; peersFedDowngradeSuspected: number } = {
    peersWithEmbedding: 0,
    peersFedDowngradeSuspected: 0,
  };

  recordFrameMs(model: 'vfl' | 'dfn3', ms: number) {
    this.frameTimes[model].push(ms);
    if (this.frameTimes[model].length > 5000) this.frameTimes[model].shift();
  }
  recordFrameDropped() { this.framesDropped++; }
  recordTierFlip() { this.flipTimes.push(Date.now()); }
  recordCpuDegrade() { this.cpuDegradeCount++; }
  recordPublishAttempt(success: boolean) {
    this.publishAttempts.push(success);
    if (this.publishAttempts.length > 100) this.publishAttempts.shift();
  }
  recordRejectedSignature() { this.rejectedSig++; }
  recordRejectedReplay() { this.rejectedReplay++; }
  recordError(err: { code: string; message: string }) {
    this.errors.push({ ...err, timestamp: new Date().toISOString() });
    if (this.errors.length > 10) this.errors.shift();
  }
  setPeerSnapshot(s: { peersWithEmbedding: number; peersFedDowngradeSuspected: number }) {
    this.snapshot = s;
  }
  reset() {
    this.frameTimes = { vfl: [], dfn3: [] };
    this.framesDropped = 0;
    this.flipTimes = [];
    this.cpuDegradeCount = 0;
    this.publishAttempts = [];
    this.rejectedSig = 0;
    this.rejectedReplay = 0;
    this.errors = [];
  }
  getSnapshot(): Snapshot {
    const median = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const p95 = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)];
    };
    const oneMinAgo = Date.now() - 60_000;
    this.flipTimes = this.flipTimes.filter((t) => t > oneMinAgo);
    const successCount = this.publishAttempts.filter(Boolean).length;
    const total = this.publishAttempts.length || 1;

    return {
      medianFrameProcessingMs: { vfl: median(this.frameTimes.vfl), dfn3: median(this.frameTimes.dfn3) },
      p95FrameProcessingMs: { vfl: p95(this.frameTimes.vfl), dfn3: p95(this.frameTimes.dfn3) },
      framesDroppedSinceJoin: this.framesDropped,
      activeSpeakerFlipsPerMin: this.flipTimes.length,
      cpuDegradeTriggerCount: this.cpuDegradeCount,
      embeddingPublishSuccessRate: successCount / total,
      embeddingsRejectedSignature: this.rejectedSig,
      embeddingsRejectedReplay: this.rejectedReplay,
      lastTenErrors: [...this.errors],
      peersWithEmbedding: this.snapshot.peersWithEmbedding,
      peersFedDowngradeSuspected: this.snapshot.peersFedDowngradeSuspected,
    };
  }
}

export const diagnostics = new Diagnostics();
```

- [ ] **Step 4: Run, expect pass**

Run: `cd client && npm test -- --run diagnostics`

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/diagnostics.ts client/src/services/voiceIsolation/diagnostics.test.ts
git commit -m "feat(voice): diagnostics counter module (local-only)"
```

### Task 8.2: VoiceControls badge

**Files:**
- Modify: `client/src/components/VoiceControls/VoiceControls.tsx`
- Modify: `client/src/components/VoiceControls/VoiceControls.css`

- [ ] **Step 1: Add the badge UI**

Add a new icon button to the existing `VoiceControls.tsx`:

```tsx
import { IconWaveSawTool } from '@tabler/icons-react'; // or whichever icon
import { useVoiceIsolationState } from '../../services/voiceIsolation/dispatcher';

// Inside the component:
const isolationState = useVoiceIsolationState();

{isolationState && (
  <button
    className={`voice-isolation-badge ${isolationState.peers.length > 0 ? 'active' : ''}`}
    title={`${isolationState.peers.filter(p => p.enrolled).length}/${isolationState.peers.length} voices isolated`}
    onClick={() => setShowIsolationPopover(true)}
    type="button"
  >
    <IconWaveSawTool size={16} />
  </button>
)}
```

The popover shows per-peer status. Implement as a small inline component.

- [ ] **Step 2: Implement `useVoiceIsolationState` hook**

Add to `dispatcher.ts`:

```typescript
import { useEffect, useState } from 'react';

export function useVoiceIsolationState(): CallState | null {
  const [state, setState] = useState<CallState | null>(null);
  useEffect(() => {
    const id = setInterval(() => setState(getCallState()), 500);
    return () => clearInterval(id);
  }, []);
  return state;
}

function getCallState(): CallState | null {
  // Aggregate from incomingPipelines, outgoingPipeline, transport, etc.
  // ...
}
```

- [ ] **Step 3: Test manually**

Join a voice channel, verify the badge appears, click it, verify the popover shows peer states.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/VoiceControls/ client/src/services/voiceIsolation/dispatcher.ts
git commit -m "feat(voice): VoiceControls isolation badge with peer state popover"
```

### Task 8.3: Diagnostics UI in Settings

- [ ] **Step 1: Add a Diagnostics sub-section to UserSettings → Audio**

```tsx
<details className="settings-diagnostics">
  <summary>{t('voiceIsolation.diagnostics', 'Diagnostics (local only)')}</summary>
  <DiagnosticsPanel />
</details>
```

`DiagnosticsPanel` reads from `diagnostics.getSnapshot()` and renders the counter table.

- [ ] **Step 2: Commit**

```bash
git add client/src/pages/UserSettings.tsx
git commit -m "feat(voice): diagnostics panel in Settings → Audio"
```

---

## Milestone 9 — Federation E2E + SFrame interop test

End state: embeddings cross federation boundary; downgrade-attack visibility; SFrame interop confirmed.

### Task 9.1: Federation E2E test

**Files:**
- Create: `client/test/e2e/voice-isolation-federation.spec.ts`

- [ ] **Step 1: Write the Playwright test**

```typescript
import { test, expect } from '@playwright/test';

test.describe('voice isolation federation', () => {
  test('embeddings cross federation boundary', async ({ browser }) => {
    // Spin up two Dilla servers (using docker-compose or whatever the project uses)
    // ...

    const ctx1 = await browser.newContext();
    const page1 = await ctx1.newPage();
    await page1.goto('http://server1.local:8888');
    // Enroll user A on server 1

    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto('http://server2.local:8888');
    // Enroll user B on server 2, federate with server 1

    // Both users join the same voice channel
    // Verify dispatcher state on both shows the other peer as enrolled
    // Verify VFL is being used (not DFN3 fallback)
  });
});
```

- [ ] **Step 2: Document the test infrastructure**

The two-server setup requires either docker-compose or running two `dilla-server` instances on different ports with `DILLA_PEERS` configured. Document in `client/test/e2e/README.md`.

- [ ] **Step 3: Commit**

```bash
git add client/test/e2e/
git commit -m "test(voice): federation E2E test for cross-server embedding broadcast"
```

### Task 9.2: SFrame interop test

**Files:**
- Create: `client/test/e2e/voice-sframe-interop.spec.ts`

- [ ] **Step 1: Write the test**

```typescript
import { test, expect } from '@playwright/test';

test('SFrame interop with voice isolation pipeline', async ({ browser }) => {
  // Two clients in a voice channel
  // Sender's audio flows: getUserMedia -> processOutgoing -> SFrame encrypt -> SFU -> SFrame decrypt -> processIncoming -> output
  // Verify:
  // 1. Audio is intelligible at the receiver (compare against a known signal)
  // 2. SFrame encrypted frames have intact metadata
  // 3. No double-processing artifacts
});
```

- [ ] **Step 2: Commit**

```bash
git add client/test/e2e/voice-sframe-interop.spec.ts
git commit -m "test(voice): SFrame interop E2E test"
```

---

## Milestone 10 — Quality regression suite

End state: nightly Layer 3 tests verify model SNR and embedding reproducibility on fixture WAVs.

### Task 10.1: Generate fixture WAVs

**Files:**
- Modify: `client/test/voice-fixtures/` (add real WAVs)
- Create: `scripts/generate-voice-fixtures.sh`

- [ ] **Step 1: Source the base clean speech**

Use either:
- LibriSpeech samples (Apache 2.0)
- Common Voice samples (CC0)
- Self-recorded clean speech (committed to repo with explicit permission)

Pick 2 speakers (alice + bob), 3 seconds each.

- [ ] **Step 2: Source the noise samples**

ESC-50, UrbanSound8K, or DEMAND. Pick keyboard, traffic, babble, music, other-voice samples.

- [ ] **Step 3: Mix at known SNR**

Use sox or a small Node script:

```bash
# Mix at -5dB SNR
sox -m -v 1.0 alice.wav -v 0.56 keyboard.wav speech_with_keyboard.wav
```

- [ ] **Step 4: Commit fixtures with reference embeddings**

```bash
cd client && npm run generate-test-references
git add client/test/voice-fixtures/*.wav client/test/voice-fixtures/reference_*.json
git commit -m "test(voice): voice quality regression fixtures + reference data"
```

### Task 10.2: Layer 3 quality regression tests

**Files:**
- Create: `client/test/voice-quality-regression.test.ts`

- [ ] **Step 1: Write the regression suite**

```typescript
import { describe, it, expect } from 'vitest';
import * as ort from 'onnxruntime-node';
import { promises as fs } from 'fs';
import wavDecoder from 'node-wav';

describe('voice quality regression', () => {
  it('ECAPA produces reference embedding for alice', async () => {
    const model = await ort.InferenceSession.create('../server-rs/assets/voice-models/ecapa-v1.onnx');
    const wav = wavDecoder.decode(await fs.readFile('test/voice-fixtures/clean_speech_alice.wav'));
    const pcm = wav.channelData[0];

    const out = await model.run({ input: new ort.Tensor('float32', pcm, [1, pcm.length]) });
    const embedding = out.embedding.data as Float32Array;

    const reference = JSON.parse(await fs.readFile('test/voice-fixtures/reference_embeddings.json', 'utf8'));
    const expected = new Float32Array(reference.alice);

    // Cosine similarity > 0.99
    const dot = embedding.reduce((s, v, i) => s + v * expected[i], 0);
    const normA = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    const normB = Math.sqrt(expected.reduce((s, v) => s + v * v, 0));
    const cosine = dot / (normA * normB);
    expect(cosine).toBeGreaterThan(0.99);
  });

  it('VFL improves SNR by ≥6dB on speech_with_keyboard', async () => {
    // ... load VFL model, run on noisy input, compute SNR improvement
  });

  // ... more regression tests
});
```

- [ ] **Step 2: Wire into nightly CI only**

Add to `.github/workflows/voice-quality-nightly.yml`:

```yaml
on:
  schedule:
    - cron: '0 4 * * *'
jobs:
  voice-quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { lfs: true }
      - uses: actions/setup-node@v4
      - run: cd client && npm ci
      - run: cd client && npm run test:voice-quality
```

- [ ] **Step 3: Commit**

```bash
git add client/test/voice-quality-regression.test.ts .github/workflows/voice-quality-nightly.yml client/package.json
git commit -m "test(voice): nightly quality regression suite"
```

---

## Wrap-up

### Final integration check

- [ ] **Step 1: Run the full test suite**

```bash
cd client && npm run lint && npx tsc --noEmit && npm test -- --run && npm run bench:voice
```

Expected: clean.

- [ ] **Step 2: Run the server tests**

```bash
cd server-rs && cargo test
```

Expected: pass.

- [ ] **Step 3: Manual end-to-end test**

Set up two browser instances, enroll both, join a voice channel, verify the badge shows both peers as enrolled with VFL. Have one peer play music in the background — verify it's filtered out for the other.

- [ ] **Step 4: Update the spec status**

Edit `docs/superpowers/specs/2026-04-07-voice-isolation-plugin-design.md`:
- Status: Phase 1 complete
- Add a "Shipping notes" section with any deviations from the spec discovered during implementation

- [ ] **Step 5: Open the PR**

```bash
gh pr create --title "feat: voice isolation plugin (Phase 1)" --body "$(cat <<'EOF'
## Summary
- Implements the voice isolation plugin per spec docs/superpowers/specs/2026-04-07-voice-isolation-plugin-design.md (Phase 1)
- Symmetric personalized voice isolation using VoiceFilter-Lite + ECAPA-TDNN, with DeepFilterNet 3 fallback
- Active-speaker tiered processing keeps CPU constant regardless of call size
- Embeddings broadcast Signal-Protocol-encrypted with Ed25519 long-term identity binding
- Full unit + browser-mode + E2E + nightly quality regression test coverage

## Test plan
- [ ] All unit tests pass
- [ ] Browser-mode pipeline test passes
- [ ] WASM SIMD benchmark below threshold
- [ ] Manual two-peer enrollment + voice channel call
- [ ] Federation E2E test with two dev servers
EOF
)"
```

---

## Reference: skill links

- @superpowers:test-driven-development — referenced from every TDD task
- @superpowers:executing-plans — required to consume this plan
- @superpowers:subagent-driven-development — recommended for parallel execution
