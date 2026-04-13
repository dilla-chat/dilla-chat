# Voice Noise Suppression (DFN3-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship real-time noise suppression on Dilla voice channels using DeepFilterNet 3, applied to both your outgoing mic and every incoming peer's audio. Generic suppression — strips background noise (keyboard, traffic, fans) but does not reject other human voices.

**Architecture:** AudioWorklet pumps PCM into SharedArrayBuffer ring buffers; a dedicated Web Worker pool runs ONNX Runtime Web inference for DFN3. The pipeline plugs into `WebRTCService.ts` at one seam, sitting *inside* the existing SFrame encryption boundary (process before encrypt outgoing, after decrypt incoming).

**Tech Stack:**
- Client: TypeScript, React 19, ONNX Runtime Web (`onnxruntime-web`), AudioWorklet, Web Workers, SharedArrayBuffer + Atomics, IndexedDB
- Server: Rust, axum, rust-embed, Git LFS for model artifact
- Test: vitest (unit + browser mode), Playwright (E2E)

**Spec:** `docs/superpowers/specs/2026-04-07-voice-isolation-plugin-design.md` (v3 pivot notice section)

**Branch:** `feat/voice-isolation-phase1` (already created off main, this plan continues that branch)

**Pivoted from:** `docs/superpowers/plans/2026-04-07-voice-isolation-plugin-phase1.md` — the original VoiceFilter-Lite plan, now obsolete except for the foundation milestones (1, 3, 4, 6, 8, 9 partial, 10) that are still valid with simplifications.

## v2 amendment (post spike 0b.1) — DFN3 is multi-graph

Spike 0b.1 found that DFN3 is **not** a single PCM-in/PCM-out ONNX. The
official Rikorose/DeepFilterNet export ships three sub-graphs:

- `enc.onnx` (1.95 MB) — encoder; in: `(feat_erb, feat_spec)`, out: `(e0..e3, emb, c0, lsnr)`
- `erb_dec.onnx` (3.29 MB) — ERB-band gain decoder; out: `m` shape `[1,1,T,32]`
- `df_dec.onnx` (3.34 MB) — deep-filter coefficient decoder; out: `coefs` shape `[1,T,96,10]`

Wrapping these requires a host-side DSP pipeline (STFT, ERB feature
extraction, deep-filter post-processing, iSTFT) that the original plan
did not anticipate. **The user explicitly chose option A (wrap DFN3
multi-graph in TypeScript) over the simpler-but-lower-quality
NSNet2 substitute.** This adds substantial scope to milestone 2:

- New file: `client/src/services/voiceIsolation/dfn3Pipeline.ts` (~500 lines
  of DSP code: STFT/iSTFT, ERB band feature extraction, deep filter
  post-processing). Port the relevant parts of `libDF/src/tract.rs` to
  TypeScript.
- The inference worker now runs three ONNX sessions per frame (encoder
  → ERB decoder + DF decoder in parallel → host post-processing).
- The model loader downloads and caches all three sub-graphs (and their
  manifest entries) instead of one.
- The benchmark in M0b.2 must measure end-to-end latency through the
  full chain, not a single `session.run()` call.

DFN3 hyperparameters (from the upstream `config.ini`):
- Sample rate: 48000 Hz
- FFT size: 960
- Hop size: 480 (10 ms @ 50 fps)
- Number of ERB bands: 32
- Number of DF bands: 96
- DF order: 5
- Conv lookahead: 2 frames
- DF lookahead: 2 frames
- **Total algorithmic delay: 40 ms** (within the budget for live calls)

The new `Dfn3ModelIOSpec` looks like:

```ts
interface Dfn3ModelIOSpec {
  encoder: { sessionId: string; inputs: ['feat_erb', 'feat_spec']; outputs: ['e0','e1','e2','e3','emb','c0','lsnr'] };
  erbDecoder: { sessionId: string; outputs: ['m'] };
  dfDecoder: { sessionId: string; outputs: ['coefs'] };
  sampleRate: 48000;
  fftSize: 960;
  hopSize: 480;
  nbErb: 32;
  nbDf: 96;
  dfOrder: 5;
  lookaheadFrames: 4; // conv + df = 40ms total
}
```

The "M2 — Pipeline" milestone in this plan is now expanded to include
the dfn3Pipeline.ts module and its tests. The other milestones (M1
foundation, M3 dispatcher, M4 UX, M5 tests) are unaffected.

**Estimated additional implementation effort vs the original DFN3 plan:**
roughly +50% scope on milestone 2, mostly DSP code and tests. Risk
factor: subtle DSP bugs that only show up as audible artifacts.
Mitigation: per-frame numerical comparison against the upstream Python
reference output (committed as fixtures).


---

## What this plan does NOT include (vs. the original)

The original Phase 1 plan had ~50 tasks across 10 milestones. The DFN3-only pivot removes:

- ❌ Spike 0a (VFL ONNX availability) — already complete and produced the pivot decision
- ❌ Spike 0c (ECAPA-TDNN verification) — no longer needed without enrollment
- ❌ Milestone 2 entirely (Enrollment vertical slice — no enrollment in DFN3-only)
- ❌ Milestone 5 entirely (Embedding broadcast — no embeddings to broadcast)
- ❌ Milestone 7 entirely (Active-speaker tiering — only one model, nothing to tier)
- ❌ Federation E2E test from Milestone 9 (no embedding crosses federation)
- ❌ HKDF-derived embeddingStore from Milestone 1
- ❌ Three-model loader (vfl + ecapa + dfn3) — only loads DFN3 now
- ❌ ECAPA-TDNN inference path from inferenceWorker
- ❌ Tier-based model swap from dispatcher
- ❌ Per-peer enrollment status from VoiceControls badge
- ❌ "Setup voice profile" UX

What's left is roughly **18 tasks** across **6 milestones**. Genuinely shippable in a focused effort.

---

## File Structure Map (revised)

### New client files

```
client/src/services/voiceIsolation/
├── index.ts                              # Public exports
├── modelLoader.ts                        # Fetch + checksum + IndexedDB cache (DFN3 only)
├── modelLoader.test.ts
├── pipeline.ts                           # Per-stream worklet+worker+ring bundle
├── pipeline.test.ts
├── dispatcher.ts                         # Per-call orchestration (simpler — no embeddings)
├── dispatcher.test.ts
├── diagnostics.ts                        # Local-only counters (simplified)
├── diagnostics.test.ts
├── audioWorklet/
│   ├── ringBufferProcessor.js            # AudioWorkletProcessor — buffer pump
│   └── ringProtocol.ts                   # SAB ring buffer protocol (shared with worker)
├── inferenceWorker.ts                    # Dedicated Worker — runs DFN3 ORT session
└── types.ts                              # Shared types
```

### Modified client files

- `client/src/services/webrtc/WebRTCService.ts` — wire `voiceIsolation.processOutgoing()` and `processIncoming()` at the SFrame boundary
- `client/src/services/noiseSuppression.ts` — delete the no-op stub
- `client/src/stores/audioSettingsStore.ts` — `noiseSuppression: boolean` already exists; verify it now controls the new plugin
- `client/src/pages/UserSettings.tsx` — wire the existing toggle to the dispatcher
- `client/src/components/VoiceControls/VoiceControls.tsx` — small status badge (simplified, just on/off + frame stats)
- `client/src/i18n/locales/en.json` — add new strings
- `client/vite.config.ts` — verify it doesn't strip COOP/COEP in dev
- `client/package.json` — add `onnxruntime-web` dependency, add postinstall script

### New server files

```
server-rs/assets/voice-models/
├── manifest.json                         # Generated by build.rs
└── dfn3-v1.onnx                          # Git LFS (~2MB)
```

### Modified server files

- `server-rs/build.rs` — emit `manifest.json` with SHA-256 of dfn3-v1.onnx
- `server-rs/src/api/voice.rs` — add `models_manifest()` and `models_serve()` handlers
- `server-rs/src/api/mod.rs` — register the new routes
- `server-rs/src/main.rs` — set COOP/COEP headers scoped to client routes
- `server-rs/Cargo.toml` — add `sha2` to build-dependencies
- `.gitattributes` — mark `server-rs/assets/voice-models/*.onnx` as LFS

