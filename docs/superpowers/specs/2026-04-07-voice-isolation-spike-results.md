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
