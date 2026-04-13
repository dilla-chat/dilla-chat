#!/usr/bin/env python3
"""
Generate voice-isolation regression fixtures from the upstream DeepFilterNet 3
reference implementation.

This script:
  1. Synthesises a known noisy input signal (sine "speech" + white noise)
  2. Runs the official `df.enhance.enhance()` PyTorch pipeline on it
  3. Saves both `noisy_input.wav` and `dfn3_reference.wav` to
     `client/test/voice-fixtures/`

The TypeScript regression test (`pipeline.regression.browser.test.ts`)
loads these fixtures and asserts our DSP port produces output within an SNR
threshold of the upstream reference, which validates that our STFT, ERB
filterbank, deep filter, and ONNX inference orchestration are numerically
correct.

## Usage

Requires Python 3 with the following packages:

    python3 -m venv .venv
    .venv/bin/pip install deepfilternet torch torchaudio soundfile numpy

Then:

    .venv/bin/python scripts/generate-voice-fixtures.py

If torchaudio is too new and `torchaudio.backend.common` is missing, this
script auto-shims it. Tested with Python 3.14, torch 2.11, deepfilternet
0.5.6.

## Why pre-generated fixtures?

The Python deps (torch, deepfilternet) are heavyweight and Python 3.14
wheels are unstable. Generating once and committing the WAVs to the repo
keeps CI lean — the regression test only needs `onnxruntime-web` (already a
client dep) plus the small WAV blobs.
"""

from __future__ import annotations

import os
import sys
import types
from pathlib import Path

import numpy as np

# ---- torchaudio shim (Python 3.14 / torchaudio >= 2.9 compatibility) -------
# `df.io` imports `torchaudio.backend.common.AudioMetaData`, which was
# removed from torchaudio 2.9+. Provide a stub before importing df.
if "torchaudio.backend.common" not in sys.modules:
    _stub = types.ModuleType("torchaudio.backend.common")

    class AudioMetaData:  # noqa: D401
        def __init__(
            self,
            sample_rate: int = 0,
            num_frames: int = 0,
            num_channels: int = 0,
            bits_per_sample: int = 0,
            encoding: str = "UNKNOWN",
        ) -> None:
            self.sample_rate = sample_rate
            self.num_frames = num_frames
            self.num_channels = num_channels
            self.bits_per_sample = bits_per_sample
            self.encoding = encoding

    _stub.AudioMetaData = AudioMetaData
    _backend = types.ModuleType("torchaudio.backend")
    _backend.common = _stub
    sys.modules["torchaudio.backend"] = _backend
    sys.modules["torchaudio.backend.common"] = _stub

import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from df.enhance import enhance, init_df  # noqa: E402

# ----------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = REPO_ROOT / "client" / "test" / "voice-fixtures"
NOISY_PATH = FIXTURE_DIR / "noisy_input.wav"
REF_PATH = FIXTURE_DIR / "dfn3_reference.wav"

SAMPLE_RATE = 48000
# Source: the canonical "noisy speech at SNR 0" sample shipped with the
# upstream DeepFilterNet repo (Apache-2.0). We download it on demand if it
# isn't already in the fixture directory. Real speech is critical because
# DFN3 was trained to preserve voice and suppress everything else — synthetic
# sine inputs are treated as noise and the reference output is essentially
# silence, which makes any SNR comparison numerically meaningless.
UPSTREAM_SAMPLE_URL = "https://github.com/Rikorose/DeepFilterNet/raw/main/assets/noisy_snr0.wav"


def load_noisy_input(target_path: Path) -> np.ndarray:
    """Fetch (or cache) the upstream noisy speech sample and return mono float32."""
    if not target_path.exists():
        import urllib.request

        print(f"[gen] downloading upstream sample -> {target_path}")
        urllib.request.urlretrieve(UPSTREAM_SAMPLE_URL, target_path)

    audio, sr = sf.read(str(target_path), dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1).astype(np.float32)
    if sr != SAMPLE_RATE:
        raise SystemExit(
            f"[gen] expected {SAMPLE_RATE} Hz upstream sample, got {sr} Hz",
        )
    return np.clip(audio.astype(np.float32), -1.0, 1.0)


def main() -> int:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[gen] loading noisy input @ {SAMPLE_RATE}Hz")
    noisy = load_noisy_input(NOISY_PATH)
    # Re-write as 32-bit float so the TS reader can use a single code path.
    sf.write(str(NOISY_PATH), noisy, SAMPLE_RATE, subtype="FLOAT")
    print(f"[gen] wrote {NOISY_PATH} ({len(noisy)} samples)")

    print("[gen] loading DeepFilterNet 3 (PyTorch reference)...")
    model, df_state, _ = init_df()

    print("[gen] running enhance()")
    audio_t = torch.from_numpy(noisy).unsqueeze(0)  # [1, N]
    enhanced = enhance(model, df_state, audio_t)
    enhanced_np = enhanced.squeeze(0).cpu().numpy().astype(np.float32)
    enhanced_np = np.clip(enhanced_np, -1.0, 1.0)

    sf.write(str(REF_PATH), enhanced_np, SAMPLE_RATE, subtype="FLOAT")
    print(f"[gen] wrote {REF_PATH} ({len(enhanced_np)} samples)")

    # Sanity SNR print so a human can eyeball the result.
    if len(enhanced_np) >= len(noisy):
        ref = enhanced_np[: len(noisy)]
    else:
        ref = np.pad(enhanced_np, (0, len(noisy) - len(enhanced_np)))
    diff = noisy - ref
    snr = 10 * np.log10((ref**2).sum() / max((diff**2).sum(), 1e-12))
    print(f"[gen] reference SNR vs noisy input: {snr:.2f} dB")
    print("[gen] done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
