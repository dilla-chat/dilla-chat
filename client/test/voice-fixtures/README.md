# Voice Isolation Test Fixtures

This directory holds WAV fixtures used by the voice-isolation plugin tests.
The real fixtures are generated as part of Milestone 10 (quality regression
suite) of the Phase 1 plan — this README is a placeholder so Milestone 0
scripts can resolve the directory path.

## Planned fixtures

| File | Purpose |
|---|---|
| `clean_speech_alice.wav` | Clean enrollment-quality speech, speaker A |
| `clean_speech_alice_alt.wav` | Second clean recording of speaker A (for ECAPA self-similarity test) |
| `clean_speech_bob.wav` | Clean speech, speaker B (for ECAPA cross-speaker test) |
| `speech_with_keyboard.wav` | Speaker A talking with mechanical keyboard noise — primary Spike 0a test input |
| `speech_with_music.wav` | Speaker A talking over background music |
| `two_speaker_overlap.wav` | A and B speaking simultaneously (target-speaker-extraction stress test) |

## Generation

TBD per plan Task 10.1. Expected sources:

- LibriSpeech (CC-BY-4.0) for clean speech samples
- FSD50K or Freesound (CC-BY / CC0) for background noise
- Mixed offline with Python `soundfile` + `numpy` at known SNRs

## Licensing

All committed fixtures must be under CC-BY-4.0 or more permissive. Document
exact provenance per-file in this README as fixtures land.

## Spike 0a note

Spike 0a (`scripts/spike/test-vfl-availability.mjs`) does **not** use these
fixtures — it uses the Apache-2.0 `mixed.wav` / `ref-voice.wav` /
`output.wav` fixtures bundled with the upstream ailia-models VoiceFilter
project, which are stored in `scripts/spike/models/` alongside the ONNX
checkpoints. See the spike memo at
`docs/superpowers/specs/2026-04-07-voice-isolation-spike-results.md`.
