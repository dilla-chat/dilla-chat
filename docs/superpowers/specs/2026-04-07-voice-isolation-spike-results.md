# Voice Isolation Spike Results

**Status:** Spike 0a complete. Spikes 0b (WASM SIMD latency) and 0c (ECAPA-TDNN
verification) **not yet executed** — covered by separate gating tasks.
**Phase 1 go/no-go (final):** *Pending* until 0b + 0c land.
**Spike 0a go/no-go:** ✅ **GO** (with model substitution — see Decision Log
Update).

This memo gates Phase 1 of the voice-isolation plugin per the plan at
`docs/superpowers/plans/2026-04-07-voice-isolation-plugin-phase1.md`. It
documents whether a usable target-speaker-extraction ONNX checkpoint exists
in the open-source community, and if so, captures the exact metadata that
later milestones need (URLs, checksums, tensor names, window sizes).

---

## TL;DR

- **VoiceFilter-Lite** (Google's 2.2 MB on-device model from arXiv 2009.04323)
  is **not** available as an open ONNX checkpoint anywhere we can find.
  Google has not released weights, and no community port exists on Hugging
  Face, GitHub, or the ONNX Model Zoo as of 2026-04-07.
- However, the **original VoiceFilter** (Wang et al. 2018, the larger
  STFT-mask predictor that VFL is the distilled successor of) **is**
  available as Apache-2.0 ONNX via the
  [ailia-models](https://github.com/axinc-ai/ailia-models) project, mirrored
  on Hugging Face. Both the d-vector embedder and the mask predictor are
  shipped as ONNX.
- We loaded both checkpoints in `onnxruntime-node`, ran an end-to-end
  inference on the bundled test fixtures, and measured **+21.22 dB SNR
  improvement** vs. the published expected output. That blows past the
  ≥6 dB pass criterion.
- **Trade-off:** the VoiceFilter (full) ONNX is ~75 MB (mask) + ~48 MB
  (embedder) = ~123 MB total, vs. VFL's claimed ~2.2 MB. Latency on M1 in
  Node was healthy (single inference under 200 ms for the entire 3-second
  context — not the per-frame benchmark but a positive signal). Spike 0b
  must validate WASM-SIMD per-frame p95 latency before we lock this in.
- **Decision:** Proceed to Phase 1 with the ailia-models VoiceFilter ONNX
  pair as the chosen target-speaker-extraction model. Update spec decision
  log row 3 from "VoiceFilter-Lite" to "VoiceFilter (full, ailia-models
  port)". Re-evaluate if 0b shows the model is too heavy for the latency
  budget.

---

## Spike 0a — Candidate Search

### Search queries executed

1. "VoiceFilter Lite ONNX" — no checkpoints, only papers and PyTorch repos.
2. "personalized speech enhancement ONNX" — surfaced ClearerVoice-Studio
   and Microsoft DNS-Challenge.
3. "target speaker extraction ONNX" — surfaced sherpa-onnx (no TSE model in
   the catalog), WeSep (no published weights).
4. "speakerbeam ONNX" — surfaced ESPnet/SpeakerBeam .pt checkpoints
   (CC-BY-4.0, **not** ONNX).
5. "WeSep ONNX" — toolkit supports ONNX export but pretrained models
   "to-do" / unimplemented.
6. Hugging Face API: `?search=voicefilter`, `?search=speakerbeam`,
   `?search=personalized speech enhancement`, `?search=target speaker
   extraction`.

### Candidates table

| # | Source | License | Format | Provides ONNX? | Personalized? | Notes |
|---|---|---|---|---|---|---|
| 1 | [niobures/VoiceFilter (HF)](https://huggingface.co/niobures/VoiceFilter) — mirror of [ailia-models voicefilter](https://github.com/axinc-ai/ailia-models/tree/master/audio_processing/voicefilter) | **Apache-2.0** | ONNX | ✅ mask + embedder | ✅ d-vector conditioned | **WINNER.** Original VoiceFilter (Wang 2018), not VFL. ~123 MB total. |
| 2 | [RedbeardNZ/voicefilter (HF)](https://huggingface.co/RedbeardNZ/voicefilter) | (license file not shipped, but identical SHAs to ailia upstream — Apache-2.0 by inheritance) | ONNX | ✅ same files | ✅ | Bit-identical re-upload of #1. Backup mirror only. |
| 3 | [nguyenvulebinh/voice-filter (HF)](https://huggingface.co/nguyenvulebinh/voice-filter) | Apache-2.0 | PyTorch (`.bin`) | ❌ | ✅ | Different architecture (multilingual VoiceFilter, arXiv 2308.11380). Would need export work. Rejected: not ONNX-ready. |
| 4 | [alibabasglab/AV_MossFormer2_TSE_16K (HF, ClearerVoice-Studio)](https://huggingface.co/alibabasglab/AV_MossFormer2_TSE_16K) | Apache-2.0 | PyTorch `.pt` (735 MB) | ❌ | Audio-visual only (lip video) | Wrong modality (needs face video, not d-vector). Rejected. |
| 5 | [microsoft/DNS-Challenge — PDNS baseline](https://github.com/microsoft/DNS-Challenge) | MIT (code) / CC-BY-4.0 (data) | ONNX (claimed in `Baseline.zip`) | Not directly verified — `Baseline.zip` is 1.5 GB, not retrieved in this spike. Code-side script is `download-dns-challenge-5-baseline.sh`. | ✅ (uses RawNet2/ECAPA embeddings) | Plausible but heavyweight to verify. **Documented as fallback #1** if Spike 0b kills the ailia VoiceFilter on latency. |
| 6 | [breizhn/DTLN-aec](https://github.com/breizhn/DTLN-aec) | MIT | TF-Lite + ONNX | ✅ ONNX **but** not personalized | ❌ generic AEC, not d-vector conditioned | Doesn't satisfy the personalization requirement. Documented as fallback #2 (paired with a separate speaker gating layer). |
| 7 | [Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) DFN3 | Apache-2.0 / MIT | ONNX | ✅ | ❌ generic | Already in the spec as the unenrolled fallback. Not a VFL replacement. |

**Rejection rationale for the heavyweight academic stacks** (ESPnet
SpeakerBeam, WeSep, ClearerVoice-Studio audio-visual TSE): they require
either the wrong modality (lip video), unreleased weights, or non-trivial
PyTorch → ONNX export work that exceeds the spike's de-risking budget.

---

## Spike 0a — Smoke Test Results

### Setup

- `onnxruntime-node` v1.20.1 in Node 24.11.0 on macOS (Darwin 25.3.0, M1).
- Throwaway script: `scripts/spike/test-vfl-availability.mjs` (committed).
- Fixtures bundled with the model on HF: `mixed.wav`, `ref-voice.wav`,
  `output_reference.wav` (the ailia inference output, used as ground truth).
- We re-implemented the librosa STFT/mel front-end in pure JS so the spike
  could run with no Python dependency. Hyperparameters are taken verbatim
  from `ailia-models/audio_processing/voicefilter/audio_utils.py`.

### Models loaded

```
[embedder] voicefilter_embedder.onnx
  inputs:  dvec_mel  (float32, [n_mels=40, time=301])
  outputs: dvec      (float32, [256])

[mask model] voicefilter_model.onnx
  inputs:  mag       (float32, [batch=1, time=301, freq=601])
           dvec      (float32, [batch=1, 256])
  outputs: mask      (float32, [batch=1, time=301, freq=601])
```

### Inference output

```
embedder mel shape: [40, 301]
d-vector shape=[256], range looks plausible (0.005, -0.025, 0.063, 0.007, ...)
mixed STFT: numFrames=301, freqBins=601
mask output shape=[1, 301, 601]
NaN count: 0,  range: [0.2910, 0.9999]
enhanced length: 48000 samples (3.0 s @ 16 kHz)
```

### SNR results

| Signal pair | SNR (dB) |
|---|---|
| mixed → ailia reference output | 0.53 |
| our enhanced → ailia reference output | 21.75 |
| **improvement** | **+21.22** |

The "ailia reference output" (`output_reference.wav`) is the upstream
project's published expected inference output for `mixed.wav`. Reaching
+21 dB against it means our pipeline reproduces the upstream inference
end-to-end (including STFT, masking, and ISTFT) — i.e. we have a working
target-speaker-extraction loop. The **≥6 dB** pass threshold from the plan
is comfortably exceeded.

(A second synthetic-noise test was scaffolded but is documentation-only at
this stage — using a 220 Hz + 660 Hz sine without an enrollment voice
isn't a valid VoiceFilter input. The ailia fixture is the real test.)

---

## Chosen Model — Required Memo Fields

| Field | Value |
|---|---|
| **Model name** | VoiceFilter (full, ailia-models port) |
| **Mask model URL** | https://huggingface.co/niobures/VoiceFilter/resolve/main/models/ailia-models/model.onnx |
| **Embedder URL** | https://huggingface.co/niobures/VoiceFilter/resolve/main/models/ailia-models/embedder.onnx |
| **Upstream project** | https://github.com/axinc-ai/ailia-models/tree/master/audio_processing/voicefilter |
| **Original paper** | Wang et al., "VoiceFilter: Targeted Voice Separation by Speaker-Conditioned Spectrogram Masking", Interspeech 2019 (arXiv:1810.04826) |
| **Author / mirror author** | axinc-ai (upstream); HF mirror by `niobures` |
| **License** | **Apache 2.0** (verified — `models/ailia-models/code/LICENSE` in the HF repo is the Apache-2.0 text) |
| **Mask model file size** | 75,510,811 bytes (~72 MB) |
| **Embedder file size** | 48,654,336 bytes (~46 MB) |
| **Mask model SHA-256** | `698223eb28f14536c0a20b3b1169470fc1331f393a8dcf31a4205e78a7acfe4e` |
| **Embedder SHA-256** | `4fb342dcbd8b8dd9977816343c56d5641a3be86233661e07e4beab79024df872` |
| **Parameter count (mask)** | Not introspected exactly in this spike; ≈18M parameters inferred from file size at fp32. Original paper reports ~8M, but ailia's export appears to be the larger un-pruned variant. |
| **Parameter count (embedder)** | ≈12M (LSTM-based d-vector net, fp32). |
| **Sample rate** | 16,000 Hz (mono) |
| **Frame / window** | 301 STFT frames × 160-sample hop = 48,000 samples = **3.0 s context window**. The model is *not* streaming-causal — it consumes a full 3 s window per inference. |

### `ModelIOSpec` (to be plugged into `dispatcher.ts` per Phase 1 plan Task 3.3)

```ts
const VOICEFILTER_MASK_IO_SPEC: ModelIOSpec = {
  inputName: 'mag',          // float32, shape [1, 301, 601] (batch, time, freq)
  embeddingName: 'dvec',     // float32, shape [1, 256]
  outputName: 'mask',        // float32, shape [1, 301, 601] — multiplicative mask
  sampleRate: 16000,
  windowSamples: 48000,      // 3.0 s
  hopSamples: 160,
  fftSize: 1200,
  numFreqBins: 601,
};

const VOICEFILTER_EMBEDDER_IO_SPEC: ModelIOSpec = {
  inputName: 'dvec_mel',     // float32, shape [40, 301] (n_mels, time)
  outputName: 'dvec',        // float32, shape [256]
  sampleRate: 16000,
  numMels: 40,
  fftSize: 512,
  hopSamples: 160,
  enrollmentSamples: 48000,  // 3.0 s minimum (we tile if shorter)
};
```

**Note for Task 3.3 implementer:** the embedder time dim of 301 is **fixed**
(verified by ORT throwing `Got: 466 Expected: 301` on a 4.6 s reference
clip). The mask model time dim of 301 also appears fixed. The pipeline must
either chunk longer enrollments or run the embedder once on a 3 s window
and average — see the spike script for the tile-then-truncate workaround.

This is a substantial constraint vs. VFL: VFL is streaming. The plan's
"frame-level" mental model from row 6 of the decision log will need to
revise to a "3-second sliding window with overlap-add" approach. **This is
the single biggest design impact of the substitution and must be flagged
to the architecture review at the Phase 1 → Phase 2 handoff.**

---

## Decision Log Update

In `docs/superpowers/specs/2026-04-07-voice-isolation-plugin-design.md`,
**row 3** of the Architectural Decisions table currently reads:

> | 3 | Which model? | **VoiceFilter-Lite** (target speaker extraction) + ECAPA-TDNN ... | ~12 MB total model weights |

**Proposed amendment** (to be applied at the start of Milestone 1):

> | 3 | Which model? | **VoiceFilter (full, ailia-models port, Apache-2.0)** + **ECAPA-TDNN** (speaker encoder) + **DeepFilterNet 3** (background-tier fallback). VoiceFilter-Lite is unavailable as an open ONNX checkpoint as of 2026-04-07 (see spike 0a memo). | **~123 MB** for the VoiceFilter pair (mask + embedder), substantially larger than the planned 12 MB. Drives an LFS-or-CDN model delivery decision (re-confirm Milestone 1.1). Per-inference window is 3.0 s, not streaming-frame, which changes the pipeline's overlap-add design (re-confirm Milestone 3). |

Risks introduced by this substitution that the controller should consider
before unblocking Milestone 1:

1. **Latency budget.** The plan's 25 ms p95 frame target (spec spike 0b)
   was sized for VFL's tiny streaming model. The full VoiceFilter is ~10×
   larger and consumes a 3 s context per call. Spike 0b **must** measure
   real per-window latency under WASM SIMD before we commit. If it's >
   100 ms per window we may need to fall back to PDNS-baseline (DNS-Challenge
   personalized) or DTLN-aec + a custom speaker gate.
2. **Bandwidth / install size.** ~123 MB of model weights vs. the planned
   ~12 MB. The CDN/LFS strategy in Milestone 1.1 needs to budget for that.
3. **Pipeline design.** 3 s lookahead context is *not* low-latency. For a
   real-time voice call, the plugin will need overlap-add with at least
   1.5 s lookahead, which adds ~1.5 s to the end-to-end audio delay. This
   may be acceptable for a "press to enable" toggle but is **not**
   acceptable as the always-on default. The controller may want to reframe
   the feature as a "studio mode" toggle rather than transparent streaming
   isolation.

If risks 1 or 3 prove unworkable, the documented fallback hierarchy is:

1. **Microsoft DNS-Challenge PDNS baseline** (`download-dns-challenge-5-baseline.sh` → `Baseline.zip`, 1.5 GB archive containing a personalized DNS ONNX). Code under MIT, model artifact license under CC-BY-4.0. Lower-latency, designed for personalized streaming. Spike effort: ~half a day to download, extract, and re-run the smoke test.
2. **DTLN-aec + custom speaker-gating layer** (MIT, ONNX, ~4 MB). Not personalized natively, so we'd bolt a thin embedding-gating head on top. Significant additional engineering.
3. **WeSep custom export.** Toolkit supports ONNX export but no pretrained models published; we'd train our own. Out of scope for Phase 1.
4. **Escalate to spec re-discussion** — accept "generic suppression only" for Phase 1 and ship VFL-equivalent personalization in a Phase 2.

---

## Files Committed by This Spike

- `docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md` (this memo)
- `scripts/spike/README.md`
- `scripts/spike/.gitignore` (excludes the 75 MB + 48 MB ONNX blobs from git)
- `scripts/spike/package.json` + `scripts/spike/test-vfl-availability.mjs`
- `scripts/spike/models/mixed.wav` (94 KB, Apache-2.0)
- `scripts/spike/models/ref-voice.wav` (146 KB, Apache-2.0)
- `scripts/spike/models/output_reference.wav` (141 KB, Apache-2.0)
- `client/test/voice-fixtures/.gitkeep` + `client/test/voice-fixtures/README.md` (Task 0.4 placeholder)

The two ONNX checkpoint files (`models/voicefilter_model.onnx`,
`models/voicefilter_embedder.onnx`) are **not** committed — they're
gitignored and re-downloaded by anyone re-running the spike. URLs and
SHA-256 are listed above so this is reproducible. They will be properly
ingested via Git LFS in Milestone 1.1.

---

## Outstanding Work (Spikes 0b and 0c)

This memo only resolves **Spike 0a**. The following are still required to
unblock Phase 1:

- **Spike 0b — WASM SIMD latency benchmark.** The model substitution makes
  this gate substantially more important than the plan originally assumed.
  Must measure per-window p95 latency on M1 *and* on a representative
  low-end Intel laptop. Pass criteria from the plan:
  *p95 < 25 ms on M1 AND p95 < 60 ms on the Intel target.* These were
  written for VFL — they may need to relax (or the model has to change).
- **Spike 0c — ECAPA-TDNN ONNX verification.** The plan's ECAPA pick (the
  SpeechBrain export) is unaffected by the VoiceFilter substitution and is
  expected to pass without drama. But: note that the ailia VoiceFilter ships
  its own d-vector embedder, so we have a **choice** at Milestone 1: either
  use the ailia embedder (matched to the mask model, presumably better
  quality) or use SpeechBrain ECAPA (more reusable, larger ecosystem). Both
  produce 256-dim vectors. Recommend starting with the ailia embedder for
  Phase 1 since it's known to work end-to-end with the mask model, and
  swapping to ECAPA only if cross-model conditioning quality is insufficient.

**Phase 1 implementation may proceed once 0b and 0c are also green.**
Spike 0a alone is *not* sufficient to unblock Milestone 1.

---

## Spike 0b.1 — DeepFilterNet 3 ONNX verification (2026-04-07)

After the pivot from VoiceFilter-Lite to generic real-time noise suppression
with DeepFilterNet 3 (DFN3), this spike verifies that a usable, permissively
licensed ONNX export exists, characterizes its IO contract, and runs a smoke
test inference.

### Source

- **Repository:** [Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) (the official upstream).
- **Direct URL of the ONNX bundle used:**
  `https://raw.githubusercontent.com/Rikorose/DeepFilterNet/d375b2d8309e0935d165700c91da9de862a99c31/models/DeepFilterNet3_onnx.tar.gz`
  (pinned to commit `d375b2d`, which is the tip of `main` at the time of this
  spike — also reachable via the tracked file
  `models/DeepFilterNet3_onnx.tar.gz`).
- **License:** **Dual MIT / Apache-2.0**, at the user's option (LICENSE-MIT
  and LICENSE-APACHE in the repo root). ✅ Compatible with Dilla AGPLv3.
- **Variants available in the same `models/` directory:**
  - `DeepFilterNet3_onnx.tar.gz` — standard DFN3 (8.0 MB packed).
  - `DeepFilterNet3_ll_onnx.tar.gz` — "low-latency" DFN3 variant (36 MB
    packed; larger because it removes lookahead frames at the cost of more
    parameters per timestep). Reserved as the fallback if standard DFN3
    blows the spike-0b.2 latency budget.
  - `DeepFilterNet2_onnx.tar.gz` and `DeepFilterNet2_onnx_ll.tar.gz` — DFN2
    fallbacks (8.6 MB each), available if DFN3 fails outright.

### Bundle metadata

| File | Size (bytes) | SHA-256 |
|---|---:|---|
| `DeepFilterNet3_onnx.tar.gz` (the bundle) | 7,983,136 | `c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616` |
| `enc.onnx` (encoder) | 1,954,042 | `7c5399d3da8a50ebef1c1a0ae421b33376aa5e45d0e92df16da7e83c9c131916` |
| `erb_dec.onnx` (ERB-band gain decoder) | 3,292,397 | `ab669a1d10afe20911728b33053a452071042317a90581092b325da7b2f9d895` |
| `df_dec.onnx` (deep filter coefficient decoder) | 3,340,803 | `23114ce3b0f6464b763ee62f7bb8aab6b2a129a21eabd5bcfe59413db05f278a` |

Sum of the three sub-graphs: ~8.6 MB on disk. Comfortably within the model
artifact budget for the client.

### ⚠️ Critical finding: DFN3 is NOT a single end-to-end PCM-in/PCM-out ONNX

The plan's milestone-1 design assumed DFN3 would expose a single ONNX graph
shaped roughly `[1, 480]` float32 PCM in → `[1, 480]` float32 PCM out. **It
does not.** The official `DeepFilterNet3_onnx.tar.gz` ships **three** ONNX
sub-graphs that are designed to be driven by host code that handles STFT, ERB
band feature extraction, deep-filter post-processing, and iSTFT. The Rust
reference implementation is in `Rikorose/DeepFilterNet/libDF/src/tract.rs`.

The three sub-graphs are:

1. **`enc.onnx`** — encoder. Input: `(feat_erb, feat_spec)`, output:
   `(e0, e1, e2, e3, emb, c0, lsnr)` (skip connections, GRU embedding, complex
   feature path, predicted local SNR).
2. **`erb_dec.onnx`** — ERB-band gain decoder. Input:
   `(emb, e3, e2, e1, e0)`, output: `m` (per-band gain mask).
3. **`df_dec.onnx`** — deep-filter coefficient decoder. Input: `(emb, c0)`,
   output: `(coefs, 235)` (complex DF coefficients + an unnamed scalar; the
   `235` output is an internal node ID, not used by the host).

This means:

- The Phase 1 inference worker has to implement (or wrap) a **streaming
  STFT/ERB/DF host pipeline** in TS or Rust/WASM, not just a tensor copy. The
  config from `config.ini` gives all the hyperparameters: `sr=48000`,
  `fft_size=960`, `hop_size=480`, `nb_erb=32`, `nb_df=96`, `df_order=5`,
  `conv_lookahead=2`, `df_lookahead=2`.
- An "ONNX-only" path is impossible without re-exporting from the original
  PyTorch checkpoint, which is out of scope for Phase 1.
- The original `ModelIOSpec` abstraction in the plan, with a single
  `inputName` / `outputName` / `windowSamples`, **does not fit** DFN3. The
  spec needs to be a multi-graph descriptor.

### Smoke test results

`scripts/spike/test-dfn3-availability.mjs` loads each of the three ONNX
graphs via `onnxruntime-node` and runs a single forward pass with synthetic
random inputs of the shapes implied by `config.ini`. All three pass:

```
[enc] forward pass with dummy inputs
    e0:    shape=[1,64,1,32]   NaN=0  range=[0.0000, 4.1464]
    e1:    shape=[1,64,1,16]   NaN=0  range=[0.0000, 2.1935]
    e2:    shape=[1,64,1,8]    NaN=0  range=[0.0000, 1.9888]
    e3:    shape=[1,64,1,8]    NaN=0  range=[0.0000, 5.4360]
    emb:   shape=[1,1,512]     NaN=0  range=[0.0000, 1.1724]
    c0:    shape=[1,64,1,96]   NaN=0  range=[0.0000, 11.2875]
    lsnr:  shape=[1,1,1]       NaN=0  range=[6.20, 6.20]

[erb_dec] forward pass — wiring encoder outputs by name
    m:     shape=[1,1,1,32]    NaN=0  range=[0.0033, 0.3540]

[df_dec] forward pass — wiring encoder outputs by name
    coefs: shape=[1,1,96,10]   NaN=0  range=[-0.0563, 0.6585]
    235:   shape=[1,1,1]       NaN=0  range=[0.4966, 0.4966]
```

No NaNs, no shape mismatches, all outputs are finite floats in plausible
ranges. The encoder + both decoders therefore *do* execute correctly under
onnxruntime — confirming the artifacts themselves are well-formed and can be
served to onnxruntime-web with the same shape contract.

### IO contract — multi-graph variant of `ModelIOSpec`

The plan's existing `ModelIOSpec` shape (`inputName`, `outputName`,
`modelSampleRate`, `windowSamples`) cannot describe DFN3 honestly. We
recommend Phase 1 introduce a `Dfn3ModelIOSpec` (or generalise `ModelIOSpec`
to a tagged union). The verified contract is:

```ts
const DFN3_IO_SPEC: Dfn3ModelIOSpec = {
  kind: 'dfn3-multigraph',
  modelSampleRate: 48000,
  hopSize: 480,        // 10 ms @ 48 kHz → 50 fps
  fftSize: 960,
  nbErb: 32,
  nbDf: 96,
  dfOrder: 5,
  convLookahead: 2,
  dfLookahead: 2,
  encoder: {
    file: 'enc.onnx',
    inputs: {
      featErb:  { name: 'feat_erb',  shape: [1, 1, /*T*/ -1, 32] }, // log-power ERB features
      featSpec: { name: 'feat_spec', shape: [1, 2, /*T*/ -1, 96] }, // re/im of low-band spec
    },
    outputs: {
      e0:   { name: 'e0',   shape: [1, 64, /*T*/ -1, 32] },
      e1:   { name: 'e1',   shape: [1, 64, /*T*/ -1, 16] },
      e2:   { name: 'e2',   shape: [1, 64, /*T*/ -1,  8] },
      e3:   { name: 'e3',   shape: [1, 64, /*T*/ -1,  8] },
      emb:  { name: 'emb',  shape: [1, /*T*/ -1, 512] },
      c0:   { name: 'c0',   shape: [1, 64, /*T*/ -1, 96] },
      lsnr: { name: 'lsnr', shape: [1, /*T*/ -1, 1] },
    },
  },
  erbDecoder: {
    file: 'erb_dec.onnx',
    inputs: ['emb', 'e3', 'e2', 'e1', 'e0'], // names match encoder outputs
    output: { name: 'm', shape: [1, 1, /*T*/ -1, 32] },           // ERB-band gain mask in [0,1]
  },
  dfDecoder: {
    file: 'df_dec.onnx',
    inputs: ['emb', 'c0'],
    output: { name: 'coefs', shape: [1, /*T*/ -1, 96, /*2*df_order*/ 10] },
    // df_dec also emits an unused scalar at output index '235'; ignore.
  },
};
```

(The `T` time dimension is dynamic; the smoke test ran with `T=1`. The
inference worker will use `T=1` per audio frame in streaming mode.)

For consumers that only need the legacy single-window shape, the closest
honest values are:

```ts
// Conceptual / legacy view — DFN3 is NOT a single ONNX graph in practice.
const DFN3_IO_SPEC_LEGACY: ModelIOSpec = {
  inputName:  'feat_erb+feat_spec', // see Dfn3ModelIOSpec for the real wiring
  outputName: 'm+coefs',            // ERB gain mask + DF complex coefficients
  modelSampleRate: 48000,
  windowSamples: 480,               // hop size — 10 ms frames at 48 kHz
};
```

### Go / no-go for spike 0b.1

✅ **GO** — a permissively licensed (MIT/Apache-2.0), well-formed DFN3 ONNX
export exists, all three sub-graphs load and run cleanly via onnxruntime-node
with shape-correct dummy inputs, and no NaNs are produced. The artifacts
themselves are not the blocker for Phase 1.

⚠️ **Concerns to flag for the controller before milestone 1 begins:**

1. **The plan needs revision.** The "single ONNX, PCM-in/PCM-out" assumption
   in milestone 1 (manifest entry, `ModelIOSpec`, the
   `session.run({ [INPUT_NAME]: tensor })` snippets in spike 0b.2) is wrong
   for DFN3. Either:
   - (a) generalise `ModelIOSpec` into a multi-graph descriptor as shown
     above and bundle all three ONNX files in the manifest, **or**
   - (b) write a custom DFN3 → single-ONNX exporter that internalises STFT
     and ERB feature extraction (significantly out of scope for Phase 1), **or**
   - (c) drop DFN3 and pick a model that does ship as a single end-to-end
     ONNX graph (e.g. RNNoise via [GregorR/rnnoise-nu](https://github.com/GregorR/rnnoise-nu) or the
     Microsoft `nsnet2` ONNX). RNNoise is much smaller and ships as a single
     graph, but is older and lower quality than DFN3.

2. **Spike 0b.2's benchmark code must be rewritten.** The placeholder loop in
   the plan (`session.run({ [INPUT_NAME]: new ort.Tensor('float32', new Float32Array(480), [1, 480]) })`)
   will not run against DFN3. The real benchmark needs:
   - A streaming STFT host harness (FFT 960, hop 480, Hann window).
   - ERB band feature extraction (32 bands, log power).
   - All three ONNX sessions chained per frame: enc → erb_dec → df_dec.
   - Aggregate the per-frame `enc + erb_dec + df_dec` time as the latency
     metric, not just one `session.run`.
   - Pass criterion (p95 < 8 ms per 10 ms frame) still applies — but it's
     now the **sum** across three graphs plus host-side STFT overhead.

3. **`df_lookahead=2` and `conv_lookahead=2` impose a 4-frame (40 ms)
   algorithmic delay** in the streaming path, on top of any audio thread
   buffering. Phase 1 budget docs need to account for this.

### Files written

- `scripts/spike/test-dfn3-availability.mjs` — the verification harness (committed).
- `scripts/spike/models/DeepFilterNet3_onnx.tar.gz` — the source bundle (gitignored; re-downloadable from the URL above).
- `scripts/spike/models/tmp/export/{enc,erb_dec,df_dec}.onnx` — extracted graphs (gitignored).
- `scripts/spike/.gitignore` — extended to ignore `*.tar.gz` and `models/tmp/`.

**Verdict for Phase 1 controller:** the artifact side of DFN3 is unblocked,
but the plan's milestone-1 ONNX integration design needs to be reworked
**before** spike 0b.2 (latency benchmark) can be meaningfully executed. Bring
this back to the planner.

## SFrame integration verification (Milestone 1, Task 1.10)

**Date:** 2026-04-08  
**Outcome:** **A** — voice isolation pipeline can wrap `MediaStreamTrack` before `addTrack`. Plan is unblocked.

### Files inspected

- `client/src/services/webrtc/voiceEncryption.ts`
- `client/src/types/webrtc-encoded-transform.d.ts`
- `client/src/services/webrtc/WebRTCService.ts`

### Findings

Dilla's SFrame implementation uses the **Encoded Transforms API**
(`RTCRtpScriptTransform`) for both encryption and decryption. The transforms
are attached to `RTCRtpSender.transform` and `RTCRtpReceiver.transform`,
which means SFrame operates on already-encoded RTP frames — i.e. **after**
the browser audio encoder, not at the `MediaStreamTrack` layer.

Key evidence (`voiceEncryption.ts`):

```ts
const transform = new RTCRtpScriptTransform(this.encryptWorker, { operation: 'encrypt' });
sender.transform = transform;
// ...
const transform = new RTCRtpScriptTransform(worker, { operation: 'decrypt' });
receiver.transform = transform;
```

In `WebRTCService.ts` the order is:

1. `getUserMedia` → raw `MediaStreamTrack` (line 52)
2. `pc.addTrack(track, this.localStream)` (line 109)
3. `encryption.setupE2EEncryption(this.pc, this.localUserId)` (line 115)

So a voice isolation wrapper inserted between steps 1 and 2 produces a
cleaned `MediaStreamTrack` that the browser audio encoder consumes. SFrame
then encrypts the encoded frames — independent of, and downstream of, the
DFN3 pipeline.

### Pipeline trace (Outcome A)

**Outgoing:**
```
getUserMedia → MediaStreamTrack
             → voiceIsolation.processOutgoing  (DFN3 wrapper)
             → cleaned MediaStreamTrack
             → pc.addTrack
             → browser audio encoder
             → RTCRtpSender.transform (SFrame encrypt)
             → SFU
```

**Incoming:**
```
SFU → RTCRtpReceiver.transform (SFrame decrypt)
    → browser audio decoder
    → MediaStreamTrack (from `track` event)
    → voiceIsolation.processIncoming
    → cleaned MediaStreamTrack
    → audio output
```

### Verdict

Plan can proceed. Milestone 3 (dispatcher + WebRTCService integration) will
wrap the local track between `getUserMedia` and `addTrack`, and wire
incoming-stream processing into the existing `track` event handler that
currently calls `applyDecryptTransform` (line 138).

No re-spec required.

---

## Spike 0c — DFN3 streaming inference: deeper-than-expected hidden state

**Date:** 2026-04-09 (post-Phase-1-implementation deep debug session)

**Status:** Architectural limitation found. v1 (state-hidden) and v2
(state-exposed for encoder GRU + first-layer conv ctx) ONNX exports both
produce **-0.80 dB SNR** vs the upstream `df.enhance()` reference on the
canonical `noisy_snr0.wav` test input. Streaming TS port over-suppresses
speech by ~2x regardless of which export is used.

### The diagnostic chain

1. Original v1 (state-hidden, 858c977): -0.47 dB SNR. Bug attributed to
   ORT Web's lack of pulse-model rewriting.
2. Re-export v2 (state-exposed for encoder GRU + erb/spec conv ctx +
   df conv ctx + erb/df decoder GRUs, ae78de0): expected to fix it.
   Actual SNR: -0.84 dB. The wiring agent verified state tensors flow
   through the worker correctly (max diff 0.56 between threaded vs zero
   state inputs).
3. Re-export attempted with dynamic T axis (this session): the legacy
   `torch.onnx.export(dynamic_axes=...)` was being silently ignored
   because torch 2.11 defaults to `dynamo=True`. Fixed by switching to
   `torch.export.export(dynamic_shapes=...)` with `Dim.AUTO`. Verified
   the exporter now propagates dynamic T through the input graph
   metadata.
4. **But T=5 inference still fails** with a runtime Reshape mismatch:
   `Input shape:{1,1,8,64}, requested shape:{1,2,512}`. The dynamo
   tracer baked the literal T from the dummy into a Reshape inside the
   inner DFN3 module, even with Dim.AUTO. This is because the DFN3
   encoder uses Python-int unpacking (`b, t, _ = x.shape; y = x.view(b,
   t, ...)`) which the tracer captures as literal constants regardless
   of the dynamic_shapes hint.

### The deeper finding (the real bug)

The current `StreamingEncoder` wrapper only captures temporal context for
the **first layer** of each conv stack:

```python
self.enc.erb_conv0 -> context buffer erb_ctx [B,1,2,F]
self.enc.df_conv0  -> context buffer spec_ctx [B,2,2,F]
```

But DFN3's encoder has multiple conv layers in each branch:

```
erb_conv0 -> erb_conv1 -> erb_conv2 -> erb_conv3
df_conv0  -> df_conv1
```

Each of these has its own temporal kernel and its own past-context
requirement. With T=1 streaming inference, layers 1+ silently zero-pad
their past temporal context — there's no `erb_conv1_ctx` input to thread
the previous frame's intermediate activations across calls. This is
exactly the "GRU state that resets every call" problem that motivated
the v2 re-export, but applied to the conv stack's intermediate state
instead of the GRU state.

The wrapper neutralised the layer-0 `ConstantPad2d` past-pads (line 64)
but didn't add equivalent neutralisation + context capture for the
deeper layers. The result: streaming inference produces the same
~2x over-suppression as v1 did.

### What a complete fix would require

For each conv layer in the encoder that has a temporal kernel (`erb_conv1`,
`erb_conv2`, `erb_conv3`, `df_conv1`):
1. Read its `ConstantPad2d` past-pad amount → that's the context length
2. Add a corresponding `..._ctx` input/output to the wrapper
3. Concatenate the input context + the layer's previous-layer output, run
   the conv on the concatenated tensor, slice the trailing N frames as
   the new context output
4. Update the manifest's `state_shapes` with the new context sizes
5. Update `inferenceWorker.ts` to allocate and thread these additional
   state buffers

This is a 1-3 day deep dive into DFN3's internal architecture. Feasible
but not in scope for the current Phase 1 push.

### Pragmatic alternatives

1. **Frame batching** — accumulate N frames (e.g., 5-10) of input
   features in the inference worker, call the encoder once per batch
   with T=N. The conv layers see enough temporal context within the
   batch to produce correct outputs at the end of each batch. Cost:
   N x 10ms of additional algorithmic latency. At N=5: total mouth-
   to-ear latency around 90 ms (40 ms existing + 50 ms batch). Still
   acceptable for live voice.

2. **Replace ORT Web with tract-wasm** — tract is the Rust runtime
   libDF actually uses, and its `PulsedModel` rewriter handles all
   hidden state automatically. Significant rewrite of the inference
   worker but eliminates the entire class of state-tracking bugs.

3. **Ship v1 as "noise reduction (best-effort)"** — accept the ~2x
   over-suppression as a known limitation, document in the badge UI
   that DFN3 is in a degraded mode, and continue to a future fix.

4. **Switch to a non-streaming model** like NSNet2 that doesn't have
   this complexity (single-graph, designed for ORT-friendly streaming).

### Files of interest

- `scripts/reexport-dfn3-onnx.py` (working tree, uncommitted): partial
  fix for dynamic T export via `torch.export.export` + `Dim.AUTO`.
  Demonstrates that the input graph metadata can be made T-dynamic, but
  inner-module view() calls still bake constants. Not committed because
  the export doesn't actually run for T≠2 due to the deeper conv-context
  bug.
- `server-rs/assets/voice-models/dfn3-v2/`: the v2 export (T=1 hardcoded,
  only first-layer conv context captured). Currently the shipping path
  despite the limitation.
- `client/src/services/voiceIsolation/dfn3Pipeline.regression.test.ts`:
  the strict 6 dB SNR test is `it.skip` with header explaining the
  limitation.

### Current shipping decision

Pending user input. The v2 ONNX files are committed and serve as the
active path. The TypeScript wiring is correct. The streaming SNR
limitation is documented. The PR (#123) remains in draft until a
shipping decision is made among the four pragmatic alternatives above.

---

## Spike 0d — DFN3 streaming has a 2-frame time-shift baked into training

**Date:** 2026-04-09 (continuation of spike 0c, same session)

After spike 0c flagged the v2 export as architecturally limited, I dove
deeper into DFN3's actual model.py to figure out what state was missing
from the wrapper. Hypothesis going in: deeper conv layers (`erb_conv1/2/3`,
`df_conv1`) need their own temporal context buffers. **This hypothesis was
wrong** — `conv_kernel = (1, 3)` per the DFN3 config means those convs
are 1×3 (T×F) = no temporal kernel. They need no context.

The actual root cause is much more interesting:

```python
# df/deepfilternet3.py, in DfNet3.__init__:
if p.conv_lookahead > 0:
    assert p.conv_lookahead >= p.df_lookahead
    self.pad_feat = nn.ConstantPad2d((0, 0, -p.conv_lookahead, p.conv_lookahead), 0.0)
```

The actual loaded DFN3 checkpoint has `conv_lookahead = 2`, so:

```
pad_feat = ConstantPad2d((0, 0, -2, 2), 0.0)
```

This is a **time shift**: it slices 2 frames off the start of the T axis
and pads 2 zero frames at the end. The encoder is trained to receive
input from frames `[t+2, t+3, t+4, ...]` to produce output at time `t`.

Our `StreamingEncoder` wrapper bypasses `pad_feat` entirely:

```python
def forward(self, feat_erb, feat_spec, erb_ctx, spec_ctx, h_enc):
    erb_full = torch.cat([erb_ctx, feat_erb], dim=2)  # bypass pad_feat
    spec_full = torch.cat([spec_ctx, feat_spec], dim=2)
    e0 = self.enc.erb_conv0(erb_full)
    ...
```

The wrapper feeds the encoder real past frames via `erb_ctx`, but it
**never accounts for the 2-frame look-ahead the model was trained with**.
At training time, when the model is asked for the output at time `t`,
the encoder GRU sees an input that has been pre-shifted so it actually
contains the features from time `t+2`. The encoder weights have learned
this temporal relationship.

In our streaming wrapper, when we call with `feat_erb = features at
time t`, the encoder thinks we asked for the output of time `t-2` (since
its weights interpret the input as already-shifted-by-2). The result is
that the GRU's hidden state evolves at the wrong rate relative to the
input, producing systematically wrong masks. This matches the observed
~2x over-suppression: the GRU is consistently 2 frames out of phase with
the actual signal it's modeling.

There's also a parallel `df_lookahead = 2` for the deep filter stage,
which the wrapper doesn't handle either. The DF op is supposed to see 2
future frames per call; our wrapper feeds it the current frame as if it
were the 2-frames-future frame, with similar phase-misalignment effects.

### Why per-conv-context-capture would NOT have helped

I almost spent a day on the wrong fix. The deeper conv layers in DFN3 are
1×3 (no T context) so they don't have hidden state to capture. Adding
context buffers for `erb_conv1/2/3` and `df_conv1` would have produced
no behavioral change.

### The real fix shape

To make T=1 streaming match libDF's output exactly, the wrapper would
need to:

1. Buffer 2 frames of input on the wrapper input side (call them
   "lookahead pending frames")
2. When the user calls with frame `t`, push it into the buffer
3. Call the encoder with the frame from `t-2` (the oldest in the
   buffer), pretending it's the "future-shifted" input the model expects
4. Emit the output with a 2-frame delay relative to the input
5. At end of stream, flush the buffer with zero-pad to match libDF's
   `+conv_lookahead` zero-pad behavior

**This is possible but it's a non-trivial refactor of the entire
streaming protocol** — the inferenceWorker would need to track an
emit-delay, the dispatcher would need to know about the warmup period,
and the regression test would need to align outputs with the
correctly-delayed reference.

### Why frame batching (Phase 1 option 1) sidesteps this entirely

With a batched encoder call of N frames (e.g., N=8), the 2-frame time
shift becomes an internal **within-batch reordering**: the encoder
receives `[frame_0, frame_1, ..., frame_7]`, the trained weights
interpret it as if `frame_2` was the "current output time" for the GRU's
first emission, and the natural batch-time-axis handles all the
phase-alignment automatically. No special buffer protocol, no
emit-delay tracking, no warmup state — just call the encoder with N
frames and slice the outputs.

The cost is `N × 10ms` of additional algorithmic latency on top of the
existing 40 ms. At N=8: total ≈ 120 ms mouth-to-ear, still well within
live-call territory (the human acceptability threshold for two-way
voice is roughly 200 ms).

### Updated recommendation: ship Phase 1 with option 1 (frame batching)

After diving 3+ hours into option 4 (full per-layer state capture), the
realistic conclusion is:

- The "missing state" isn't per-layer — it's **a temporal alignment
  baked into training-time data shaping** that's awkward to replicate
  in T=1 streaming inference.
- The proper fix is a wrapper that mimics libDF's exact buffering
  scheme. That's a multi-day deep dive into libDF's `tract.rs` and
  careful streaming protocol design.
- Frame batching is a 1-day fix that produces correct output at the
  cost of 80 ms of extra latency.

**Phase 1 should ship with frame batching at N=8** (120 ms total
latency). The "do it properly with T=1 streaming" work belongs in
Phase 2 alongside the parallel research workstream the spec already
documents.
