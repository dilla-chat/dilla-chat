# Voice Isolation Plugin (`dilla-voice-focus`) — Design

**Status:** Phase 1 scope reduced to DFN3-only after spike 0a results
**Author:** brainstorming session, 2026-04-07
**Target branch:** `feat/voice-isolation-phase1`
**Revision:** v3 — DFN3-only pivot (see "v3 pivot notice" below)

---

## v3 pivot notice (2026-04-07, post-spike-0a)

**Spike 0a found that VoiceFilter-Lite is unavailable as a public ONNX
checkpoint.** The only viable substitute (the original ailia-models
VoiceFilter, ~123MB, Apache-2.0) has a 3-second context window and ~1.5
seconds of mouth-to-ear latency, which is incompatible with live voice
calls.

After reviewing the spike memo, the user chose **Option C: pivot to
non-personalized real-time noise suppression with DeepFilterNet 3 only**.

**What this scope reduction removes from the original spec:**

- ❌ Personalized voice isolation (no VoiceFilter / target speaker extraction)
- ❌ Speaker enrollment (no ECAPA-TDNN, no `runEnrollment`, no enrollment modal)
- ❌ Embedding storage (no `embeddingStore`, no HKDF-derived blob store)
- ❌ Embedding broadcast over Signal Protocol (no `embeddingTransport`, no new
  WebSocket event types, no Ed25519 binding, no replay rejection rule)
- ❌ Active-speaker tiered processing (every stream uses the same model now)
- ❌ Symmetric per-peer personalization
- ❌ Federation considerations for embedding distribution
- ❌ Cross-device voice profile sync (Phase 2 milestone 14)

**What this scope reduction keeps:**

- ✅ Real-time noise suppression on all voice streams (your mic + every peer's
  audio you receive)
- ✅ AudioWorklet → SAB ring buffer → dedicated Web Worker → ORT Web inference
  pipeline (the threading model is unchanged because it's still required to
  run any ONNX model in real time without blocking the audio thread)
- ✅ Server-side `rust-embed` model serving via `/api/voice/models/...`
- ✅ COOP/COEP headers for cross-origin isolation (still required for SAB)
- ✅ ORT WASM asset configuration via `ort.env.wasm.wasmPaths`
- ✅ Single seam in `WebRTCService.ts` inside the SFrame boundary
- ✅ Diagnostics counters (simplified — no enrollment counters)
- ✅ Settings → Audio toggle ("Noise suppression: on/off")
- ✅ Quality regression suite (DFN3-only)

**What changes about the user-facing feature:**

- The feature is now called **"Noise Suppression"**, not "Voice Isolation"
- Strips background noise (keyboard, traffic, fans, etc.) from voice streams
- **Does not** reject other human voices in your environment
- **Does not** reject music with strong vocals
- Closer to "what RNNoise tried to do, but with a better model" than to Krisp
- Setup is one-click (no enrollment): user toggles it on in Settings, models
  download once on first voice join, feature is active for all subsequent
  calls

**What's the same as before:**