### Test infra

- `client/test/voice-fixtures/` — small WAV files for quality regression (3 fixtures suffice for DFN3)

---

## Milestone 0' — Spike 0b only (DFN3 latency benchmark)

DFN3 is well-validated (Jitsi uses it, the Rikorose/DeepFilterNet repo publishes ONNX exports), so we don't need a model availability spike. We do need to verify it runs at acceptable latency in the browser via WASM SIMD.

### Task 0b.1: Verify DFN3 ONNX availability

**Files:**
- Modify: `docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md`

- [ ] **Step 1: Locate the DeepFilterNet 3 ONNX export**

The canonical source is the [Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) GitHub repository. Look for releases that include ONNX exports — typically under `models/DeepFilterNet3/`. License is MIT/Apache 2.0.

If the GitHub release doesn't include ONNX directly, check Hugging Face for a community export. As of late 2024 there are several mirrors.

- [ ] **Step 2: Download and verify**

```bash
cd /Users/thim/Repositories/slimcord-voice-isolation
mkdir -p scripts/spike/models
curl -L -o scripts/spike/models/dfn3-v1.onnx <URL_FROM_STEP_1>
shasum -a 256 scripts/spike/models/dfn3-v1.onnx
```

Document the URL, license, file size, and SHA-256 in the spike memo.

- [ ] **Step 3: Identify the DFN3 IO contract**

DFN3 typically exposes:
- Input: `input` or `noisy` — float32 PCM, shape `[1, frame_size]` or `[1, frame_size, 1]`
- Output: `output` or `enhanced` — float32 PCM, same shape
- Sample rate: 48 kHz (DFN3 is one of the few ONNX models that operates natively at 48 kHz, no resampling needed)
- Frame size: typically 480 samples (10ms at 48kHz)

Verify the actual tensor names by inspecting the ONNX graph (use the existing `scripts/spike/test-vfl-availability.mjs` as a template, adapted for DFN3).

- [ ] **Step 4: Append the DFN3 ModelIOSpec to the spike memo**

```ts
const DFN3_IO_SPEC: ModelIOSpec = {
  inputName: '<from step 3>',
  outputName: '<from step 3>',
  modelSampleRate: 48000,
  windowSamples: 480,    // 10ms at 48kHz
};
```

- [ ] **Step 5: Commit**

```bash
cd /Users/thim/Repositories/slimcord-voice-isolation
git add docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md scripts/spike/
git commit -m "spike(voice): DFN3 ONNX availability + IO contract verified"
```

### Task 0b.2: WASM SIMD latency benchmark for DFN3

**Files:**
- Create: `scripts/spike/bench-dfn3-wasm.html` (throwaway)
- Create: `scripts/spike/bench-dfn3-wasm.ts` (throwaway)

- [ ] **Step 1: Set up the test page**

Reuse the `scripts/spike/` infrastructure from spike 0a. Create an HTML page that sets COOP/COEP headers (you'll need a tiny Node server with custom headers — `npx http-server` doesn't set them by default, use `npx serve --cors` or write a 20-line `node http` server).

- [ ] **Step 2: Implement the benchmark loop**

In a Web Worker (real browser, not Node):

```typescript
import * as ort from 'onnxruntime-web';
ort.env.wasm.wasmPaths = '/ort-wasm/';

const session = await ort.InferenceSession.create('./dfn3-v1.onnx', {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
});

// Warmup
for (let i = 0; i < 10; i++) {
  await session.run({
    [INPUT_NAME]: new ort.Tensor('float32', new Float32Array(480), [1, 480]),
  });
}

const times: number[] = [];
for (let i = 0; i < 1000; i++) {
  const input = new Float32Array(480);
  for (let j = 0; j < 480; j++) input[j] = Math.random() * 2 - 1;
  const start = performance.now();
  await session.run({
    [INPUT_NAME]: new ort.Tensor('float32', input, [1, 480]),
  });
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
console.log({
  p50: times[500],
  p95: times[950],
  p99: times[990],
});
```

- [ ] **Step 3: Run on M1**

Open the page, trigger the benchmark, record p50/p95/p99.

**Pass criterion:** p95 < 8ms per frame on M1. (DFN3 frames are 10ms each, so we need processing to be safely under 10ms to keep up with real-time at 1× speed. 8ms gives us 20% headroom for the audio thread + ring buffer overhead.)

If it passes: ✅ proceed to milestone 1.
If it fails by a small margin: try `executionProviders: ['wasm']` with `wasmThreads: navigator.hardwareConcurrency`. The threaded WASM build can be 2-3x faster.
If it still fails: fall back to a smaller variant (`DeepFilterNet 2` or `DeepFilterNet ll`).

- [ ] **Step 4: Update the spike memo**

Document the benchmark results. Final go/no-go for Phase 1: ✅ if DFN3 passes, ❌ otherwise.

- [ ] **Step 5: Commit**

```bash
cd /Users/thim/Repositories/slimcord-voice-isolation
git add scripts/spike/bench-dfn3-wasm.* docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md
git commit -m "spike(voice): DFN3 WASM SIMD latency — <p95 result>"
```

---

## Milestone 1' — Foundation

Builds the cross-cutting infrastructure: model loader, server endpoints, COOP/COEP, LFS, ORT WASM assets. End state: a smoke test downloads DFN3 from the dev server, validates checksum, caches it in IndexedDB.

### Task 1.1: Set up Git LFS for model artifact

**Files:**
- Modify: `.gitattributes`
- Create: `server-rs/assets/voice-models/.gitkeep`

- [ ] **Step 1: Verify Git LFS is installed**

```bash
git lfs version
```

Expected: prints version. If not installed: `brew install git-lfs && git lfs install`.

- [ ] **Step 2: Configure LFS tracking**

Edit `.gitattributes`:

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

### Task 1.2: Drop DFN3 ONNX into the repo via LFS

**Files:**
- Create: `server-rs/assets/voice-models/dfn3-v1.onnx` (LFS)

- [ ] **Step 1: Copy from spike scripts directory**

```bash
cp scripts/spike/models/dfn3-v1.onnx server-rs/assets/voice-models/
```

- [ ] **Step 2: Verify LFS picks it up**

```bash
git add server-rs/assets/voice-models/dfn3-v1.onnx
git lfs ls-files | grep dfn3
```

Expected: shows `dfn3-v1.onnx` as LFS-tracked.

- [ ] **Step 3: Commit**

```bash
git commit -m "build(voice): commit DFN3 ONNX model via Git LFS"
```

### Task 1.3: Generate model manifest at build time

**Files:**
- Create: `server-rs/build.rs`
- Modify: `server-rs/Cargo.toml`

- [ ] **Step 1: Verify build.rs does not exist**

```bash
ls server-rs/build.rs 2>&1
```

Expected: "No such file".

- [ ] **Step 2: Add sha2 to build-dependencies**

Edit `server-rs/Cargo.toml`:

```toml
[build-dependencies]
sha2 = "0.10"
serde_json = "1"
```

- [ ] **Step 3: Create build.rs**

```rust
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use sha2::{Sha256, Digest};

fn main() {
    println!("cargo:rerun-if-changed=assets/voice-models");

    let models_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/voice-models");
    let dfn3_path = models_dir.join("dfn3-v1.onnx");

    if !dfn3_path.exists() {
        panic!("Missing model file: {}", dfn3_path.display());
    }

    let mut hasher = Sha256::new();
    let mut f = fs::File::open(&dfn3_path).unwrap();
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).unwrap();
    hasher.update(&buf);
    let hash = format!("{:x}", hasher.finalize());

    let manifest = serde_json::json!({
        "version": 1,
        "minClientVersion": 0,
        "dfn3": {
            "url": "/api/voice/models/dfn3-v1.onnx",
            "sha256": hash,
        }
    });

    let manifest_path = models_dir.join("manifest.json");
    fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap())
        .expect("write manifest.json");
}
```

- [ ] **Step 4: Build and verify**

```bash
cd server-rs && cargo build
cat server-rs/assets/voice-models/manifest.json
```

Expected: manifest contains a 64-char SHA-256.

- [ ] **Step 5: Add manifest.json to .gitignore**

