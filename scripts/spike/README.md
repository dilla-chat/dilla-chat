# Voice Isolation Spike (Milestone 0)

Throwaway research scripts that gate Phase 1 of the voice-isolation plugin. See
`docs/superpowers/plans/2026-04-07-voice-isolation-plugin-phase1.md` for the
full plan and `docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md`
for the resulting memo.

## What's here

- `test-vfl-availability.mjs` — Spike 0a: loads the ailia-models VoiceFilter
  ONNX checkpoints (mask predictor + d-vector embedder), runs an end-to-end
  inference on the bundled fixtures, and prints SNR improvement vs the
  published reference output.
- `models/` — fixtures and downloaded ONNX checkpoints.
  - `mixed.wav` (94 KB) — noisy mixture, Apache-2.0 (ailia-models test asset)
  - `ref-voice.wav` (146 KB) — enrollment reference, Apache-2.0 (same)
  - `output_reference.wav` (141 KB) — ailia's published expected output, used
    for SNR ground-truth comparison
  - `voicefilter_model.onnx` (75 MB) — **gitignored**, re-download on demand
  - `voicefilter_embedder.onnx` (48 MB) — **gitignored**, re-download on demand

## Re-running the spike

```bash
cd scripts/spike
npm install
# Re-fetch the ONNX checkpoints (URLs and SHAs are in the memo)
mkdir -p models
curl -L -o models/voicefilter_model.onnx \
  https://huggingface.co/niobures/VoiceFilter/resolve/main/models/ailia-models/model.onnx
curl -L -o models/voicefilter_embedder.onnx \
  https://huggingface.co/niobures/VoiceFilter/resolve/main/models/ailia-models/embedder.onnx
node test-vfl-availability.mjs
```

Expected output: SNR improvement of ≥+20 dB on `mixed.wav` vs
`output_reference.wav`. See the memo for the full pass criteria and tensor
spec.