- Open source, self-hosted, no CDN, no third-party SDK
- Runs entirely client-side (preserves Dilla's E2EE guarantee)
- Lazy-loaded model from home server, IndexedDB cached
- Both directions: own mic + every incoming peer's stream
- Privacy-first: no telemetry off-device

---

## Revision history

**v2 (this revision)** — addresses critical issues from first review pass:
- **Issue 1 (SFU has no level events):** active-speaker tracker now uses
  client-side `AnalyserNode` RMS sampling, no SFU changes required
- **Issue 2 (`webrtc.ts` is a re-export, SFrame layer exists):** integration
  seam corrected to `WebRTCService.ts`, ordering invariant relative to
  `voiceEncryption.ts` documented, SFrame interop test added (Layer 4)
- **Issue 3 (`keyStore.ts` is MEK-only):** `embeddingStore` is now a small
  new HKDF-derived encrypted blob store, not an extension of keyStore
- **Issue 4 (VFL ONNX availability aspirational):** new spike milestone 0a
  with explicit pass criterion and named fallback hierarchy
- **Issue 5 (latency math missing):** full per-call latency budget computed
  in High-Level Architecture, Worker pool design replaces single-worker
  assumption, spike milestone 0b is the explicit gate
- **Issue 6 (ORT Web can't run inside AudioWorklet):** architecture revised
  to AudioWorklet → SAB ring → dedicated Worker → ORT Web. Worklet is now
  a buffer pump, not an inference host
- **Issue 7 (biometric threat model thin):** dedicated section added,
  enrollment modal copy made explicit about non-revocable nature
- **Issue 8 (replay rejection too strict):** `senderSequence` field added
  to encrypted payload, acceptance rule rewritten
- **Issue 9 (federation downgrade attack):** signature now binds
  `channelId`/`recipientUserId`, badge distinguishes "federated may not
  support" from "peer hasn't enrolled"
- **Issue 10 (Phase 1/2 dependency):** WebGPU milestone explicitly NOT a
  Phase 1 emergency exit; Phase 1 fallback hierarchy stays within Phase 1
- **Issue 11 (frame size math):** sample-rate pipeline (48 → 16 → 48)
  documented inside `pipeline.ts` section
- **Issue 12 (diagnostics counter list):** exact counter contract added to
  OQ-2 resolution
- **Issue 13 (manifest forward-compat):** `minClientVersion` reserved field
  added in v1
- **Issue 14 (model storage):** Git LFS chosen explicitly over build-time
  fetch
- **Issue 15 (SFrame interop test missing):** added as Layer 4 test 9
- **Issue 16 (active-speaker cold start):** "first 500ms = all background"
  policy documented

**v1 (2026-04-07, original draft)** — initial brainstorming output.

---

## Goal

Build an open-source, self-hosted, privacy-preserving real-time voice isolation
system for Dilla voice channels — functionally equivalent to Krisp's "Voice
Focus" feature. The system must:

1. Strip background noise (keyboard, traffic, fans, etc.) from voice streams
2. Reject **other human voices** in the speaker's environment (the headline
   property that distinguishes voice isolation from generic noise suppression)
3. Process both directions — your outgoing mic AND every incoming peer's
   audio
4. Run entirely client-side (preserving Dilla's end-to-end encryption guarantee)
5. Match Dilla's federated, self-hosted ethos (no third-party SDKs, no CDN
   dependencies, no commercial license, no telemetry leaving the device)

This document specifies the system at a level a writing-plans agent can turn
into an ordered implementation plan.

---

## Context

Dilla is a federated, end-to-end encrypted Discord alternative. Voice channels
already work via a Rust SFU (`webrtc-rs`) on the server and a browser/Tauri
WebRTC client. The codebase has historical scaffolding for noise suppression:

- `client/src/services/noiseSuppression.ts` exists as a no-op stub. The comment
  reads: *"RNNoise has been removed. This file preserves the public API so that
  existing call-sites compile without changes; every method is a no-op."*
- `client/src/stores/audioSettingsStore.ts` exposes
  `noiseSuppressionMode: 'none' | 'browser'` and is wired into the Settings UI.
- `client/src/types/webrtc-encoded-transform.d.ts` suggests prior interest in
  hooking into WebRTC at the encoded-frame layer (we explicitly do not use
  this approach — see **Architectural Decisions**).

The existing infrastructure is wired and waiting for a real implementation.
RNNoise was removed because its quality was insufficient for the user experience
we want.

---

## Architectural Decisions (decision log)

These were resolved during brainstorming. Each is a hard commit; if any is
revisited, several downstream choices need to be re-evaluated.

| # | Question | Decision | Implications |
|---|---|---|---|
| 1 | What does "Krisp-like" mean? | True voice isolation: reject other voices and music, not just background hiss | Forces personalized DNS approach |
| 2 | Outgoing only or both directions? | **Both** (symmetric) | Embeddings must be broadcast to every peer; CPU scales with peer count |
| 3 | Which model? | **DeepFilterNet 3 only** (revised from VFL+ECAPA+DFN3 after spike 0a). VoiceFilter-Lite is unavailable as open ONNX; the substitute (full VoiceFilter, ~123MB, 1.5s lookahead) is incompatible with live calls. | ~2MB model weight, real-time WASM inference, generic noise suppression |
| 4 | Runtime split | **WASM-only** with SIMD-128, AudioWorklet host, same artifact in browser and Tauri webview. Native virtual audio device deferred to Phase 2. | One codebase, no Tauri-IPC bridge needed |
| 5 | Voice isolation strategy | **Personalized DNS** — enrollment captures the user's voice once, embedding conditions the model | Each user must enroll; embeddings must be exchanged between peers |
| 6 | Symmetric or asymmetric? | **Symmetric** — every peer broadcasts their embedding so every receiver can run conditioned extraction on every stream | New WS event types; embedding distribution protocol |
| 7 | Enrollment UX | **Lazy-mandatory on first voice channel join**, ad-hoc capture flow, blocking modal | Slow-network softening: see OQ-1 resolution below |
| 8 | Embedding crypto | **Signal Protocol-encrypted broadcast** (per-recipient) with inner Ed25519 signature for long-term identity binding | Reuses existing crypto stack; no new primitives |
| 9 | Scaling beyond 5 peers | **Active-speaker tiered processing** — top-N (default 2) loudest peers get VoiceFilter-Lite, all others get DeepFilterNet 3. Constant CPU regardless of call size. | Dispatcher uses client-side AnalyserNode level tracking (no SFU dependency); hysteresis required |
| 10 | Where in the WebRTC pipeline? | **AudioWorklet pre-PeerConnection**, single seam in `WebRTCService.ts` (inside the SFrame boundary — process before encrypt outgoing, after decrypt incoming) | Standards-based; works in browser and Tauri webview |
| 11 | Model distribution | **Lazy-load from home server**, served via `rust-embed` from `server-rs/assets/voice-models/`, cached in IndexedDB. No CDN. | New tiny `/api/voice/models/...` Rust handler |

### Resolved open questions (from Section 6 of brainstorming)

- **OQ-1 (slow-network escape hatch):** Soften the "strict mandatory" enrollment
  rule. If model download is incomplete or fails when a user tries to join
  voice, they may proceed with a clearly-surfaced warning ("Voice isolation is
  loading — you'll get the upgrade when it's ready"). Background download
  continues; feature activates as soon as it's ready.
- **OQ-2 (telemetry):** Local-only diagnostic counters surfaced in
  *Settings → Audio → Diagnostics*. **Never sent off-device.** The exact
  counter set is:

    | Counter | Type | Reset behavior |
    |---|---|---|
    | `medianFrameProcessingMs` | rolling 5-minute window per model kind | rolls forward continuously |
    | `p95FrameProcessingMs` | rolling 5-minute window per model kind | rolls forward continuously |
    | `framesDroppedSinceJoin` | monotonic per call | resets on call leave |
    | `activeSpeakerFlipsPerMin` | rolling 1-minute window | rolls forward continuously |
    | `cpuDegradeTriggerCount` | monotonic per session | resets on app restart |
    | `embeddingPublishSuccessRate` | success/(success+fail) over last 100 attempts | rolling, ring buffer |
    | `embeddingsRejectedSignature` | monotonic per session | resets on app restart |
    | `embeddingsRejectedReplay` | monotonic per session | resets on app restart |
    | `lastTenErrors` | bounded ring buffer of (timestamp, code, message) | bounded to 10 entries |
    | `peersWithEmbedding` | snapshot int (current call) | live |
    | `peersFedDowngradeSuspected` | snapshot int (current call) | live |

  All counters are kept in memory only — they are *not* persisted across
  app restarts (except where noted) and are *not* serialized to IndexedDB.
  This is enforced by code structure (the diagnostics module exposes a
  read-only React hook; there is no `save()` method).
- **OQ-3 (total model failure fallback):** Pass-through with warning. If no
  models can be loaded, voice still works — just unprocessed. The user sees a
  clear "Voice isolation unavailable" status.
- **OQ-4 (model upgrade re-enrollment):** Prompt on the next voice channel
  join after a model version bump. Skip-able; skipped users fall back to
  DeepFilterNet 3 until they re-enroll voluntarily from Settings.

---

## Glossary

| Term | Meaning |
|---|---|
| **Embedding** | A 256-float vector that uniquely represents a speaker's voice. Output of ECAPA-TDNN. ~1KB on disk. |
| **Enrollment** | The one-time process of capturing 15 seconds of clean speech and converting it to an embedding. |
| **VFL** | VoiceFilter-Lite. The target-speaker enhancement model. Takes (noisy audio + embedding) → only that speaker's voice. |
| **ECAPA** | ECAPA-TDNN. The speaker encoder. Takes audio → embedding. |
| **DFN3** | DeepFilterNet 3. General noise suppression fallback model used for unenrolled peers and background-tier active speakers. |
| **Dispatcher** | The per-call orchestration layer. Decides which model runs on which stream. |
| **Active-speaker tier** | The top-N (default 2) loudest peers in a call. They get VFL; others get DFN3. |
| **Personalized DNS** | Personalized Deep Noise Suppression. The umbrella term for voice-isolation models conditioned on a speaker embedding. |
| **Pass-through mode** | Audio flows through the pipeline unmodified. Used as the failure fallback. |

---

## High-Level Architecture

A single TypeScript module **`client/src/services/voiceIsolation/`** owns:

- The enrollment flow (capture → embedding → store)
- The runtime pipeline (AudioWorklet → SAB ring buffer → dedicated inference
  Worker, plus the WASM/ORT-Web binding code that runs in that Worker)
- The embedding broadcast / receive (Signal-encrypted, WebSocket-transported)
- The active-speaker tier dispatcher (decides per-stream which model to apply)
- The active-speaker level tracker (client-side AnalyserNode-based RMS sampler)
- The model loader (lazy fetch from home server, IndexedDB cache)

### Integration seam — actual files in this codebase

The seam is **not** in `client/src/services/webrtc.ts` (that file is a thin
re-export). The real integration points are in
**`client/src/services/webrtc/WebRTCService.ts`**, and the plugin must respect
the **existing SFrame voice encryption layer** in
**`client/src/services/webrtc/voiceEncryption.ts`**, which already wraps voice
RTP frames end-to-end-encrypted.

The pipeline ordering is:

```
OUTGOING:
  getUserMedia ──► voiceIsolation.processOutgoing(track) ──► clean track
                                                                  │
                                                                  ▼
                                              VoiceEncryptionManager (SFrame)
                                                                  │
                                                                  ▼
                                                  pc.addTrack() / RTPSender
                                                                  │
                                                                  ▼
                                                                 SFU

INCOMING:
  pc.ontrack ──► VoiceEncryptionManager.decrypt() ──► plain RTP
                                                          │
                                                          ▼
                          voiceIsolation.processIncoming(track, peerId)
                                                          │
                                                          ▼
                                                     <audio> element
```

**Critical ordering invariant:** outgoing audio is processed *before* SFrame
encryption (so the SFU and other peers receive the cleaned audio); incoming
audio is processed *after* SFrame decryption (so we operate on plain PCM, not
encrypted opaque frames). This means the voice isolation seam sits *inside*
the SFrame boundary, not outside it.

The exact `WebRTCService.ts` modifications are:
- The `addTrack` call on line 109 (current code) is preceded by a call to
  `voiceIsolation.processOutgoing(localTrack)` whose returned track is what
  gets added.
- The `pc.ontrack` handler on line 131 wraps the received `event.track` with
  `voiceIsolation.processIncoming(track, peerId)` *after* `VoiceEncryption`
  has already been wired up (which happens at the RTP layer, not the
  MediaStreamTrack layer — confirming this is part of the spike milestone).

### Module map

```
                  ┌────────────────────────────────────────────────┐
                  │  client/src/services/voiceIsolation/           │
                  │                                                │
   AudioWorklet   │   audioWorklet/                                │
   thread         │     ringBufferProcessor.js  ◄── audio thread   │
   ─ ─ ─ ─ ─ ─ ─ ─│ ─ ─ ─ ─ ─ ─ │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
                  │             │  SharedArrayBuffer ring         │
                  │             ▼                                  │
   Worker thread  │   inferenceWorker.ts  (ORT Web + ECAPA + VFL  │
                  │     + DFN3 + per-stream inference loop)       │
                  │             │                                  │
   ─ ─ ─ ─ ─ ─ ─ ─│ ─ ─ ─ ─ ─ ─ │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
                  │             │  output ring                    │
                  │             ▼                                  │
   AudioWorklet   │   ringBufferProcessor.js (output side)        │
                  │             │                                  │
                  │             ▼                                  │
                  │       MediaStreamDestination → next node      │
                  │                                                │
   Main thread    │   modelLoader.ts                               │
                  │   embeddingStore.ts (HKDF-derived blob store) │
                  │   embeddingTransport.ts                       │
                  │   enrollment.ts                                │
                  │   dispatcher.ts                                │
                  │   activeSpeakerTracker.ts (AnalyserNode-based)│
                  │   pipeline.ts (manages worklet + worker pair)  │
                  └────────────────────────────────────────────────┘
```

The threading model is the most important thing on this page:

1. **Audio thread (AudioWorklet):** receives 128-sample render quanta (~2.7ms
   at 48 kHz, the only frame size the spec allows worklets) from the upstream
   `MediaStreamSource`. Writes them into a `SharedArrayBuffer` ring buffer
   (input ring). Reads processed PCM from a second `SharedArrayBuffer` ring
   (output ring) and emits it to the next node. The worklet does **no
   inference**. It's a buffer pump.

2. **Inference Worker (dedicated Web Worker):** owns one or more ORT Web
   sessions (VFL + ECAPA + DFN3). Wakes on `Atomics.wait` when input ring
   has enough samples for a full model window, runs `session.run()`, writes
   output PCM to the output ring, signals via `Atomics.notify`. ORT Web has
   to run here because `AudioWorkletGlobalScope` does not have `fetch`,
   dynamic import, or the other APIs ORT Web needs.

3. **Main thread:** owns the dispatcher, embedding transport, model loader,
   enrollment UI. Talks to workers via `postMessage` for model swap commands
   and state queries (never for per-frame data — that's all SAB).

### Latency budget (now actually computed)

Per stream, per render quantum (2.7ms at 48 kHz):
- Audio thread → input ring write: ~0.05ms
- Worker wake from `Atomics.wait`: ~0.5–2ms (worst case)
- ORT Web session.run() for one VFL frame (30ms model window): claimed
  ~15ms M1 with WASM SIMD; **gating benchmark required**
- Output ring write + audio thread read: ~0.05ms
- Total VFL pipeline latency: claimed ~17–19ms per stream worst case

For a 6-person call with top-N=2 active-speaker tiering:
- 2 incoming VFL streams + 1 outgoing VFL = 3 VFL inferences per cycle
- 4 incoming DFN3 streams (DFN3 is ~1/3 the cost of VFL → ~5ms each) =
  4 × 5ms = 20ms total DFN3
- VFL: 3 × 17ms = 51ms (sequential within one Worker)
- Total compute per cycle: ~71ms
- Audio cycle target: 30ms (model window) — **single-Worker design exceeds
  budget by ~40ms**

**Mitigation built into the design:** the inference Worker pool uses one
Worker per active CPU core (typically 4–8 on M1, 8–16 on modern desktops).
ORT Web sessions are partitioned across workers. Per-Worker compute drops
to ~17ms, below the 30ms cycle. This is **the only architecture that fits
the latency budget**, and it's why the threading model is what it is.

The benchmark gate at milestone 3 measures: real per-frame time for VFL on
M1 + a representative low-end laptop. If VFL exceeds 25ms per frame on the
low-end target, the Phase 1 fail-mitigation hierarchy (also documented in
spike 0b) is:
- Drop top-N to 1 (only the loudest active speaker gets VFL; everyone else
  gets DFN3)
- Move to a smaller VFL variant (or DTLN-aec, see Risk #2 mitigation)
- Auto-degrade slow hardware to DFN3-only, surfaced in the diagnostics UI

WebGPU acceleration is **explicitly NOT** in this list — it remains a Phase 2
milestone (#11). Phase 1 must be shippable using only WASM SIMD with the
fallback hierarchy above.

### Module boundaries

| Submodule | Purpose | Public surface |
|---|---|---|
| `modelLoader.ts` | Fetch + cache + instantiate ORT Web sessions (in worker) | `loadModels(): Promise<ModelHandles>` |
| `enrollment.ts` | Capture + run ECAPA + store embedding | `enroll(): Promise<EnrollmentResult>` |
| `embeddingStore.ts` | HKDF-derived encrypted blob store per identity | `get/set/clear(identityId)` |
| `embeddingTransport.ts` | Broadcast + receive over Signal session | `publish(channel)`, `onPeerEmbedding(callback)` |
| `pipeline.ts` | Manages a (worklet, worker, SAB ring pair) per stream | `processStream(track, model, embedding?)` |
| `inferenceWorker.ts` | Dedicated Worker — owns ORT sessions, runs `session.run()` | message protocol over `postMessage` + SAB |
| `audioWorklet/ringBufferProcessor.js` | Audio-thread buffer pump | registered via `audioContext.audioWorklet.addModule(...)` |
| `dispatcher.ts` | Per-call orchestration + active-speaker tier | `attachToCall(callId)` |
| `activeSpeakerTracker.ts` | Client-side AnalyserNode-based RMS sampler | `tierFor(peerId)`, `onTierChange(callback)` |

The dispatcher is the per-call "brain". Everything else is stateless or
single-purpose. **No new server-side audio level events are needed** —
`activeSpeakerTracker` measures incoming peer streams locally with
`AnalyserNode.getByteFrequencyData` on the main thread (the analyzer node
gets attached as a sibling to the inference pipeline, not in series, so it
doesn't add to the latency budget).

---

## Data Flow

### Outgoing path (your mic, sent to peers)

```
1. User joins voice channel
2. dispatcher.attachToCall(callId)
   ├─ embeddingStore.get(currentIdentity) → embedding | null
   │
   ├─ if null:
   │    enrollment.startBlockingFlow()
   │       ├─ Show modal: "Set up your voice profile (15s)"
   │       ├─ Capture clean audio via ad-hoc getUserMedia
   │       ├─ Run ECAPA-TDNN over capture → 256-float embedding
   │       ├─ embeddingStore.set(currentIdentity, embedding, modelVersion)
   │       └─ Resume call join
   │
   ├─ embeddingTransport.publish(callId, embedding)
   │    └─ For each peer in call:
   │         encrypt(embedding) via Signal session → WS event 'voice.embedding'
   │
   └─ pipeline.processStream(micTrack, vfl, embedding) → cleanedTrack
        └─ added to RTCPeerConnection sender
```

### Incoming path (a peer's track arrives)

```
1. WebRTCService.ts ontrack handler fires (after SFrame decryption layer)
2. dispatcher.onIncomingTrack(track, peerId)
   ├─ peerEmbedding = embeddingTransport.getCachedEmbedding(peerId)
   │   (may be null if peer hasn't broadcast yet, or is on legacy client)
   │
   ├─ tier = activeSpeakerTracker.tierFor(peerId)
   │   ('active' if peer is in top-N loudest, else 'background')
   │
   ├─ select model:
   │     if peerEmbedding && tier === 'active'  → VFL conditioned on peerEmbedding
   │     else if tier === 'active'              → DFN3 (peer hasn't enrolled)
   │     else                                   → DFN3 (background speaker)
   │
   └─ pipeline.processStream(track, model, peerEmbedding) → cleanedTrack
        └─ attached to <audio> element / Web Audio output
```

### Active-speaker promotion (client-side, no server changes)

The original spec assumed the SFU emits per-peer level events. **It does not.**
A scan of `server-rs/src/ws/events.rs` confirmed there is no `voice.level` /
`audio_level` / `active_speaker` event type, and `server-rs/src/voice/` has no
RMS-emission path.

Rather than adding a server-side level broadcast (which would require an SFU
change, a new WS event type, federation propagation, and new tests), the
plugin computes levels **client-side** in the main thread:

- For each incoming peer track, an `AnalyserNode` is attached as a *parallel*
  branch off the same `MediaStreamSource` that feeds the inference pipeline
  (siblings, not in series). The analyzer adds zero latency to the audio
  output path; it just samples for tier-decision purposes.
- The main thread polls each analyzer at 100ms intervals using
  `getFloatFrequencyData()` and computes a band-limited RMS (300–3400 Hz,
  the speech band) to ignore non-vocal noise floor.
- Maintains a rolling 500ms window of RMS values per peer.
- Picks the top-2 peers by averaged RMS → "active" tier.
- Hysteresis: a candidate must be ≥10% louder for ≥300ms to demote a current
  active speaker, preventing flicker.
- **Cold start (first 500ms of a call):** all peers are treated as background
  (DFN3); tiering begins once the rolling window fills. This avoids
  thrash from incomplete data.
- When a peer's tier changes, the dispatcher messages the inference Worker
  to swap the active model on that stream's pipeline.

Model swap on the worker side is atomic: each pipeline holds a current
`ModelHandle` reference, and a swap message changes the reference between
inference cycles. The audio thread never sees a partial swap because it just
reads PCM from the output ring.

### Embedding broadcast lifecycle

```
Enroll once       → embedding stored locally (HKDF-derived encrypted blob store)
Join voice        → publish to call peers via Signal-encrypted WS event
Peer joins later  → re-publish to that peer (1:1 catchup)
Re-enroll         → publish replacement, supersedes prior version
Model upgrade     → embedding tagged with modelVersion; mismatched versions
                    trigger re-enroll prompt on next voice join
```

A peer with no embedding (legacy client, federated server that hasn't
upgraded, slow-network user without models loaded yet) gets DFN3 fallback for
both directions. The system **degrades silently and naturally**, surfaced in
the UI as a small badge.

---

## Component Detail

### `modelLoader.ts`

**Responsibility:** fetch model artifacts from `/api/voice/models/<name>` on
the home server, validate (SHA-256 checksum from a manifest), cache in
IndexedDB keyed by `(modelName, version)`, instantiate as a WebAssembly module
plus an ONNX Runtime Web session.

**Public surface:**
```ts
loadModels(): Promise<{
  vfl: ModelHandle;        // VoiceFilter-Lite
  ecapa: ModelHandle;      // speaker encoder
  dfn3: ModelHandle;       // fallback noise suppressor
}>

modelVersion(): number;    // current loaded version (for embedding tagging)
manifestEtag(): string;    // for upgrade detection
```

**Manifest format** (served by the home server, ~200 bytes):
```json
{
  "version": 1,
  "vfl":   { "url": "/api/voice/models/vfl-v1.onnx",   "sha256": "..." },
  "ecapa": { "url": "/api/voice/models/ecapa-v1.onnx", "sha256": "..." },
  "dfn3":  { "url": "/api/voice/models/dfn3-v1.onnx",  "sha256": "..." }
}
```

The manifest is served by a new tiny Rust handler in
`server-rs/src/api/voice.rs::models_manifest()`. The actual `.onnx` files live
in `server-rs/assets/voice-models/` and are served via `rust-embed` (no
external dependency, no separate hosting). Adding a new model is just dropping
a file in that directory and bumping the manifest.

**Failure modes:**
- Network error fetching manifest → retry with exponential backoff (3 attempts)
- Network error fetching individual model → retry, fall back to DFN3-only mode
  if `vfl` or `ecapa` is missing
- Checksum mismatch → reject, log security warning, surface to user
- IndexedDB unavailable → in-memory cache only (no persistence between sessions)

### `enrollment.ts`

**Responsibility:** capture clean audio, run ECAPA, return embedding.

**Flow:**
1. Open ad-hoc `getUserMedia({ audio: true })` (separate from any in-call
   stream so existing call audio is undisturbed)
2. Show modal with a sample script ("Read this paragraph aloud") and a
   15-second waveform meter
3. Buffer 15 seconds of PCM (48 kHz mono, downsampled to 16 kHz for ECAPA's
   training-time sample rate)
4. Run ECAPA on the full buffer → 256-float embedding
5. Validate the capture:
   - amplitude variance > floor (catch silence / muted mic)
   - no clipping > 1% of frames (catch distorted mic)
   - speech-frame ratio > 50% (catch user not actually speaking)
6. On validation failure, show inline error in modal, prompt to retry

**Public surface:**
```ts
enroll(): Promise<{
  embedding: Float32Array;     // 256 floats
  modelVersion: number;        // version of ECAPA used
  capturedAt: string;          // ISO timestamp
}>

isEnrolling(): boolean;
cancel(): void;
```

### `embeddingStore.ts`

**Responsibility:** persist embeddings encrypted at rest, keyed by identity.

`keyStore.ts` is **not** a general-purpose blob store — it's the V3 MEK
identity-key-management module that holds `EncryptedKeyFileV3` records with
passkey/password slots. Shoe-horning embeddings into the MEK format would
conflate identity keys (rotation-sensitive, never leave the device) with a
derived biometric fingerprint (different lifecycle, different threat model).

Instead, `embeddingStore` is a small **new** encrypted IndexedDB wrapper that:
- Derives its own AES-256-GCM key from the already-unlocked MEK via one extra
  HKDF step (`HKDF(MEK, salt="dilla:voice-embedding:v1", info=identityId)`)
- Stores per-identity records under a single object store `voice_embeddings`
- Wraps each embedding payload as an authenticated ciphertext with a random
  96-bit nonce
- Surfaces a tiny `get/set/clear/listAll` API
- Treats IndexedDB unavailability as "not enrolled" (clean fallback)

The HKDF derivation means the embedding is bound to the same MEK that gates
the rest of the user's secrets — losing access to the identity loses access
to the embedding, which is the correct behavior. It does **not** require any
changes to `keyStore.ts` itself; the consumer module just calls
`keyStore.getMek()` (already exposed) and derives downward.

```ts
get(identityId: string): Promise<{
  embedding: Float32Array;
  modelVersion: number;
  capturedAt: string;
} | null>

set(identityId: string, embedding, modelVersion): Promise<void>
clear(identityId: string): Promise<void>
listAll(): Promise<Array<{ identityId: string, capturedAt: string }>>
```

**Failure modes:**
- IndexedDB unavailable → return null from `get`; treat as not enrolled
- Decryption failure → return null, log warning; user re-enrolls
- Identity isolation: an embedding stored under identity A is not retrievable
  under identity B (enforced by binding the HKDF derivation to
  `info=identityId` — the AES-GCM key for identity B is mathematically
  unrelated to the key for identity A, so even raw IndexedDB read would
  yield ciphertext that decrypts to nothing)

### `embeddingTransport.ts`

**Responsibility:** send/receive embeddings over the WebSocket signaling
channel, encrypted via Signal Protocol.

**Two new WebSocket event types** added to `server-rs/src/ws/events.rs`:

```rust
// Client → server (relayed to all peers in voice channel)
pub struct VoiceEmbeddingPublish {
    pub channel_id: String,
    pub to_user_id: String,           // recipient (one event per peer)
    pub ciphertext: Vec<u8>,          // Signal-encrypted embedding payload
}

// Server → client (forwarded from another peer)
pub struct VoiceEmbeddingReceived {
    pub channel_id: String,
    pub from_user_id: String,
    pub ciphertext: Vec<u8>,
}

// Client → server (broadcast to all peers; revokes a previously-published
// embedding so peers stop using it immediately)
pub struct VoiceEmbeddingRevoke {
    pub channel_id: String,
    pub to_user_id: String,
    pub revoked_capture_id: String,
}
```

The server is **a dumb relay** for these events. It does not inspect the
ciphertext. Federation handling is the same as for messages: cross-server
relay via the existing federation transport. The server enforces only that the
sender is a current participant of the named channel.

**Encrypted payload format** (inside the Signal envelope):
```ts
{
  embedding: Float32Array(256),
  modelVersion: number,
  capturedAt: string,            // ISO timestamp (sender's clock)
  captureId: string,             // UUIDv4, unique per enrollment, used for revocation
  channelId: string,             // binds embedding to a specific voice channel
  recipientUserId: string,       // binds embedding to one recipient
  senderSequence: number,        // monotonic per-(sender, recipient) counter
  signature: Uint8Array,         // Ed25519 signature over ALL above fields
}
```

The Signal envelope handles confidentiality and transport authentication.
The inner Ed25519 signature gives long-term identity binding so the recipient
can verify the embedding is actually from the user's long-term identity key,
not a transient Signal session forwarded by a malicious party. **Crucially,
the signature covers `channelId`, `recipientUserId`, and `senderSequence`**
in addition to the embedding itself, which prevents:
- A malicious server from re-targeting a published embedding to a different
  channel (channelId binding)
- A peer from forwarding someone else's embedding to a third party
  (recipientUserId binding)
- Replay of an old embedding by a federated server that holds onto past
  payloads (senderSequence monotonicity)

**Acceptance rule** (replaces the original "strictly greater capturedAt"):
1. If `captureId` matches a cached entry from this peer → it's a republish
   for catchup (mid-call peer join), accept and forward to the dispatcher
   without state change
2. Else if `senderSequence > cachedSequence[senderId]` → accept, update
   cached embedding, increment `cachedSequence[senderId]`
3. Else → reject as replay, log warning to local diagnostics

This handles clock skew (we no longer compare wall-clock timestamps) while
still preventing replay (sequence is enforced strictly per sender).

**Failure modes:**
- Signal session not yet established with a peer → trigger session setup,
  retry the publish (existing message-send code handles this exact case;
  embedding transport piggybacks on it)
- Decrypted payload signature invalid → reject embedding, log security
  warning, mark peer as "unverified" in dispatcher state
- Peer publishes a payload tagged with an older model version than the local
  client → still accept it, but note the version mismatch in dispatcher state
  (the local client may have to fall back to DFN3 if the loaded model can't
  process the older embedding format)
- Replay attack: rejected by the `senderSequence` acceptance rule documented
  above (a payload whose `senderSequence` is not strictly greater than the
  cached value for `(senderId, recipientUserId)` AND whose `captureId` does
  not match the cached entry is rejected and counted in
  `embeddingsRejectedReplay`)

### `pipeline.ts`

**Responsibility:** wrap a single `MediaStreamTrack` in a (worklet, ring
buffer pair, worker assignment) bundle that produces a cleaned output track.
The unit is "one stream + one model"; the dispatcher creates one pipeline
per active stream.

```ts
processStream(
  track: MediaStreamTrack,
  initialModel: ModelKind,         // 'vfl' | 'dfn3' | 'passthrough'
  embedding?: Float32Array,
): Pipeline;

interface Pipeline {
  outputTrack: MediaStreamTrack;
  switchModel(model: ModelKind, embedding?: Float32Array): void;
  destroy(): void;
  getStats(): { framesProcessed: number; framesDropped: number; medianMs: number };
}
```

**Internal layout per pipeline:**

1. `MediaStreamSource(track)` → `AudioWorkletNode("voice-iso-ring-pump")`
2. `AudioWorkletNode` writes 128-sample render quanta into an **input
   `SharedArrayBuffer` ring** (~4096 sample capacity, ~85ms of headroom)
3. The pipeline's assigned `inferenceWorker` `Atomics.wait`s on the input
   ring's write counter
4. When ≥ model_window samples are available (1440 for VFL at 48 kHz, after
   internal 48→16 kHz resampling), the worker reads them, runs
   `session.run()`, writes output to an **output `SharedArrayBuffer` ring**
5. `Atomics.notify` wakes the audio thread side
6. The same `AudioWorkletNode` reads from the output ring on its next render
   quantum and emits the PCM
7. Output is wired to a `MediaStreamDestination` whose track is the
   `Pipeline.outputTrack`

**Sample-rate pipeline:**
- Input: 48 kHz from `MediaStreamSource`
- VFL/ECAPA expect 16 kHz: the worker performs polyphase decimation (3:1
  via a precomputed FIR table — adds ~1ms of latency)
- VFL output: 16 kHz cleaned PCM → upsampled back to 48 kHz inside the
  worker via the same polyphase filter (1:3) → written to output ring
- DFN3: also 16 kHz internally; same resampling path
- Passthrough mode: skip the worker entirely, copy input ring → output ring
  in the audio thread (the worklet handles passthrough natively for the
  failure-fallback case)

**Worker pool:** the dispatcher owns an `inferenceWorkerPool` of size
`min(navigator.hardwareConcurrency - 1, 6)`. Each pipeline is assigned to a
worker round-robin at creation. A worker can hold multiple pipelines if the
pool is smaller than the active stream count. This is the key change that
makes the latency budget work — see "Latency budget" above.

**Cross-origin isolation:** required for `SharedArrayBuffer`. We set COOP
(`same-origin`) and COEP (`require-corp`) headers in `server-rs`, scoped
**only** to the client-app routes (`/`, `/app`, `/api`, the static asset
paths). Third-party embedded content paths (if any — Dilla currently has
none, but federation might add them) are excluded.

**Why we don't run inference inside `AudioWorkletGlobalScope` directly:**
ORT Web (the only practical way to run ONNX in a browser) uses `fetch`,
dynamic `import`, top-level `await`, and several other APIs that are simply
not available inside `AudioWorkletGlobalScope`. Compiling models to a
self-contained WASM blob via `tract` or `wonnx` is technically possible, but
it's a significant tooling investment and the resulting binaries don't yet
match ORT Web's per-op performance for the operators VFL and ECAPA use.
The Worker + SAB design is the standard pattern for browser ML audio
workloads (used by Jitsi, Daily, and Whereby's noise-suppression
implementations) and we follow it.

**Failure modes:**
- WASM instantiation fails → pipeline operates in pass-through mode, dispatcher
  surfaces failure to UI
- Frame deadline missed (processing > 30ms) → log a counter; pipeline
  continues. If 5 misses occur in 10s, dispatcher triggers global degrade
  (all background peers drop to pass-through, only top-1 active speaker
  retains VFL)
- Model swap mid-stream → handled by the dispatcher; the worklet never sees
  the swap mid-frame; model handles are atomic references

### `dispatcher.ts`

**Responsibility:** per-call orchestration. Holds state about which peers are
in the call, which embeddings we have for them, who's currently in the
active-speaker tier, and which pipelines are running.

```ts
attachToCall(callId: string, currentIdentityId: string): Promise<void>
onPeerJoin(peerId: string): void
onPeerLeave(peerId: string): void
onIncomingTrack(track: MediaStreamTrack, peerId: string): MediaStreamTrack
detach(): void

getCallState(): {
  selfEnrolled: boolean;
  selfModelVersion: number;
  cpuDegradeActive: boolean;
  peers: Array<{
    id: string;
    enrolled: boolean;
    verified: boolean;
    federatedDowngradeSuspected: boolean;
    tier: 'active' | 'background';
    model: 'vfl' | 'dfn3' | 'passthrough';
    framesProcessed: number;
    framesDropped: number;
  }>;
}
```

The state snapshot is what feeds the UI badge. Active-speaker tier transitions
are pushed to the dispatcher *from* `activeSpeakerTracker` via an internal
callback (`onTierChange`); there is no public `onLevelUpdate` method because
levels are computed locally inside the tracker and never crossed module
boundaries.

### `activeSpeakerTracker.ts`

**Responsibility:** measure incoming peer audio levels client-side using
`AnalyserNode`, maintain rolling averages, decide tier membership.

For each incoming peer track the dispatcher passes in, the tracker creates a
parallel `AnalyserNode` branch off the same `MediaStreamSource` that feeds
the inference pipeline (siblings, not in series — adds zero output-path
latency). It polls each analyzer every 100 ms with `getFloatFrequencyData()`,
computes a band-limited RMS over the speech band (300–3400 Hz) to ignore
non-vocal noise floor, and stores it in a per-peer 500 ms ring buffer.

```ts
constructor(audioContext: AudioContext, topN: number = 2);
attachPeer(peerId: string, source: MediaStreamSource): void;
detachPeer(peerId: string): void;
tierFor(peerId: string): 'active' | 'background';
onTierChange(callback: (peerId: string, newTier: 'active' | 'background') => void): void;
detach(): void;
```

Tier policy: every 100 ms recompute, the top-N peers by averaged speech-band
RMS are the candidate active set. To promote a candidate to "active", they
must be ≥10% louder than the lowest current active peer for ≥300 ms (3
consecutive ticks). To demote, inverse — a current active peer must fall
below the threshold for ≥300 ms.

**Cold start:** during the first 500 ms of a call (rolling window not yet
filled), all peers are treated as background tier (DFN3). Tiering activates
once the window is full. This avoids thrash from incomplete data when
everyone joins at once.

**No SFU dependency:** there is no `voice.level` WebSocket event in the
server. The tracker is fully client-local. Compared to a server-pushed
approach, this trades a small amount of CPU on the main thread (negligible
— `getFloatFrequencyData` is fast) for zero protocol changes and zero
federation work.

---

## UX

### UI integration points (4 places)

**1. UserSettings → Audio tab** (existing file: `client/src/pages/UserSettings.tsx`)
- New section: **Voice Isolation**
- Toggle: "Personalized voice isolation" (default: on)
- Status row: "Voice profile: enrolled (Apr 7, 2026)" + "Re-enroll" button
- Status row (alt): "Voice profile: not enrolled" + "Set up now" button
- **Diagnostics** sub-section (per OQ-2): median frame processing time, active
  speaker flips/min, CPU degrade trigger count, embedding broadcast success
  rate, last 10 errors. All client-local, never transmitted.
- Advanced: model version, manifest age, "Clear voice profile" (destructive)
- Privacy disclosure: "Where does this go?" expandable explainer

**2. Voice channel join — first-time enrollment modal**
- New component: `client/src/components/VoiceEnrollment/VoiceEnrollment.tsx`
- Shown when user joins voice without an embedding
- Steps: permission prompt → sample script + waveform → capture → processing
  spinner → done → proceed into the call
- Cancel leaves the channel
- Per OQ-1: if model download is incomplete, the user can proceed with a
  warning ("Voice isolation is loading — you'll get the upgrade when it's
  ready"); enrollment is deferred until models are ready

**3. VoiceControls badge** (existing file: `client/src/components/VoiceControls/`)
- New small icon next to mute/deafen
- Tooltip: "4/6 voices isolated · 2 fallback"
- Click: opens a popover showing per-peer enrollment + tier + model status
- Color: brand teal when ≥80% peers enrolled, muted when <80%
- Hidden when call has only one person

**4. ChannelList voice peer rows** (existing file: `client/src/components/ChannelList/`)
- Subtle dot on the avatar of unenrolled peers in the voice user list
- Low-priority polish

### Error handling — failure modes table

| Failure | Severity | Behavior |
|---|---|---|
| Model fails to download (network error) | Hard | Toast: "Voice features unavailable — couldn't load processing models". Retry from Settings. Pass-through mode active. |
| Model fails checksum validation | Hard | Refuse to load. Same toast as above. Log security warning to local diagnostics. |
| WASM module fails to instantiate (browser too old, no SIMD) | Hard | Detect at load time. Toast: "Your browser doesn't support voice isolation. Voice still works." Pass-through. |
| AudioWorklet not supported (very old browser) | Hard | Same as above — pass-through. |
| Enrollment recording too quiet / clipped / not enough speech | Soft | Inline error in modal, prompt to retry. |
| Enrollment ECAPA inference failure | Soft | Same as above. |
| User cancels enrollment | UX | Leave the voice channel. Toast: "Voice profile required to use voice features." |
| Slow connection — model download not finished when user tries to join voice | UX (OQ-1) | Allow joining with warning. Background download continues. Feature activates when ready. |
| Embedding broadcast fails (Signal session error) | Soft | Local processing still works (you sound clean to yourself). Surface in badge. Background retry. |
| Peer has no embedding (legacy client / not enrolled / slow connection) | Soft | Their stream uses DFN3 fallback. Badge reflects it. Not an error. |
| Peer's embedding fails Ed25519 signature verification | Hard | Reject the embedding. Fall back to DFN3 for that peer. Log security warning. Show in badge as "1 unverified". |
| Active-speaker model switch fails mid-call | Soft | Keep the previous model running. Log warning. Try again on next switch. |
| CPU can't keep up (frame deadline missed > 5x in 10s) | Hard | Auto-degrade: switch all "background" peers to pass-through, keep only the top-1 active speaker on VFL. Surface warning in badge. Increment local diagnostic counter. |
| Re-enrollment after model upgrade is required | UX (OQ-4) | Modal on next call: "Voice models updated — please re-enroll your profile (15s)". Skipping is allowed; falls back to DFN3 until re-enrolled. |
| User changes identity (logout/login) | Cleanup | Embeddings are per-identity. Switching identities loads (or prompts to enroll) the new identity's embedding. Previous embeddings remain in storage, encrypted under the previous identity's key. |
| Embedding decryption fails (corrupt local store) | Hard | Treat as not enrolled. Prompt to re-enroll. |
| Total model failure (no models loadable at all) | Hard (OQ-3) | Pass-through with warning. Voice still works. Status: "Voice isolation unavailable". |

### Privacy notes folded into the UX

- Enrollment modal contains a "Where does this go?" expandable: "Your voice
  profile is a 1KB mathematical fingerprint, never the audio itself. It's
  encrypted on your device, encrypted again when shared with call participants,
  and never leaves the home server's federation layer. You can delete it at
  any time."
- Settings has a "Clear voice profile" destructive button that also broadcasts
  a `VoiceEmbeddingRevoke` event so peers stop using your old embedding
  immediately.
- A new entry in the existing privacy/data-export tooling exposes the
  embedding for download (GDPR right of access).
- The diagnostics counters are *clearly labeled local-only* in the UI to
  prevent confusion with cloud telemetry that this app explicitly does not do.

### Biometric threat model

A 256-d ECAPA embedding is, technically and legally, **biometric data**
(GDPR Article 9, "biometric data for the purpose of uniquely identifying a
natural person"). It is small (1 KB) and persistent (someone's voice doesn't
change much) and could in principle be used to:
- Re-identify the user across other Dilla servers
- Match against any other audio the holder gets their hands on
- Train downstream voice-recognition systems (off-platform)

The system architecture mitigates the *transport* threats (Signal encryption,
Ed25519 signatures, federation downgrade detection) but it cannot solve the
*custody* problem: **once an embedding is shared with a peer, that peer can
keep it forever**. Revocation (`VoiceEmbeddingRevoke`) is a soft social
contract — it tells well-behaved peers to forget the embedding, but a
malicious peer simply ignores the revoke and keeps the cached ciphertext
they already decrypted.

This is a fundamental property of biometric sharing protocols, not specific
to our design. The user must be told this, in plain language, before they
enroll.

**The enrollment modal's "Where does this go?" section is required to say:**

> "Your voice profile is a small mathematical fingerprint of how your voice
> sounds. It is encrypted on this device and encrypted again when shared
> with people you talk to in voice channels. They can use it to make your
> voice sound clear in noisy environments.
>
> **Once shared, you cannot take it back.** People you've talked to may
> keep a copy of your voice profile even after you delete yours. We send a
> 'forget this profile' message when you delete, but we can't enforce it.
>
> If you change your mind: you can delete your profile, you can re-enroll
> to create a new one, and your old profile will eventually be replaced
> for everyone you talk to. But the *original* profile is, in practice,
> with everyone who's ever heard your voice in a Dilla call."

**Mitigations explored and rejected for v1:**
- *Per-channel embeddings* (rotate per channel for unlinkability) — would
  require re-running ECAPA on enrollment audio per channel join, and would
  produce noticeably worse VFL output quality because each instance is a
  weaker signal. Rejected.
- *Per-session embeddings* (rotate per call) — same problem, larger.
- *Server-stored, client-fetched on demand* — would centralize biometric
  data on the home server, breaking E2EE for the embedding even though the
  audio remains end-to-end encrypted. Rejected.

**Phase 2 may revisit** privacy-preserving alternatives (e.g., conditioning
the model on a homomorphic-encrypted embedding so peers can use it without
ever seeing the plaintext fingerprint). This is research-grade work and is
out of Phase 1/2 engineering scope.

---

## Server-side changes

### New Rust files
- `server-rs/src/api/voice.rs::models_manifest()` — returns the manifest JSON
- `server-rs/src/api/voice.rs::models_serve()` — serves individual `.onnx` files
  via `rust-embed` from `server-rs/assets/voice-models/`
- `server-rs/assets/voice-models/manifest.json` — generated at build time from
  the directory contents (build script computes SHA-256 of each file)
- `server-rs/assets/voice-models/vfl-v1.onnx` (~5MB) — **stored via Git LFS**
- `server-rs/assets/voice-models/ecapa-v1.onnx` (~6MB) — **stored via Git LFS**
- `server-rs/assets/voice-models/dfn3-v1.onnx` (~2MB) — **stored via Git LFS**

**Model storage decision:** the model weights are committed to the repository
via Git LFS rather than fetched at build time. Reasons:
- Self-hosted deployments don't need external network access at build time
- Reproducible builds — same commit always produces the same server binary
- `rust-embed` works with the file paths directly; no extra build-time
  fetch step needed
- Git LFS is a one-time setup cost (~13 MB delta on clone, paid once)

`.gitattributes` will be updated to mark `server-rs/assets/voice-models/*.onnx`
as LFS-tracked. The manifest schema includes a `minClientVersion` field
(currently always `0`) reserved for Phase 2 milestone 12's compatibility
range support — adding the field now costs nothing and avoids a manifest
migration later.

### Modified Rust files
- `server-rs/src/ws/events.rs` — three new event types
  (`VoiceEmbeddingPublish`, `VoiceEmbeddingReceived`, `VoiceEmbeddingRevoke`)
- `server-rs/src/ws/handlers/voice.rs` — relay logic for the new events,
  enforces channel-membership check, no ciphertext inspection
- `server-rs/src/api/mod.rs` — register the new routes
- `server-rs/src/main.rs` (or wherever response middleware lives) — set
  COOP/COEP headers for client routes only
- `server-rs/build.rs` — compute checksums and emit `manifest.json`

### Federation
- The new WS events flow through the existing federation transport with no
  changes needed. Embeddings are opaque ciphertext to the server, just like
  messages. A federated server that doesn't know about
  `VoiceEmbeddingPublish` simply doesn't relay it; the local client sees the
  peer as "no embedding" and falls back to DFN3 — graceful degradation.
- **Downgrade-attack mitigation:** A malicious or buggy federated server can
  silently drop or strip embedding events to force all cross-server peers
  into DFN3 fallback. Because DFN3 is silent degradation, the user has no
  natural way to detect this. We address this in two layers:
  1. The dispatcher exposes per-peer state in the VoiceControls badge,
     including a distinct "federated server may not support voice isolation"
     status (peer is on `homeserver != ourserver` AND has no embedding) vs.
     "peer hasn't enrolled" (peer is on our homeserver AND has no embedding).
     Each tells a different story to the user.
  2. The Ed25519 signature includes `channelId`, so a server that re-targets
     a published embedding to a different channel produces an invalid
     signature on receive — the recipient logs it and falls back, surfacing
     the failure as "1 unverified" in the badge.

---

## Testing Strategy

### Layer 1: Pure unit tests (vitest, jsdom — fast, run on every commit)

| Module | What's tested |
|---|---|
| `modelLoader` | Manifest parsing, SHA-256 validation, IndexedDB cache hit/miss, error paths (404, checksum mismatch, malformed JSON, version drift). Mocks `fetch` and the Cache API. |
| `embeddingStore` | get/set/clear/listAll, HKDF derivation correctness with a mocked MEK, AES-GCM round-trip, identity isolation (different `info=identityId` produces non-overlapping keys), corruption handling, IndexedDB-unavailable fallback. |
| `embeddingTransport` | Payload construction (all fields including `senderSequence`, `channelId`, `recipientUserId`), Signal envelope wrapping (mocked), Ed25519 signature verification covering all bound fields, the three-rule acceptance algorithm (captureId match, sequence-monotonic accept, replay reject), broadcast fan-out (one event per peer), revocation handling. |
| `enrollment` | Audio buffer validation (silence detection, clipping detection, speech-frame ratio), the retry-loop state machine. Inference is injected; tests use a fake encoder that returns a fixed embedding. |
| `dispatcher` | Tier transitions delivered via `activeSpeakerTracker.onTierChange` callback, model selection logic, peer join/leave handling, embedding-arrival-after-call-start case, the read-only state snapshot for UI, CPU-degrade trigger. Pipeline and tracker are both mocked. |
| `activeSpeakerTracker` | Polling cadence, band-limited RMS computation correctness on synthetic spectrograms, rolling window math, tie-breaking, hysteresis edge cases, top-N selection, cold-start policy (first 500ms = all background), `attachPeer`/`detachPeer` lifecycle. AnalyserNode is mocked with a fake that returns scripted frequency data. |

Target: ~95% line coverage on these modules. Roughly 80 tests across 6 files.

### Layer 2: AudioWorklet integration tests (vitest browser mode — Playwright runner)

The `pipeline.ts` module talks to `AudioWorkletNode` and the WASM module,
neither of which exist in jsdom. We use Vitest's browser mode (already set up
in this repo for other browser tests) to:

| Test | What it verifies |
|---|---|
| Worklet registration | The processor registers without errors in a real Web Audio context |
| WASM instantiation | The bundled WASM loads, exports the expected functions, runs `process()` on a known input and produces non-NaN output |
| Frame buffering | Feeding 480-sample frames at 48 kHz produces correctly-sized output frames |
| Model swap mid-stream | `switchModel()` on a running pipeline doesn't drop frames or produce audible discontinuity (measured by output continuity) |
| End-to-end latency | A timestamp-marked input frame is observed at the output ≤ 50ms later (real Web Audio time) |
| Pass-through fallback | When no model is loaded, output equals input within float epsilon |

About 15 browser-mode tests. Synthetic input via `ConstantSourceNode` for
reproducibility.

### Layer 3: Model quality regression tests (offline, nightly only)

Catches "did the model still work after we tweaked WASM build flags". Not run
on every commit.

| Test | What it verifies |
|---|---|
| ECAPA reproducibility | Given a known WAV, ECAPA produces an embedding within cosine distance ε of the reference |
| ECAPA speaker discrimination | Two known speakers → embeddings at distance > threshold; same speaker different recordings → distance < threshold |
| VoiceFilter-Lite quality | Given a noisy WAV, cleaned output has SNR ≥ baseline_snr - 0.5dB |
| VFL conditioning | Same noisy input with two different embeddings produces measurably different outputs (sanity check) |
| DFN3 SNR floor | DFN3 alone improves a noisy WAV by ≥ 8dB SNR |
| Model loader integrity | Bundled `.onnx` files match the manifest's SHA-256 (catches build pipeline corruption) |

`client/test/voice-fixtures/` holds ~10 small WAV files (each ~3s, ~2MB total
committed) covering: clean speech, babble, music interference, two-speaker
overlap, keyboard, traffic. Reference embeddings committed alongside.

### Layer 4: End-to-end voice channel tests (Playwright, Tauri windows)

Two real browsers in two Tauri windows joining the same voice channel on a
local Dilla server.

| Test | What it verifies |
|---|---|
| Two-peer enrollment + symmetric processing | Both peers enroll, both join, both broadcasts arrive, both pipelines run VFL |
| Mid-call peer join | A in call, B joins later, B's embedding received, A's pipeline switches B from "no embedding" to VFL |
| Active-speaker promotion | A speaks, then B speaks, dispatcher promotes B and demotes A |
| Embedding revocation | A clears profile, revoke broadcast, B's pipeline falls back to DFN3 for A |
| Legacy peer fallback | Peer connects with the plugin disabled (feature flag) — treated as no-embedding, DFN3 fallback, no errors |
| Federation across two servers | Peer A on server-1, peer B on server-2, voice channel federation, embedding crosses federation boundary |
| Model upgrade re-enrollment prompt | Server bumps manifest version → next voice join shows re-enroll prompt |
| CPU degrade fallback | Synthetic CPU pressure → all background peers drop to pass-through, top-1 retains VFL |
| SFrame interop | Two peers with both pipelines + SFrame; sender's audio passes through `processOutgoing` → SFrame encrypt → SFU → SFrame decrypt → `processIncoming` → output. Verify: (a) audio is intelligible at the receiver, (b) SFrame metadata in the encrypted RTP frames is structurally intact, (c) no double-processing artifacts |

About 9 E2E tests. Slow (~30s each) but they're the ones that catch real bugs.

### Test data & fixtures
- `client/test/voice-fixtures/` — ~2MB of small WAV samples committed
- `scripts/fetch-test-models.sh` — downloads the actual `.onnx` files for
  local + CI use, with checksums (models too large to commit)
- Reference embeddings JSON committed alongside fixtures

### What we explicitly don't test
- **Krisp comparison** — no A/B against the actual product. Quality is pinned
  to the model's pretrained baseline; any "as good as Krisp?" judgment is
  manual subjective listening during development
- **CPU performance benchmarks in CI** — too noisy across runners. Local
  benchmarks via `npm run bench:voice`; CI just verifies frame deadlines
- **Cross-browser WebRTC quirks** — covered by existing voice channel tests

---

## Implementation Milestones

These are the build sequence (the writing-plans skill will turn each into
ordered steps with file lists):

**0. Spike — model availability & latency (gates everything)**

Before any production code: a hands-on spike that answers two unresolved
feasibility questions. Output: a written go/no-go memo committed to
`docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md`.

  - **0a. VoiceFilter-Lite ONNX availability:** find a publicly downloadable
    VFL or VFL-equivalent ONNX checkpoint with a permissive license. Verify
    it loads in ORT Web. Run it on three of our planned fixture WAVs and
    compare SNR improvement to the unprocessed baseline. **Pass criterion:**
    a specific named checkpoint exists (URL + license + author + checksum
    written into the memo) and produces ≥6dB SNR improvement on a noisy
    target-speaker fixture. **Fail behavior:** evaluate alternatives in this
    order: (i) DTLN-aec ONNX (Helmholtz-DTLN, MIT-licensed), (ii)
    NSNet2-personalized, (iii) personalized DeepFilterNet variant if any
    community port exists, (iv) commit to the parallel research workstream
    earlier. Update the spec decision log row 3 with the actual chosen
    model.
  - **0b. WASM SIMD latency on representative hardware:** measure
    per-frame inference time for the chosen VFL-equivalent on (i) M1 MacBook
    Air, (ii) a 5-year-old Intel laptop (e.g., a 2019 ThinkPad). Run inside
    a real Web Worker with ORT Web SIMD, not a microbenchmark. **Pass
    criterion:** p95 per-frame time < 25ms on M1 AND < 60ms on the Intel
    target. **Fail behavior** (in order of preference): (i) drop top-N from
    2 to 1 — Phase 1 ships with single-active-speaker VFL only, others get
    DFN3; (ii) auto-degrade slow hardware to DFN3-only with the situation
    surfaced in the diagnostics UI. **Pulling WebGPU acceleration into
    Phase 1 is explicitly NOT a valid fail-mitigation** — see the Phase 2
    milestone 11 note. WebGPU stays in Phase 2; Phase 1 must be shippable
    with the WASM-only fallback hierarchy.
  - **0c. ECAPA-TDNN ONNX export verification:** confirm SpeechBrain's
    ECAPA-TDNN ONNX export works in ORT Web on a known-speaker fixture.
    This is much lower-risk than 0a (the SpeechBrain export is well-known)
    but it still has to be tested rather than assumed.

  Total spike effort: ~1 week. **All later milestones are blocked on a
  passing spike.**

1. **Foundation** — `modelLoader`, `embeddingStore` (HKDF-derived blob store),
   COOP/COEP headers (scoped to client routes), server manifest endpoint,
   model artifacts in repo (or LFS — see issue 14), build-time checksum
   script, SFrame integration verification (confirm voice isolation seam
   doesn't conflict with existing `voiceEncryption.ts` layer).
2. **Enrollment vertical slice** — `enrollment.ts` + `VoiceEnrollment.tsx` +
   Settings integration. End state: a user can enroll, the embedding is
   stored, you can see it in Settings. No call integration yet.
3. **Pipeline + Worker + ring buffer** — `pipeline.ts`, `inferenceWorker.ts`,
   `audioWorklet/ringBufferProcessor.js`, the SAB ring protocol, ORT Web
   session loading inside the worker. **Includes the latency benchmark gate
   from the spike** as a CI test (`npm run bench:voice` run nightly). End
   state: a unit test pipes a WAV file through worklet → SAB → worker →
   SAB → worklet and gets cleaned audio at acceptable latency.
4. **Single-stream outgoing** — wire `pipeline` into `WebRTCService.ts`
   outgoing only, no symmetric yet, no broadcast yet. Confirms the seam
   sits correctly relative to `voiceEncryption.ts`. End state: your own mic
   is processed before going to peers. Tests verify it.
5. **Embedding broadcast** — `embeddingTransport`, server WS event types,
   Signal encryption integration. Includes the new replay-rejection rule
   based on `senderSequence`. End state: embeddings flow between peers
   with valid signatures bound to channel + recipient.
6. **Symmetric incoming** — `dispatcher` orchestration, incoming pipeline,
   model selection. End state: every peer's audio is processed.
7. **Active-speaker tiering** — `activeSpeakerTracker` (client-side
   AnalyserNode-based, no SFU dependency), dynamic model swap via
   worker messages. Includes cold-start policy (first 500ms = all
   background tier). End state: only top-N get VFL, rest get DFN3.
8. **UX polish** — VoiceControls badge with federation-distinguishing
   states, error toasts, fallback handling, local diagnostics counters
   (OQ-2 — exact counter list defined in this milestone).
9. **Federation E2E** — verify embeddings cross federation boundary;
   verify downgrade-attack visibility in the badge; add the E2E test for
   it. Add SFrame interop test (Layer 4) confirming the pipeline doesn't
   corrupt encrypted-frame metadata.
10. **Quality regression suite** — Layer 3 tests with reference WAVs.

End of Phase 1. Phase 2 picks up here:

---

## Phase 2 (in scope, scheduled after Phase 1 completion)

These are pulled in as committed scope per the brainstorming session, not
deferred to a separate spec.

### Phase 2 milestones

11. **WebGPU acceleration** — Detect WebGPU support; compile a WebGPU-backed
    inference path for VFL and ECAPA via ONNX Runtime Web's WebGPU backend.
    Fall back to WASM SIMD where unavailable. Significantly reduces CPU usage
    on supported hardware. Maintains the same `ModelHandle` interface — no
    pipeline changes.

    **Note:** Phase 1's risk #1 explicitly does NOT pull this milestone
    forward as a "fix" for failing latency. Phase 1 is shippable as a
    self-contained unit even without WebGPU — its fallback hierarchy
    (top-N → 1, drop low-end hardware to DFN3-only, surface in
    diagnostics) does not depend on Phase 2 capabilities. WebGPU is a
    quality-of-life upgrade, not a Phase 1 emergency exit.

12. **Per-server model versioning** — Promote `modelLoader` from "version 1
    only" to true version negotiation. The server's manifest endpoint accepts
    `?client_version=N`. The client requests the highest manifest version it
    supports. Embeddings tagged with both `modelVersion` and a compatibility
    range so peers on different versions can still interoperate (each peer
    runs its own version, they just need to agree on the embedding format
    enough to convert if needed).

13. **Custom enrollment scripts** — Replace the single sample script with a
    library of curated phrases optimized for ECAPA's training distribution.
    Surface as a dropdown in the enrollment modal. Capture multiple phrases
    and average their embeddings for higher quality. Increases first-time
    enrollment from ~15s to ~45s but produces a noticeably better embedding.

14. **Multi-device profile sync** — Currently each device enrolls separately
    for the same identity. In Phase 2, the embedding (encrypted under the
    identity's master key) is published to the user's prekey bundle so other
    devices using the same identity can fetch and use it. Re-enrollment on
    device A propagates to device B at the next sync.

15. **A/B comparison UI** — Settings → Audio → "Test my voice" button. Records
    a 5-second sample, plays it back unprocessed, then plays the
    VFL-conditioned version. Lets the user hear what isolation is doing on
    their hardware. Useful both for debugging and for marketing the feature.

16. **System-level virtual audio device** — The big one. A
    Tauri-side native Rust component creates a system-level virtual microphone
    using:
    - macOS: CoreAudio AudioServerPlugIn (`HAL` plugin model)
    - Windows: WASAPI virtual audio capture device
    - Linux: ALSA loopback or PipeWire virtual source

    The user's real mic is captured in Rust, processed natively (no
    AudioWorklet, no WASM, no SharedArrayBuffer overhead), and exposed to the
    OS as `Dilla Voice Focus`. Selecting it as the input device in **any
    application** (Zoom, Discord, browser tab, OBS) gives that app
    Dilla-quality voice isolation.

    This is a separate codebase, distinct from the AudioWorklet path. Phase 1
    code is unaffected. Comes with significant complexity:
    - Per-platform audio driver development
    - Code signing requirements (macOS notarization, Windows driver signing)
    - Installation flow that requires admin/elevated privileges
    - Self-update path for the driver itself

    Phase 2 commits to building it; the success criteria is "the virtual
    device exists, processes audio, and can be selected in third-party apps
    on at least one platform". Follow-on platforms are subsequent work.

### Parallel research workstream — train our own model

This is structurally different from the engineering items above. It's an ML
research project with its own success criteria, timeline, and risks. It runs
**in parallel** with Phase 1 and Phase 2 implementation, not as a blocker.

**Goals:**
- Train a custom personalized speech enhancement model that improves on
  VoiceFilter-Lite for our specific use case (call-quality voice + Western
  language phoneme set + 48 kHz native)
- Export to ONNX
- Match the existing `ModelHandle` interface so it can be slotted into the
  pipeline by bumping the model manifest version

**Required (out of scope for this spec to detail):**
- Dataset curation (speech corpora, noise corpora, mixing strategies)
- GPU compute infrastructure
- Training pipeline (likely PyTorch + ONNX export)
- Quality evaluation harness comparing against VFL on our fixture set
- A separate spec, with its own brainstorming session, before any work begins

**Why it's in this spec at all:** committing to building it eventually means
the engineering decisions in Phase 1 / Phase 2 should leave room for it. The
`ModelHandle` interface is deliberately model-agnostic. The manifest format
supports multiple model entries. The pipeline accepts any WASM module that
exports the right symbols. None of this is wasted effort if we never train
our own — and all of it is necessary if we do.

---

## Risks and Open Items

### Risks called out for the implementation phase

1. **WASM SIMD performance might be insufficient for top-N=2 in larger calls.**
   Claim: ~17ms per VFL frame on M1 with WASM SIMD inside a Web Worker. Not
   yet benchmarked. The latency budget computation under "High-Level
   Architecture" shows that a single inference Worker can't handle a 6-person
   call at top-N=2 — the design relies on a Worker pool of size
   `min(hardwareConcurrency - 1, 6)`. If the per-frame time is significantly
   higher than 17ms on the low-end target, the pool can't compensate.
   **Mitigation:** Spike milestone 0b is the explicit gate. Pass criterion is
   numerical (p95 < 25ms M1, < 60ms 5-year-old Intel). If it fails, the
   fallback hierarchy is documented in the spike section.

2. **VoiceFilter-Lite as an ONNX model may not exist publicly.** Google's
   original VFL paper does not release weights. "Community ONNX exports" was
   hand-wavy in the v1 of this spec; it is now an explicit spike output
   (milestone 0a). If no usable VFL checkpoint passes the spike, we evaluate
   alternatives in the order: DTLN-aec → NSNet2-personalized → community
   personalized DFN variant → research workstream. Phase 1 cannot start until
   a specific named model passes spike 0a.

3. **AudioWorklet + SharedArrayBuffer requires cross-origin isolation.**
   Setting COOP/COEP headers globally on the Dilla server may break embedded
   third-party content. **Mitigation:** scope the headers to client routes
   only; verify nothing else breaks.

4. **Signal session might not exist when embedding broadcast happens.** Signal
   sessions are per-pair. In a fresh voice channel with strangers, we need
   on-demand session establishment before publish. **Mitigation:** existing
   message-send flow already handles this exact case; embedding transport
   piggybacks on it.

5. **Model size on first download is ~12MB.** Over a slow mobile connection
   that's 30+ seconds. **Mitigation:** chunked download with progress events,
   IndexedDB cache, OQ-1 escape hatch (proceed with warning, background-load).

6. **iOS Safari does not implement AudioWorklet's full transferable spec.**
   If we ever want this on iOS Safari (web build, not Tauri), we need to
   verify SharedArrayBuffer + COOP/COEP work there. **Mitigation:** non-blocking
   for v1; Dilla's primary target is Tauri desktop. iOS Safari is best-effort.

7. **(Phase 2)** **Native audio driver signing is platform-specific and
   expensive.** Apple notarization, Windows driver signing certificates,
   per-platform packaging. **Mitigation:** Phase 2 milestone 16's success
   criteria is "at least one platform"; we don't commit to all three at once.

8. **(Research workstream)** **Training a personalized speech enhancement
   model is a real ML research project.** Months of work, GPU compute costs,
   dataset licensing concerns. **Mitigation:** structured as a parallel
   workstream with its own spec; not a blocker for Phase 1 or Phase 2
   shipping.

---

## Out of Scope (will not be built, even in Phase 2)

- **Krisp SDK integration** — the whole point is to be open source
- **Cloud-side processing** — breaks E2EE
- **Proprietary model formats** — ONNX only
- **Telemetry sent off-device** — local diagnostics only
- **Any model that requires a paid license**
- **Voice clone defense** — embeddings are speaker fingerprints, not voice
  clones; this spec does not address adversarial voice synthesis
- **Real-time translation** — separate feature
- **Voice transformation / pitch shifting / accent modification** — separate
  feature
- **Server-side transcription** — separate feature, breaks E2EE if naive