```bash
echo "server-rs/assets/voice-models/manifest.json" >> .gitignore
```

- [ ] **Step 6: Commit**

```bash
git add server-rs/build.rs server-rs/Cargo.toml .gitignore
git commit -m "build(voice): generate model manifest at build time with SHA-256"
```

### Task 1.4: Add COOP/COEP headers to client routes

**Files:**
- Modify: `server-rs/src/main.rs` or `server-rs/src/webapp/mod.rs` (whichever holds the router)

- [ ] **Step 1: Locate the router setup**

```bash
grep -rn "Router::new\|nest_service\|ServeDir" server-rs/src/
```

Identify where the client routes are mounted. The plan from spike: it's likely in `server-rs/src/webapp/mod.rs` based on the `rust-embed` setup.

- [ ] **Step 2: Write the failing test**

Add to wherever the existing API tests live (probably `server-rs/src/api/tests.rs`):

```rust
#[tokio::test]
async fn client_routes_have_cross_origin_isolation_headers() {
    let app = build_test_app().await;
    let response = app
        .clone()
        .oneshot(Request::get("/app").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        response.headers().get("cross-origin-opener-policy").map(|v| v.to_str().unwrap()),
        Some("same-origin"),
    );
    assert_eq!(
        response.headers().get("cross-origin-embedder-policy").map(|v| v.to_str().unwrap()),
        Some("require-corp"),
    );
}
```

- [ ] **Step 3: Run, expect failure**

```bash
cd server-rs && cargo test client_routes_have_cross_origin
```

Expected: FAIL.

- [ ] **Step 4: Add the headers**

In the file that builds the client router (`webapp/mod.rs` likely), wrap the client subrouter:

```rust
use axum::http::HeaderValue;
use tower_http::set_header::SetResponseHeaderLayer;

let client_routes = Router::new()
    .nest_service("/", /* existing ServeDir */)
    .layer(SetResponseHeaderLayer::overriding(
        axum::http::header::HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    ))
    .layer(SetResponseHeaderLayer::overriding(
        axum::http::header::HeaderName::from_static("cross-origin-embedder-policy"),
        HeaderValue::from_static("require-corp"),
    ));
```

Critical: scope the layer to client routes only. API routes used by federation peers must not have COEP set, or it'll break cross-server traffic.

- [ ] **Step 5: Run, expect pass**

```bash
cargo test client_routes_have_cross_origin
```

- [ ] **Step 6: Manual verify**

```bash
cargo run
# In another terminal:
curl -I http://localhost:8888/app | grep -i cross-origin
```

Expected: both headers present. Then in the browser DevTools console: `crossOriginIsolated` should return `true`.

- [ ] **Step 7: Commit**

```bash
git add server-rs/src/webapp/mod.rs server-rs/src/api/tests.rs
git commit -m "feat(voice): set COOP/COEP headers on client routes for SAB support"
```

### Task 1.5: Add manifest + model serving endpoints

**Files:**
- Modify: `server-rs/src/api/voice.rs`
- Modify: `server-rs/src/api/mod.rs`

- [ ] **Step 1: Read the existing voice.rs to understand patterns**

```bash
cat server-rs/src/api/voice.rs
```

Note the existing handler patterns and imports.

- [ ] **Step 2: Write failing tests**

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
    assert_eq!(manifest["dfn3"]["sha256"].as_str().unwrap().len(), 64);
}

#[tokio::test]
async fn voice_models_serve_returns_onnx_bytes() {
    let app = build_test_app().await;
    let response = app
        .oneshot(Request::get("/api/voice/models/dfn3-v1.onnx").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "application/octet-stream",
    );
    assert_eq!(
        response.headers().get("cross-origin-resource-policy").unwrap(),
        "same-origin",
    );
    let body = body_to_bytes(response.into_body()).await;
    assert!(body.len() > 1000);
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

- [ ] **Step 3: Run, expect failure**

```bash
cd server-rs && cargo test voice_models
```

Expected: 3 FAIL.

- [ ] **Step 4: Add the rust-embed declaration**

At the top of `server-rs/src/api/voice.rs`:

```rust
use rust_embed::RustEmbed;
use axum::{
    extract::Path,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/assets/voice-models"]
struct VoiceModels;
```

- [ ] **Step 5: Implement handlers**

```rust
pub async fn models_manifest() -> Response {
    match VoiceModels::get("manifest.json") {
        Some(file) => {
            let mut headers = HeaderMap::new();
            headers.insert("content-type", "application/json".parse().unwrap());
            headers.insert("cache-control", "public, max-age=300".parse().unwrap());
            headers.insert("cross-origin-resource-policy", "same-origin".parse().unwrap());
            (StatusCode::OK, headers, file.data.into_owned()).into_response()
        }
        None => (StatusCode::NOT_FOUND, "manifest not built").into_response(),
    }
}

pub async fn models_serve(Path(filename): Path<String>) -> Response {
    // Whitelist only .onnx files to prevent path traversal
    if !filename.ends_with(".onnx") || filename.contains("..") || filename.contains('/') {
        return (StatusCode::NOT_FOUND, "").into_response();
    }
    match VoiceModels::get(&filename) {
        Some(file) => {
            let mut headers = HeaderMap::new();
            headers.insert("content-type", "application/octet-stream".parse().unwrap());
            headers.insert("cache-control", "public, max-age=31536000, immutable".parse().unwrap());
            // Required by COEP=require-corp on client routes
            headers.insert("cross-origin-resource-policy", "same-origin".parse().unwrap());
            (StatusCode::OK, headers, file.data.into_owned()).into_response()
        }
        None => (StatusCode::NOT_FOUND, "").into_response(),
    }
}
```

- [ ] **Step 6: Register routes**

In `server-rs/src/api/mod.rs`:

```rust
.route("/api/voice/models/manifest.json", get(voice::models_manifest))
.route("/api/voice/models/{filename}", get(voice::models_serve))
```

(axum 0.8+ uses `{filename}`; earlier versions use `:filename` — match the project's existing pattern.)

- [ ] **Step 7: Run tests, expect pass**

```bash
cargo test voice_models
```

- [ ] **Step 8: Commit**

```bash
git add server-rs/src/api/voice.rs server-rs/src/api/mod.rs server-rs/src/api/tests.rs
git commit -m "feat(voice): /api/voice/models manifest and serve endpoints"
```

### Task 1.6: Install onnxruntime-web

**Files:**
- Modify: `client/package.json`

- [ ] **Step 1: Check the latest stable version**

```bash
cd client && npm view onnxruntime-web version
```

The user prefers "latest major with at least one patch release" — pick the version with the highest major where there's at least one `.x.y` patch released. Document the version chosen.

- [ ] **Step 2: Install**

```bash
npm install onnxruntime-web@<version>
```

- [ ] **Step 3: Verify**

```bash
ls node_modules/onnxruntime-web/dist/*.wasm
```

Expected: 4-6 .wasm files.

- [ ] **Step 4: Verify build still passes**

```bash
npm run lint && npx tsc --noEmit && npm test -- --run
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add client/package.json client/package-lock.json
git commit -m "chore(voice): add onnxruntime-web dependency"
```

### Task 1.7: Configure ORT WASM asset paths

**Files:**
- Create: `client/scripts/copy-ort-wasm.js`
- Modify: `client/package.json` (postinstall script)
- Modify: `.gitignore`

- [ ] **Step 1: Write the copy script**

```javascript
// client/scripts/copy-ort-wasm.js
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist');
const dst = path.join(__dirname, '..', 'public', 'ort-wasm');

fs.mkdirSync(dst, { recursive: true });
let count = 0;
for (const file of fs.readdirSync(src)) {
  if (file.endsWith('.wasm') || file.endsWith('.mjs')) {
    fs.copyFileSync(path.join(src, file), path.join(dst, file));
    count++;
  }
}
console.log(`copied ${count} ORT runtime files to public/ort-wasm/`);
```

- [ ] **Step 2: Add postinstall script**

In `client/package.json`:

```json
"scripts": {
  ...
  "postinstall": "node scripts/copy-ort-wasm.js"
}
```

- [ ] **Step 3: Run it**

```bash
cd client && npm run postinstall
ls public/ort-wasm/
```

Expected: lists copied files.

- [ ] **Step 4: Gitignore the copy destination**

Edit `.gitignore` (root):

```
client/public/ort-wasm/
```

- [ ] **Step 5: Commit**

```bash
git add client/scripts/copy-ort-wasm.js client/package.json .gitignore
git commit -m "build(voice): copy ORT Web WASM assets to public/ via postinstall"
```

### Task 1.8: voiceIsolation module skeleton + types

**Files:**
- Create: `client/src/services/voiceIsolation/index.ts`
- Create: `client/src/services/voiceIsolation/types.ts`

- [ ] **Step 1: Write types**

```typescript
// client/src/services/voiceIsolation/types.ts

export type ModelKind = 'dfn3' | 'passthrough';

export interface ModelHandle {
  kind: 'dfn3';
  version: number;
  sessionId: string; // populated after worker load-model round-trip
}

export interface ModelIOSpec {
  inputName: string;
  outputName: string;
  modelSampleRate: number;  // typically 48000 for DFN3
  windowSamples: number;    // typically 480 for DFN3 (10ms at 48kHz)
}

export interface PerStreamStats {
  framesProcessed: number;
  framesDropped: number;
  medianFrameMs: number;
}

export interface CallState {
  enabled: boolean;
  modelLoaded: boolean;
  outgoingStream: PerStreamStats | null;
  incomingStreams: Map<string, PerStreamStats>;
  cpuDegradeActive: boolean;
}
```

- [ ] **Step 2: Write index.ts**

```typescript
// client/src/services/voiceIsolation/index.ts
export type {
  ModelKind,
  ModelHandle,
  ModelIOSpec,
  PerStreamStats,
  CallState,
} from './types';
```

- [ ] **Step 3: Type-check**

```bash
cd client && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add client/src/services/voiceIsolation/
git commit -m "feat(voice): scaffold voiceIsolation module with types"
```

### Task 1.9: modelLoader (TDD)

**Files:**
- Create: `client/src/services/voiceIsolation/modelLoader.ts`
- Create: `client/src/services/voiceIsolation/modelLoader.test.ts`

- [ ] **Step 1: Write tests for fetchManifest**

```typescript
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchManifest, validateChecksum, loadDfn3Bytes, ManifestError } from './modelLoader';

beforeEach(() => {
  vi.restoreAllMocks();
  indexedDB.deleteDatabase('dilla-voice-models');
});

describe('fetchManifest', () => {
  it('parses a valid manifest', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        version: 1,
        minClientVersion: 0,
        dfn3: { url: '/api/voice/models/dfn3-v1.onnx', sha256: 'a'.repeat(64) },
      }),
    } as Response);
    const m = await fetchManifest('http://localhost:8888');
    expect(m.dfn3.sha256).toBe('a'.repeat(64));
  });

  it('throws on 404', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    await expect(fetchManifest('http://localhost:8888')).rejects.toThrow(ManifestError);
  });

  it('throws on incompatible client version', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        version: 99,
        minClientVersion: 99,
        dfn3: { url: 'x', sha256: 'a'.repeat(64) },
      }),
    } as Response);
    await expect(fetchManifest('http://localhost:8888')).rejects.toThrow(/incompatible/i);
  });
});

describe('validateChecksum', () => {
  it('passes for matching sha256', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';
    await expect(validateChecksum(bytes, hash)).resolves.toBeUndefined();
  });

  it('throws on mismatch', async () => {
    await expect(validateChecksum(new Uint8Array([1]), 'a'.repeat(64))).rejects.toThrow(/checksum/i);
  });
});

describe('loadDfn3Bytes', () => {
  it('fetches, validates, caches, and returns bytes', async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('manifest.json')) {
        return new Response(JSON.stringify({
          version: 1,
          minClientVersion: 0,
          dfn3: { url: '/api/voice/models/dfn3-v1.onnx', sha256: hash },
        }));
      }
      if (url.endsWith('dfn3-v1.onnx')) return new Response(bytes);
      throw new Error(`unexpected: ${url}`);
    });

    const result = await loadDfn3Bytes('http://localhost:8888');
    expect(result.bytes).toEqual(bytes);
    expect(result.version).toBe(1);
  });

  it('serves from IndexedDB cache on second call', async () => {
    const bytes = new Uint8Array([99]);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');

    let fetchCount = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      fetchCount++;
      if (url.endsWith('manifest.json')) {
        return new Response(JSON.stringify({
          version: 1,
          minClientVersion: 0,
          dfn3: { url: '/api/voice/models/dfn3-v1.onnx', sha256: hash },
        }));
      }
      if (url.endsWith('dfn3-v1.onnx')) return new Response(bytes);
      throw new Error('unexpected');
    });

    await loadDfn3Bytes('http://localhost:8888');
    const fetchAfterFirst = fetchCount;
    await loadDfn3Bytes('http://localhost:8888');
    // Second call: only the manifest is re-fetched (for version check), not the model bytes
    expect(fetchCount).toBe(fetchAfterFirst + 1);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd client && npm test -- --run modelLoader
```

- [ ] **Step 3: Implement modelLoader**

```typescript
// client/src/services/voiceIsolation/modelLoader.ts

const SUPPORTED_MANIFEST_VERSION = 1;
const DB_NAME = 'dilla-voice-models';
const STORE_NAME = 'models';

export class ManifestError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ManifestError';
  }
}

export interface Manifest {
  version: number;
  minClientVersion: number;
  dfn3: { url: string; sha256: string };
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
  const dfn3 = m.dfn3 as Record<string, unknown> | undefined;
  if (!dfn3 || typeof dfn3.url !== 'string' || typeof dfn3.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dfn3.sha256)) {
    throw new ManifestError('Manifest entry "dfn3" missing or invalid');
  }
  return m as unknown as Manifest;
}

export async function validateChecksum(bytes: Uint8Array, expectedHex: string): Promise<void> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (actual !== expectedHex) {
    throw new ManifestError(`Checksum mismatch (expected ${expectedHex.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
  }
}

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

const cacheKey = (version: number) => `dfn3-v${version}`;

async function getCachedModel(version: number): Promise<Uint8Array | null> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(cacheKey(version));
    req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function cacheModel(version: number, bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(bytes, cacheKey(version));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export interface LoadedModel {
  bytes: Uint8Array;
  version: number;
}

export async function loadDfn3Bytes(serverUrl: string): Promise<LoadedModel> {
  const manifest = await fetchManifest(serverUrl);
  const cached = await getCachedModel(manifest.version);
  if (cached) {
    try {
      await validateChecksum(cached, manifest.dfn3.sha256);
      return { bytes: cached, version: manifest.version };
    } catch {
      // Cache mismatch — refetch
    }
  }
  const response = await fetch(`${serverUrl}${manifest.dfn3.url}`);
  if (!response.ok) {
    throw new ManifestError(`Failed to fetch dfn3 (HTTP ${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await validateChecksum(bytes, manifest.dfn3.sha256);
  await cacheModel(manifest.version, bytes);
  return { bytes, version: manifest.version };
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npm test -- --run modelLoader
```

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/modelLoader.ts client/src/services/voiceIsolation/modelLoader.test.ts
git commit -m "feat(voice): modelLoader with manifest fetch, checksum, IndexedDB cache"
```

### Task 1.10: SFrame integration verification (GATING CHECKPOINT)

This task is critical and unchanged from the original plan. The DFN3 pivot doesn't affect the seam location.

**Files:**
- Read-only: `client/src/services/webrtc/WebRTCService.ts`
- Read-only: `client/src/services/webrtc/voiceEncryption.ts`
- Read-only: `client/src/types/webrtc-encoded-transform.d.ts`

- [ ] **Step 1: Read all three files end-to-end**

```bash
cat client/src/services/webrtc/voiceEncryption.ts
cat client/src/types/webrtc-encoded-transform.d.ts
sed -n '90,160p' client/src/services/webrtc/WebRTCService.ts
```

- [ ] **Step 2: Identify the SFrame layer**

Two outcomes:

**Outcome A** — SFrame uses RTCRtpScriptTransform / encoded-frame transforms (most likely given the type definitions exist):
- Voice isolation pipeline still wraps `MediaStreamTrack` *before* `addTrack`
- Trace: `getUserMedia → MediaStreamTrack → voiceIsolation.processOutgoing → addTrack → encoder → SFrame transform → SFU`
- For incoming: `SFU → SFrame decrypt transform → decoder → MediaStreamTrack → voiceIsolation.processIncoming → output`
- ✅ Plan can proceed.

**Outcome B** — SFrame is at the `MediaStreamTrack` layer:
- ⛔ STOP. Re-spec required.

- [ ] **Step 3: Document findings in spike memo**

Add a section to `docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md`.

- [ ] **Step 4: HARD GATE**

If Outcome B: open an issue, escalate to user, halt this plan.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md
git commit -m "docs(voice): SFrame integration verification (outcome <A|B>)"
```

---

## Milestone 2' — Pipeline + Worker + ring buffer

End state: a unit test pipes a known WAV file through the worklet → SAB → worker → SAB → worklet pipeline and gets cleaned audio at acceptable latency.

### Task 2.1: SAB ring buffer protocol

**Files:**
- Create: `client/src/services/voiceIsolation/audioWorklet/ringProtocol.ts`
- Create: `client/src/services/voiceIsolation/audioWorklet/ringProtocol.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect } from 'vitest';
import { createRing, writeFrame, readFrame } from './ringProtocol';

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
    expect(readFrame(ring, 128)).toBeNull();
  });

  it('handles wrap-around', () => {
    const ring = createRing(256);
    for (let i = 0; i < 5; i++) {
      writeFrame(ring, new Float32Array(64).fill(i));
      const out = readFrame(ring, 64);
      expect(out![0]).toBe(i);
    }
  });

  it('throws on overflow', () => {
    const ring = createRing(128);
    expect(() => writeFrame(ring, new Float32Array(256))).toThrow(/overflow/i);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd client && npm test -- --run ringProtocol
```

- [ ] **Step 3: Implement**

```typescript
// client/src/services/voiceIsolation/audioWorklet/ringProtocol.ts

export interface RingBuffer {
  sab: SharedArrayBuffer;
  intView: Int32Array;
  floatView: Float32Array;
  capacity: number;
}

const HEADER_INTS = 2; // [writeIdx, readIdx]
const HEADER_BYTES = HEADER_INTS * 4;

export function createRing(capacitySamples: number): RingBuffer {
  if (typeof SharedArrayBuffer === 'undefined') {
    throw new Error('SharedArrayBuffer not available — check COOP/COEP headers');
  }
  const sab = new SharedArrayBuffer(HEADER_BYTES + capacitySamples * 4);
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
  const used = (writeIdx - readIdx + ring.capacity) % ring.capacity;
  const available = ring.capacity - used - 1; // -1 to distinguish full from empty
  if (frame.length > available) {
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

```bash
npm test -- --run ringProtocol
```

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/audioWorklet/
git commit -m "feat(voice): SAB ring buffer protocol"
```

### Task 2.2: AudioWorklet processor

**Files:**
- Create: `client/src/services/voiceIsolation/audioWorklet/ringBufferProcessor.js`

- [ ] **Step 1: Write the processor**

```javascript
// client/src/services/voiceIsolation/audioWorklet/ringBufferProcessor.js
// AudioWorkletProcessor — buffer pump between audio thread and inference Worker.

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

    // Write 128-sample render quantum to input ring (if input has data)
    if (input && input[0]) {
      const frame = input[0];
      const writeIdx = Atomics.load(this.inputInts, 0);
      const readIdx = Atomics.load(this.inputInts, 1);
      const used = (writeIdx - readIdx + this.inputCapacity) % this.inputCapacity;
      const free = this.inputCapacity - used - 1;
      if (frame.length <= free) {
        for (let i = 0; i < frame.length; i++) {
          this.inputFloats[(writeIdx + i) % this.inputCapacity] = frame[i];
        }
        Atomics.store(this.inputInts, 0, (writeIdx + frame.length) % this.inputCapacity);
        Atomics.notify(this.inputInts, 0);
      }
      // Else: overflow, drop frame (counted by main thread later)
    }

    // Read 128 samples from output ring
    if (output && output[0]) {
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
        // Underrun: emit silence
        for (let i = 0; i < oFrame.length; i++) oFrame[i] = 0;
      }
    }

    return true;
  }
}

registerProcessor('voice-iso-ring-pump', RingBufferProcessor);
```

- [ ] **Step 2: Commit**

```bash
git add client/src/services/voiceIsolation/audioWorklet/ringBufferProcessor.js
git commit -m "feat(voice): AudioWorkletProcessor for SAB ring buffer pumping"
```

### Task 2.3: Inference Worker

**Files:**
- Create: `client/src/services/voiceIsolation/inferenceWorker.ts`

- [ ] **Step 1: Write the worker**

```typescript
// client/src/services/voiceIsolation/inferenceWorker.ts
/// <reference lib="webworker" />

import * as ort from 'onnxruntime-web';
import type { ModelIOSpec } from './types';

ort.env.wasm.wasmPaths = '/ort-wasm/';
ort.env.wasm.simd = true;

interface LoadModelMsg {
  type: 'load-model';
  modelBytes: Uint8Array;
  ioSpec: ModelIOSpec;
  sessionId: string;
}

interface AttachStreamMsg {
  type: 'attach-stream';
  streamId: string;
  sessionId: string;
  inputSab: SharedArrayBuffer;
  outputSab: SharedArrayBuffer;
  inputCapacity: number;
  outputCapacity: number;
}

interface DetachStreamMsg {
  type: 'detach-stream';
  streamId: string;
}

type InMsg = LoadModelMsg | AttachStreamMsg | DetachStreamMsg;

interface SessionEntry {
  session: ort.InferenceSession;
  ioSpec: ModelIOSpec;
}

const sessions = new Map<string, SessionEntry>();
const streams = new Map<string, {
  sessionId: string;
  inputSab: SharedArrayBuffer;
  outputSab: SharedArrayBuffer;
  active: boolean;
}>();

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;

  if (msg.type === 'load-model') {
    try {
      const session = await ort.InferenceSession.create(msg.modelBytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      sessions.set(msg.sessionId, { session, ioSpec: msg.ioSpec });
      (self as unknown as Worker).postMessage({ type: 'model-loaded', sessionId: msg.sessionId });
    } catch (err) {
      (self as unknown as Worker).postMessage({
        type: 'model-error',
        sessionId: msg.sessionId,
        error: String(err),
      });
    }
    return;
  }

  if (msg.type === 'attach-stream') {
    streams.set(msg.streamId, {
      sessionId: msg.sessionId,
      inputSab: msg.inputSab,
      outputSab: msg.outputSab,
      active: true,
    });
    startStreamLoop(msg.streamId, msg.inputCapacity, msg.outputCapacity);
    return;
  }

  if (msg.type === 'detach-stream') {
    const s = streams.get(msg.streamId);
    if (s) s.active = false;
    streams.delete(msg.streamId);
    return;
  }
};

const HEADER_INTS = 2;

function startStreamLoop(streamId: string, inputCapacity: number, outputCapacity: number) {
  const stream = streams.get(streamId);
  if (!stream) return;

  const inputInts = new Int32Array(stream.inputSab, 0, HEADER_INTS);
  const inputFloats = new Float32Array(stream.inputSab, HEADER_INTS * 4, inputCapacity);
  const outputInts = new Int32Array(stream.outputSab, 0, HEADER_INTS);
  const outputFloats = new Float32Array(stream.outputSab, HEADER_INTS * 4, outputCapacity);

  const tick = async () => {
    const current = streams.get(streamId);
    if (!current || !current.active) return;

    const sessionEntry = sessions.get(current.sessionId);
    if (!sessionEntry) {
      setTimeout(tick, 1);
      return;
    }
    const { session, ioSpec } = sessionEntry;
    const windowSamples = ioSpec.windowSamples;

    const writeIdx = Atomics.load(inputInts, 0);
    const readIdx = Atomics.load(inputInts, 1);
    const avail = (writeIdx - readIdx + inputCapacity) % inputCapacity;

    if (avail >= windowSamples) {
      // Read frame
      const frame = new Float32Array(windowSamples);
      for (let i = 0; i < windowSamples; i++) {
        frame[i] = inputFloats[(readIdx + i) % inputCapacity];
      }
      Atomics.store(inputInts, 1, (readIdx + windowSamples) % inputCapacity);

      try {
        // DFN3 operates natively at 48kHz — no resampling needed
        const feeds: Record<string, ort.Tensor> = {
          [ioSpec.inputName]: new ort.Tensor('float32', frame, [1, windowSamples]),
        };
        const result = await session.run(feeds);
        const output = result[ioSpec.outputName].data as Float32Array;

        // Write to output ring
        const oWrite = Atomics.load(outputInts, 0);
        const oRead = Atomics.load(outputInts, 1);
        const used = (oWrite - oRead + outputCapacity) % outputCapacity;
        const free = outputCapacity - used - 1;
        if (output.length <= free) {
          for (let i = 0; i < output.length; i++) {
            outputFloats[(oWrite + i) % outputCapacity] = output[i];
          }
          Atomics.store(outputInts, 0, (oWrite + output.length) % outputCapacity);
        }
      } catch (err) {
        console.error('[inferenceWorker] inference failed', err);
      }
    }

    setTimeout(tick, 0);
  };

  tick();
}
```

- [ ] **Step 2: Type-check**

```bash
cd client && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add client/src/services/voiceIsolation/inferenceWorker.ts
git commit -m "feat(voice): inferenceWorker — DFN3 inference loop on SAB rings"
```

### Task 2.4: pipeline.ts public API

**Files:**
- Create: `client/src/services/voiceIsolation/pipeline.ts`
- Create: `client/src/services/voiceIsolation/pipeline.test.ts`

- [ ] **Step 1: Write a smoke test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createPipeline } from './pipeline';

describe('pipeline.createPipeline', () => {
  it('constructs without throwing', () => {
    const fakeWorker = { postMessage: vi.fn() } as unknown as Worker;
    const fakeAudioContext = {} as AudioContext;
    const fakeTrack = {} as MediaStreamTrack;
    // Construction is mostly side-effects to a real AudioContext, which jsdom doesn't have.
    // Real test is in pipeline.browser.test.ts.
    // This unit test only checks the type signature compiles and basic argument validation.
    expect(typeof createPipeline).toBe('function');
  });
});
```

- [ ] **Step 2: Implement pipeline**

```typescript
// client/src/services/voiceIsolation/pipeline.ts

import { createRing } from './audioWorklet/ringProtocol';

const INPUT_RING_CAPACITY = 16384;
const OUTPUT_RING_CAPACITY = 16384;

export interface PipelineConfig {
  audioContext: AudioContext;
  worker: Worker;
  track: MediaStreamTrack;
  sessionId: string;
}

export interface Pipeline {
  outputTrack: MediaStreamTrack;
  destroy(): void;
}

let nextStreamId = 0;

export function createPipeline(config: PipelineConfig): Pipeline {
  const streamId = `stream-${nextStreamId++}`;
  const inputRing = createRing(INPUT_RING_CAPACITY);
  const outputRing = createRing(OUTPUT_RING_CAPACITY);

  config.worker.postMessage({
    type: 'attach-stream',
    streamId,
    sessionId: config.sessionId,
    inputSab: inputRing.sab,
    outputSab: outputRing.sab,
    inputCapacity: INPUT_RING_CAPACITY,
    outputCapacity: OUTPUT_RING_CAPACITY,
  });

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
    destroy() {
      config.worker.postMessage({ type: 'detach-stream', streamId });
      workletNode.disconnect();
      source.disconnect();
    },
  };
}
```

- [ ] **Step 3: Run tests**

```bash
npm test -- --run pipeline
```

- [ ] **Step 4: Commit**

```bash
git add client/src/services/voiceIsolation/pipeline.ts client/src/services/voiceIsolation/pipeline.test.ts
git commit -m "feat(voice): pipeline.createPipeline — worklet+worker+ring assembly"
```

### Task 2.5: Browser-mode end-to-end pipeline test

**Files:**
- Create: `client/src/services/voiceIsolation/pipeline.browser.test.ts`

- [ ] **Step 1: Write the browser test**

```typescript
import { describe, it, expect } from 'vitest';
import { createPipeline } from './pipeline';
import { loadDfn3Bytes } from './modelLoader';
import type { ModelIOSpec } from './types';

const DFN3_IO_SPEC: ModelIOSpec = {
  // From spike memo — replace with actual values:
  inputName: 'input',
  outputName: 'output',
  modelSampleRate: 48000,
  windowSamples: 480,
};

describe('pipeline (browser)', () => {
  it('processes synthetic audio through worklet → SAB → worker → DFN3', async () => {
    expect(crossOriginIsolated).toBe(true);

    const audioContext = new AudioContext({ sampleRate: 48000 });
    await audioContext.audioWorklet.addModule(
      new URL('./audioWorklet/ringBufferProcessor.js', import.meta.url).href,
    );

    const worker = new Worker(
      new URL('./inferenceWorker.ts', import.meta.url),
      { type: 'module' },
    );

    const { bytes } = await loadDfn3Bytes('http://localhost:8888');

    const sessionId = 'test-session';
    worker.postMessage({
      type: 'load-model',
      modelBytes: bytes,
      ioSpec: DFN3_IO_SPEC,
      sessionId,
    });

    await new Promise<void>((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        if (e.data?.type === 'model-loaded') {
          worker.removeEventListener('message', handler);
          resolve();
        } else if (e.data?.type === 'model-error') {
          worker.removeEventListener('message', handler);
          reject(new Error(e.data.error));
        }
      };
      worker.addEventListener('message', handler);
    });

    // Synthetic input
    const oscillator = audioContext.createOscillator();
    oscillator.frequency.value = 440;
    const dest = audioContext.createMediaStreamDestination();
    oscillator.connect(dest);
    oscillator.start();

    const pipeline = createPipeline({
      audioContext,
      worker,
      track: dest.stream.getAudioTracks()[0],
      sessionId,
    });

    expect(pipeline.outputTrack).toBeDefined();

    // Wait for inference to start producing output
    await new Promise((r) => setTimeout(r, 500));

    pipeline.destroy();
    oscillator.stop();
    worker.terminate();
    await audioContext.close();
  }, 30_000);
});
```

- [ ] **Step 2: Run the dev server**

```bash
cd server-rs && cargo run
```

- [ ] **Step 3: Run the browser test**

```bash
cd client && npm run test:browser -- --run pipeline.browser
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/services/voiceIsolation/pipeline.browser.test.ts
git commit -m "test(voice): browser-mode end-to-end pipeline test"
```

---

## Milestone 3' — Dispatcher + WebRTCService integration

End state: when joining a voice channel, your mic + every peer's audio is processed through DFN3.

### Task 3.1: dispatcher.ts

**Files:**
- Create: `client/src/services/voiceIsolation/dispatcher.ts`
- Create: `client/src/services/voiceIsolation/dispatcher.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initializeVoiceIsolation, processOutgoing, processIncoming, getContext, resetForTest } from './dispatcher';

beforeEach(() => {
  resetForTest();
});

describe('dispatcher', () => {
  it('returns null context before init', () => {
    expect(getContext()).toBeNull();
  });

  it('processOutgoing passes through when context is null', () => {
    const fakeTrack = {} as MediaStreamTrack;
    const result = processOutgoing(null, fakeTrack);
    expect(result).toBe(fakeTrack);
  });

  it('processIncoming passes through when context is null', () => {
    const fakeTrack = {} as MediaStreamTrack;
    const result = processIncoming(null, fakeTrack, 'peer-1');
    expect(result).toBe(fakeTrack);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
npm test -- --run dispatcher
```

- [ ] **Step 3: Implement dispatcher**

```typescript
// client/src/services/voiceIsolation/dispatcher.ts

import { loadDfn3Bytes, ManifestError } from './modelLoader';
import { createPipeline, type Pipeline } from './pipeline';
import type { ModelIOSpec } from './types';

// DFN3 IO spec — from spike memo. Replace with actual values when known.
const DFN3_IO_SPEC: ModelIOSpec = {
  inputName: 'input',
  outputName: 'output',
  modelSampleRate: 48000,
  windowSamples: 480,
};

interface InitializedContext {
  audioContext: AudioContext;
  worker: Worker;
  sessionId: string;
}

let context: InitializedContext | null = null;
let outgoingPipeline: Pipeline | null = null;
const incomingPipelines = new Map<string, Pipeline>();

export async function initializeVoiceIsolation(serverUrl: string): Promise<InitializedContext | null> {
  if (context) return context;
  try {
    const { bytes } = await loadDfn3Bytes(serverUrl);

    const audioContext = new AudioContext({ sampleRate: 48000 });
    await audioContext.audioWorklet.addModule(
      new URL('./audioWorklet/ringBufferProcessor.js', import.meta.url).href,
    );

    const worker = new Worker(
      new URL('./inferenceWorker.ts', import.meta.url),
      { type: 'module' },
    );

    const sessionId = `dfn3-${crypto.randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
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
        modelBytes: bytes,
        ioSpec: DFN3_IO_SPEC,
        sessionId,
      });
    });

    context = { audioContext, worker, sessionId };
    return context;
  } catch (err) {
    console.error('[voiceIsolation] init failed', err);
    return null;
  }
}

export function getContext(): InitializedContext | null {
  return context;
}

export function processOutgoing(
  ctx: InitializedContext | null,
  track: MediaStreamTrack,
): MediaStreamTrack {
  if (!ctx) return track; // pass-through

  outgoingPipeline?.destroy();
  outgoingPipeline = createPipeline({
    audioContext: ctx.audioContext,
    worker: ctx.worker,
    track,
    sessionId: ctx.sessionId,
  });
  return outgoingPipeline.outputTrack;
}

export function processIncoming(
  ctx: InitializedContext | null,
  track: MediaStreamTrack,
  peerId: string,
): MediaStreamTrack {
  if (!ctx) return track;

  incomingPipelines.get(peerId)?.destroy();
  const pipeline = createPipeline({
    audioContext: ctx.audioContext,
    worker: ctx.worker,
    track,
    sessionId: ctx.sessionId,
  });
  incomingPipelines.set(peerId, pipeline);
  return pipeline.outputTrack;
}

export function tearDownPeer(peerId: string): void {
  incomingPipelines.get(peerId)?.destroy();
  incomingPipelines.delete(peerId);
}

export function tearDownOutgoing(): void {
  outgoingPipeline?.destroy();
  outgoingPipeline = null;
}

export function tearDownAll(): void {
  tearDownOutgoing();
  for (const peerId of incomingPipelines.keys()) {
    tearDownPeer(peerId);
  }
  if (context) {
    context.worker.terminate();
    context.audioContext.close();
    context = null;
  }
}

// Test-only helpers
export function resetForTest(): void {
  outgoingPipeline = null;
  incomingPipelines.clear();
  context = null;
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npm test -- --run dispatcher
```

- [ ] **Step 5: Commit**

```bash
git add client/src/services/voiceIsolation/dispatcher.ts client/src/services/voiceIsolation/dispatcher.test.ts
git commit -m "feat(voice): dispatcher with init + processOutgoing/processIncoming"
```

### Task 3.2: Wire dispatcher into WebRTCService

**Files:**
- Modify: `client/src/services/webrtc/WebRTCService.ts`
- Modify: `client/src/services/noiseSuppression.ts` (delete the no-op stub)

- [ ] **Step 1: Read WebRTCService.ts to find the seam**

```bash
sed -n '1,50p' client/src/services/webrtc/WebRTCService.ts
sed -n '95,140p' client/src/services/webrtc/WebRTCService.ts
```

Identify:
- Where the class is constructed
- Where `addTrack` is called for the local track (~line 109)
- Where `pc.ontrack` is set (~line 131)
- Where `VoiceEncryptionManager` is instantiated

- [ ] **Step 2: Add field + init**

In the constructor:

```typescript
import {
  initializeVoiceIsolation,
  processOutgoing as voiceIsoProcessOutgoing,
  processIncoming as voiceIsoProcessIncoming,
  tearDownPeer as voiceIsoTearDownPeer,
  tearDownAll as voiceIsoTearDownAll,
  getContext as voiceIsoGetContext,
} from '../voiceIsolation/dispatcher';
import { useAudioSettingsStore } from '../../stores/audioSettingsStore';

// In constructor:
this.voiceIsolationContext = null;
// Lazy init — happens on first voice channel join
```

- [ ] **Step 3: Wrap addTrack**

Find `this.pc.addTrack(track, this.localStream)` (around line 109). Wrap it:

```typescript
// Lazy init voice isolation on first track add
if (this.audioSettings.noiseSuppression && !this.voiceIsolationContext) {
  this.voiceIsolationContext = await initializeVoiceIsolation(this.serverUrl);
}

const processedTrack = this.audioSettings.noiseSuppression && this.voiceIsolationContext
  ? voiceIsoProcessOutgoing(this.voiceIsolationContext, track)
  : track;

this.pc.addTrack(processedTrack, this.localStream);
```

- [ ] **Step 4: Wrap ontrack**

```typescript
this.pc.ontrack = (event) => {
  // ... existing SFrame decryption setup happens upstream
  const decryptedTrack = event.track;
  const peerId = this.getPeerIdFromTransceiver(event.transceiver);

  const processedTrack = this.audioSettings.noiseSuppression && this.voiceIsolationContext
    ? voiceIsoProcessIncoming(this.voiceIsolationContext, decryptedTrack, peerId)
    : decryptedTrack;

  this.attachToAudioElement(processedTrack);
};
```

- [ ] **Step 5: Tear down on disconnect**

In whatever method closes the peer connection:

```typescript
voiceIsoTearDownAll();
this.voiceIsolationContext = null;
```

- [ ] **Step 6: Delete the noiseSuppression.ts stub**

```bash
git rm client/src/services/noiseSuppression.ts
```

If anything imports from it, replace those imports with the new dispatcher API or remove them.

- [ ] **Step 7: Verify tests still pass**

```bash
cd client && npm run lint && npx tsc --noEmit && npm test -- --run
```

Expected: clean. The existing WebRTCService tests should still pass because the new pipeline is gated by the audio settings flag.

- [ ] **Step 8: Commit**

```bash
git add client/src/services/webrtc/WebRTCService.ts
git rm client/src/services/noiseSuppression.ts
git commit -m "feat(voice): wire DFN3 noise suppression into WebRTCService"
```

---

## Milestone 4' — UX

End state: user can toggle noise suppression in Settings, see status in VoiceControls badge, and view local diagnostics.

### Task 4.1: Settings toggle wiring

**Files:**
- Modify: `client/src/pages/UserSettings.tsx`
- Modify: `client/src/i18n/locales/en.json`

- [ ] **Step 1: Read existing audio settings section**

```bash
grep -n "noiseSuppression\|audio" client/src/pages/UserSettings.tsx | head
```

The `noiseSuppression: boolean` setting already exists in `audioSettingsStore.ts`. Verify the Settings UI already exposes a toggle for it. If yes: nothing more to do here. If no: add a checkbox bound to `useAudioSettingsStore`.

- [ ] **Step 2: Add a help text describing what it does**

```tsx
<section className="settings-section">
  <h3>{t('noiseSuppression.heading', 'Noise Suppression')}</h3>
  <p>{t('noiseSuppression.help', 'Removes background noise from your voice and from peers in voice channels.')}</p>
  <label>
    <input
      type="checkbox"
      checked={noiseSuppression}
      onChange={(e) => setNoiseSuppression(e.target.checked)}
    />
    {t('noiseSuppression.toggle', 'Enabled')}
  </label>
</section>
```

- [ ] **Step 3: i18n strings**

```json
"noiseSuppression": {
  "heading": "Noise Suppression",
  "help": "Removes background noise from your voice and from peers in voice channels.",
  "toggle": "Enabled"
}
```

- [ ] **Step 4: Verify**

```bash
cd client && npm run lint && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/UserSettings.tsx client/src/i18n/locales/en.json
git commit -m "feat(voice): Settings toggle for noise suppression"
```

### Task 4.2: Diagnostics counters

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
    for (let i = 0; i < 100; i++) diagnostics.recordFrameMs(i);
    const stats = diagnostics.getSnapshot();
    expect(stats.medianFrameMs).toBeCloseTo(50, 0);
    expect(stats.p95FrameMs).toBeGreaterThan(90);
  });

  it('counts dropped frames', () => {
    diagnostics.recordFrameDropped();
    diagnostics.recordFrameDropped();
    expect(diagnostics.getSnapshot().framesDropped).toBe(2);
  });

  it('keeps a bounded ring of last 10 errors', () => {
    for (let i = 0; i < 15; i++) {
      diagnostics.recordError({ code: 'ERR', message: `error ${i}` });
    }
    const stats = diagnostics.getSnapshot();
    expect(stats.lastTenErrors).toHaveLength(10);
    expect(stats.lastTenErrors[0].message).toBe('error 5');
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// client/src/services/voiceIsolation/diagnostics.ts

interface Snapshot {
  medianFrameMs: number;
  p95FrameMs: number;
  framesProcessed: number;
  framesDropped: number;
  cpuDegradeTriggerCount: number;
  lastTenErrors: Array<{ timestamp: string; code: string; message: string }>;
}

class Diagnostics {
  private frameTimes: number[] = [];
  private framesProcessed = 0;
  private framesDropped = 0;
  private cpuDegradeCount = 0;
  private errors: Array<{ timestamp: string; code: string; message: string }> = [];

  recordFrameMs(ms: number) {
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 5000) this.frameTimes.shift();
    this.framesProcessed++;
  }
  recordFrameDropped() { this.framesDropped++; }
  recordCpuDegrade() { this.cpuDegradeCount++; }
  recordError(err: { code: string; message: string }) {
    this.errors.push({ ...err, timestamp: new Date().toISOString() });
    if (this.errors.length > 10) this.errors.shift();
  }
  reset() {
    this.frameTimes = [];
    this.framesProcessed = 0;
    this.framesDropped = 0;
    this.cpuDegradeCount = 0;
    this.errors = [];
  }
  getSnapshot(): Snapshot {
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const median = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length * 0.95)];
    return {
      medianFrameMs: median,
      p95FrameMs: p95,
      framesProcessed: this.framesProcessed,
      framesDropped: this.framesDropped,
      cpuDegradeTriggerCount: this.cpuDegradeCount,
      lastTenErrors: [...this.errors],
    };
  }
}

export const diagnostics = new Diagnostics();
```

- [ ] **Step 3: Run tests**

```bash
npm test -- --run diagnostics
```

- [ ] **Step 4: Commit**

```bash
git add client/src/services/voiceIsolation/diagnostics.ts client/src/services/voiceIsolation/diagnostics.test.ts
git commit -m "feat(voice): local-only diagnostics counters"
```

### Task 4.3: VoiceControls badge

**Files:**
- Modify: `client/src/components/VoiceControls/VoiceControls.tsx`
- Modify: `client/src/components/VoiceControls/VoiceControls.css`

- [ ] **Step 1: Add a small status indicator**

Show a small icon next to mute/deafen showing whether noise suppression is active. Click opens a popover with the diagnostics snapshot.

```tsx
import { IconWaveSquare } from '@tabler/icons-react';
import { useAudioSettingsStore } from '../../stores/audioSettingsStore';
import { diagnostics } from '../../services/voiceIsolation/diagnostics';

const noiseSuppressionEnabled = useAudioSettingsStore((s) => s.noiseSuppression);

{noiseSuppressionEnabled && (
  <button
    className="voice-noise-suppression-badge"
    title={t('noiseSuppression.active', 'Noise suppression active')}
    onClick={() => setShowDiagnostics(true)}
    type="button"
  >
    <IconWaveSquare size={16} />
  </button>
)}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/VoiceControls/
git commit -m "feat(voice): noise suppression status badge in VoiceControls"
```

---

## Milestone 5' — Tests + final integration

### Task 5.1: SFrame interop test (E2E)

**Files:**
- Create: `client/test/e2e/voice-noise-suppression.spec.ts`

- [ ] **Step 1: Write the Playwright test**

```typescript
import { test, expect } from '@playwright/test';

test('noise suppression with SFrame interop', async ({ browser }) => {
  // Two clients in a voice channel
  // Sender's audio: getUserMedia → DFN3 → SFrame encrypt → SFU → SFrame decrypt → DFN3 → output
  // Verify intelligibility + SFrame metadata intact
});
```

- [ ] **Step 2: Document E2E test infrastructure in client/test/e2e/README.md**

(Cover what local servers need to run, etc.)

- [ ] **Step 3: Commit**

```bash
git add client/test/e2e/
git commit -m "test(voice): SFrame interop E2E test"
```

### Task 5.2: Quality regression suite

**Files:**
- Create: `client/test/voice-fixtures/clean_speech.wav`
- Create: `client/test/voice-fixtures/speech_with_keyboard.wav`
- Create: `client/test/voice-fixtures/speech_with_traffic.wav`
- Create: `client/test/voice-quality-regression.test.ts`

- [ ] **Step 1: Source fixtures**

Use LibriSpeech (Apache 2.0) or Common Voice (CC0) for clean speech. ESC-50 or DEMAND for noise. Mix at known SNR using sox or a Node script.

- [ ] **Step 2: Write the regression suite**

```typescript
import { describe, it, expect } from 'vitest';
import * as ort from 'onnxruntime-node';
import { promises as fs } from 'fs';
import wavDecoder from 'node-wav';

describe('DFN3 quality regression', () => {
  it('improves SNR by ≥6dB on speech_with_keyboard', async () => {
    const session = await ort.InferenceSession.create('../server-rs/assets/voice-models/dfn3-v1.onnx');
    const wav = wavDecoder.decode(await fs.readFile('test/voice-fixtures/speech_with_keyboard.wav'));
    const cleanWav = wavDecoder.decode(await fs.readFile('test/voice-fixtures/clean_speech.wav'));

    // ... process noisy through DFN3 and compute SNR improvement vs clean reference
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add client/test/voice-fixtures/ client/test/voice-quality-regression.test.ts
git commit -m "test(voice): DFN3 quality regression suite"
```

### Task 5.3: Final integration check + PR

- [ ] **Step 1: Run the full test suite**

```bash
cd client && npm run lint && npx tsc --noEmit && npm test -- --run
cd ../server-rs && cargo test
```

Expected: clean.

- [ ] **Step 2: Manual end-to-end test**

Set up two browser instances, join the same voice channel, verify the badge appears, verify audio is being processed (you can compare with the toggle off).

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "feat: real-time noise suppression with DeepFilterNet 3" --body "$(cat <<'EOF'
## Summary
- Real-time noise suppression on Dilla voice channels using DeepFilterNet 3
- Applied to both outgoing mic and every incoming peer's audio
- Pivoted from VoiceFilter-Lite (unavailable as open ONNX) — see spec v3 pivot notice
- AudioWorklet → SAB → Worker → ORT Web inference pipeline
- Settings toggle to enable/disable
- Local-only diagnostics counters

## Test plan
- [ ] Unit tests pass
- [ ] Browser-mode pipeline test passes
- [ ] Manual two-peer test verifies audio is processed

## Pivot context
The original spec aimed for personalized voice isolation (Krisp-equivalent) using VoiceFilter-Lite. Spike 0a found VFL is unavailable as open ONNX, and the only viable substitute (the original ailia VoiceFilter, ~123MB, 1.5s lookahead) is incompatible with live calls. After review, the decision was to ship generic real-time noise suppression with DFN3 in this PR; personalized voice isolation remains a future research workstream.
EOF
)"
```

---

## Risks

1. **DFN3 latency on low-end hardware:** addressed by spike 0b. If p95 > 8ms on old laptops, the user may have to disable the feature on their hardware (we surface this in the badge).

2. **SFrame integration outcome:** Task 1.10 is the gating checkpoint. If SFrame uses a layer that's incompatible with the wrap-track approach, the plan halts.

3. **Model size still 2MB+ on first download:** mitigated by IndexedDB caching after first load. Slow connections see ~5s download once.

4. **No fallback path defined:** if DFN3 fails to load, the feature simply doesn't activate (the toggle remains on but pipeline is pass-through). User-visible warning surfaced via the diagnostics panel.
