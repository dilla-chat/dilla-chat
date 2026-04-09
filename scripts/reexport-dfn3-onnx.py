#!/usr/bin/env python3
"""
Re-export DeepFilterNet 3 ONNX sub-models with explicit streaming state I/O.

See docs/voice-isolation/reexport-notes.md for background. The short version:
the original DFN3 ONNX sub-graphs hide GRU hidden state and causal-conv
temporal receptive fields inside the graph. libDF works around that with
tract_pulse. ORT has no such rewrite, so per-frame (T=1) calls reset state
every invocation and the ERB mask under-suppresses speech by ~2x.

This script loads the pretrained DFN3 checkpoint via `df.enhance.init_df()`,
wraps each of the three sub-models in a streaming-friendly `nn.Module` that:
  1. accepts the previous conv temporal context frames as an input tensor,
  2. accepts the previous GRU hidden state as an input tensor,
  3. concatenates ctx + current frame, runs the original layers (with the
     built-in ConstantPad2d past-temporal pads neutralised), and
  4. returns the usual outputs plus updated ctx and hidden state.

Output: scripts/spike/models/dfn3-v2/{enc,erb_dec,df_dec}.onnx
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

# ---- torchaudio shim for Python 3.14 / torchaudio >= 2.9 ----
if "torchaudio.backend.common" not in sys.modules:
    _stub = types.ModuleType("torchaudio.backend.common")

    class AudioMetaData:  # noqa: D401
        def __init__(self, **kwargs) -> None:
            for k, v in kwargs.items():
                setattr(self, k, v)

    _stub.AudioMetaData = AudioMetaData
    _backend = types.ModuleType("torchaudio.backend")
    _backend.common = _stub
    sys.modules["torchaudio.backend"] = _backend
    sys.modules["torchaudio.backend.common"] = _stub

import torch  # noqa: E402
import torch.nn as nn  # noqa: E402
from df.enhance import init_df  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "scripts" / "spike" / "models" / "dfn3-v2"
OPSET = 17

NB_ERB = 32
NB_DF = 96
CONV_CTX_ENC_ERB = 2
CONV_CTX_ENC_DF = 2
CONV_CTX_DF_DEC = 4
H_ENC_SHAPE = (1, 1, 256)
H_ERB_SHAPE = (2, 1, 256)
H_DF_SHAPE = (2, 1, 256)

# Frame batching: the encoder is called with this many frames at a time.
# At T=8 (8 hops × 10 ms = 80 ms batch), the model's 2-frame look-ahead
# (pad_feat) becomes a within-batch reorder rather than a per-frame
# misalignment, so the streaming output matches libDF's behavior.
BATCH_T = 8


def _neutralise_temporal_pad(conv_norm_act: nn.Module) -> None:
    first = conv_norm_act[0]
    assert isinstance(first, nn.ConstantPad2d), f"expected ConstantPad2d got {type(first)}"
    pad_h = first.padding
    assert pad_h[0] == 0 and pad_h[1] == 0 and pad_h[3] == 0, f"unexpected pad {pad_h}"
    conv_norm_act[0] = nn.Identity()


class StreamingEncoder(nn.Module):
    def __init__(self, enc: nn.Module) -> None:
        super().__init__()
        self.enc = enc
        _neutralise_temporal_pad(self.enc.erb_conv0)
        _neutralise_temporal_pad(self.enc.df_conv0)

    def forward(self, feat_erb, feat_spec, erb_ctx, spec_ctx, h_enc):
        erb_full = torch.cat([erb_ctx, feat_erb], dim=2)
        spec_full = torch.cat([spec_ctx, feat_spec], dim=2)

        e0 = self.enc.erb_conv0(erb_full)
        e1 = self.enc.erb_conv1(e0)
        e2 = self.enc.erb_conv2(e1)
        e3 = self.enc.erb_conv3(e2)
        c0 = self.enc.df_conv0(spec_full)
        c1 = self.enc.df_conv1(c0)
        cemb = c1.permute(0, 2, 3, 1).flatten(2)
        cemb = self.enc.df_fc_emb(cemb)
        emb = e3.permute(0, 2, 3, 1).flatten(2)
        emb = self.enc.combine(emb, cemb)
        emb, h_enc_out = self.enc.emb_gru(emb, h_enc)
        lsnr = self.enc.lsnr_fc(emb) * self.enc.lsnr_scale + self.enc.lsnr_offset

        erb_ctx_out = erb_full[:, :, -CONV_CTX_ENC_ERB:, :]
        spec_ctx_out = spec_full[:, :, -CONV_CTX_ENC_DF:, :]

        return e0, e1, e2, e3, emb, c0, lsnr, erb_ctx_out, spec_ctx_out, h_enc_out


class StreamingErbDecoder(nn.Module):
    def __init__(self, erb_dec: nn.Module) -> None:
        super().__init__()
        self.dec = erb_dec

    def forward(self, emb, e3, e2, e1, e0, h_erb):
        b, _, t, f8 = e3.shape
        emb2, h_erb_out = self.dec.emb_gru(emb, h_erb)
        emb2 = emb2.view(b, t, f8, -1).permute(0, 3, 1, 2)
        e3x = self.dec.convt3(self.dec.conv3p(e3) + emb2)
        e2x = self.dec.convt2(self.dec.conv2p(e2) + e3x)
        e1x = self.dec.convt1(self.dec.conv1p(e1) + e2x)
        m = self.dec.conv0_out(self.dec.conv0p(e0) + e1x)
        return m, h_erb_out


class StreamingDfDecoder(nn.Module):
    def __init__(self, df_dec: nn.Module) -> None:
        super().__init__()
        self.dec = df_dec
        _neutralise_temporal_pad(self.dec.df_convp)

    def forward(self, emb, c0, c0_ctx, h_df):
        b, t, _ = emb.shape
        c, h_df_out = self.dec.df_gru(emb, h_df)
        if self.dec.df_skip is not None:
            c = c + self.dec.df_skip(emb)
        c0_full = torch.cat([c0_ctx, c0], dim=2)
        c0_conv = self.dec.df_convp(c0_full).permute(0, 2, 3, 1)
        c = self.dec.df_out(c)
        c = c.view(b, t, self.dec.df_bins, self.dec.df_out_ch) + c0_conv
        c0_ctx_out = c0_full[:, :, -CONV_CTX_DF_DEC:, :]
        return c, c0_ctx_out, h_df_out


def _export_and_inline(module, dummy, out_path: Path, input_names, output_names, dynamic_axes) -> None:
    """Export via the dynamo exporter (required for Python 3.14 / torch 2.11),
    then rewrite the resulting model so all weights live inside the single
    .onnx file instead of a sidecar .onnx.data blob.

    Note: T is now baked at BATCH_T (see top-level constant). Streaming
    inference uses frame batching at the dispatcher level: the inferenceWorker
    accumulates BATCH_T frames of features before calling the encoder, which
    sidesteps the 2-frame time-shift bug documented in spike 0d.
    """
    import onnx

    torch.onnx.export(
        module, dummy, str(out_path), opset_version=OPSET,
        input_names=input_names,
        output_names=output_names,
        do_constant_folding=True,
    )
    # Re-save with inline weights (no external_data).
    m = onnx.load(str(out_path), load_external_data=True)
    sidecar = Path(str(out_path) + ".data")
    if sidecar.exists():
        sidecar.unlink()
    # Clear external_data refs on every initializer so onnx.save inlines them.
    for init in m.graph.initializer:
        init.data_location = onnx.TensorProto.DEFAULT
        del init.external_data[:]
    onnx.save(m, str(out_path), save_as_external_data=False)


def export_encoder(enc_wrap, out_path: Path) -> None:
    # Bake T=BATCH_T into the export. The streaming worker will buffer
    # BATCH_T frames before each encoder call.
    dummy = (
        torch.zeros(1, 1, BATCH_T, NB_ERB),
        torch.zeros(1, 2, BATCH_T, NB_DF),
        torch.zeros(1, 1, CONV_CTX_ENC_ERB, NB_ERB),
        torch.zeros(1, 2, CONV_CTX_ENC_DF, NB_DF),
        torch.zeros(*H_ENC_SHAPE),
    )
    _export_and_inline(
        enc_wrap, dummy, out_path,
        input_names=["feat_erb", "feat_spec", "erb_ctx", "spec_ctx", "h_enc"],
        output_names=[
            "e0", "e1", "e2", "e3", "emb", "c0", "lsnr",
            "erb_ctx_out", "spec_ctx_out", "h_enc_out",
        ],
        dynamic_axes={},
    )


def export_erb_dec(dec_wrap, out_path: Path) -> None:
    dummy = (
        torch.zeros(1, BATCH_T, 512),
        torch.zeros(1, 64, BATCH_T, 8),
        torch.zeros(1, 64, BATCH_T, 8),
        torch.zeros(1, 64, BATCH_T, 16),
        torch.zeros(1, 64, BATCH_T, 32),
        torch.zeros(*H_ERB_SHAPE),
    )
    _export_and_inline(
        dec_wrap, dummy, out_path,
        input_names=["emb", "e3", "e2", "e1", "e0", "h_erb"],
        output_names=["m", "h_erb_out"],
        dynamic_axes={},
    )


def export_df_dec(dec_wrap, out_path: Path) -> None:
    dummy = (
        torch.zeros(1, BATCH_T, 512),
        torch.zeros(1, 64, BATCH_T, NB_DF),
        torch.zeros(1, 64, CONV_CTX_DF_DEC, NB_DF),
        torch.zeros(*H_DF_SHAPE),
    )
    _export_and_inline(
        dec_wrap, dummy, out_path,
        input_names=["emb", "c0", "c0_ctx", "h_df"],
        output_names=["coefs", "c0_ctx_out", "h_df_out"],
        dynamic_axes={},
    )


def verify_streaming_equivalence(enc_w, erb_w, df_w) -> None:
    torch.manual_seed(0)
    T = 8
    feat_erb_full = torch.randn(1, 1, T, NB_ERB)
    feat_spec_full = torch.randn(1, 2, T, NB_DF)

    with torch.no_grad():
        erb_ctx0 = torch.zeros(1, 1, CONV_CTX_ENC_ERB, NB_ERB)
        spec_ctx0 = torch.zeros(1, 2, CONV_CTX_ENC_DF, NB_DF)
        h_enc = torch.zeros(*H_ENC_SHAPE)
        h_erb = torch.zeros(*H_ERB_SHAPE)
        h_df = torch.zeros(*H_DF_SHAPE)
        c0_ctx = torch.zeros(1, 64, CONV_CTX_DF_DEC, NB_DF)

        ref_out = enc_w(feat_erb_full, feat_spec_full, erb_ctx0, spec_ctx0, h_enc)
        ref_e0, ref_e1, ref_e2, ref_e3, ref_emb, ref_c0, ref_lsnr, _, _, _ = ref_out
        ref_m, _ = erb_w(ref_emb, ref_e3, ref_e2, ref_e1, ref_e0, h_erb)
        ref_coefs, _, _ = df_w(ref_emb, ref_c0, c0_ctx, h_df)

        erb_ctx = erb_ctx0.clone()
        spec_ctx = spec_ctx0.clone()
        h_enc_s = h_enc.clone()
        h_erb_s = h_erb.clone()
        h_df_s = h_df.clone()
        c0_ctx_s = c0_ctx.clone()
        stream_e0 = torch.zeros_like(ref_e0)
        stream_m = torch.zeros_like(ref_m)
        stream_coefs = torch.zeros_like(ref_coefs)
        for t in range(T):
            fe = feat_erb_full[:, :, t:t+1, :]
            fs = feat_spec_full[:, :, t:t+1, :]
            e0t, e1t, e2t, e3t, embt, c0t, lsnrt, erb_ctx, spec_ctx, h_enc_s = enc_w(
                fe, fs, erb_ctx, spec_ctx, h_enc_s
            )
            mt, h_erb_s = erb_w(embt, e3t, e2t, e1t, e0t, h_erb_s)
            coefst, c0_ctx_s, h_df_s = df_w(embt, c0t, c0_ctx_s, h_df_s)
            stream_e0[:, :, t:t+1, :] = e0t
            stream_m[:, :, t:t+1, :] = mt
            stream_coefs[:, t:t+1, :, :] = coefst

        def _diff(name, a, b):
            d = (a - b).abs().max().item()
            print(f"  {name}: max_abs_diff={d:.3e}")
            return d

        print("[verify] streaming vs batched (wrapper-level):")
        d1 = _diff("e0", ref_e0, stream_e0)
        d2 = _diff("m", ref_m, stream_m)
        d3 = _diff("coefs", ref_coefs, stream_coefs)
        max_d = max(d1, d2, d3)
        if max_d > 1e-4:
            raise SystemExit(f"[verify] streaming mismatch too large ({max_d:.3e})")
        print(f"[verify] OK — max diff {max_d:.3e}")


def verify_ort_loads(out_dir: Path) -> None:
    import onnx
    import onnxruntime as rt
    for name in ("enc", "erb_dec", "df_dec"):
        p = out_dir / f"{name}.onnx"
        m = onnx.load(str(p))
        onnx.checker.check_model(m)
        sess = rt.InferenceSession(str(p), providers=["CPUExecutionProvider"])
        print(f"  {name}.onnx: inputs={[i.name for i in sess.get_inputs()]} "
              f"outputs={[o.name for o in sess.get_outputs()]} "
              f"({p.stat().st_size // 1024} KiB)")
    print("[verify] ORT load: OK")


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("[re-export] loading DFN3 checkpoint...")
    model, _df_state, _ = init_df()
    model.train(False)

    print("[re-export] building streaming wrappers...")
    enc_w = StreamingEncoder(model.enc)
    erb_w = StreamingErbDecoder(model.erb_dec)
    df_w = StreamingDfDecoder(model.df_dec)
    enc_w.train(False)
    erb_w.train(False)
    df_w.train(False)

    print("[re-export] verifying streaming equivalence at PyTorch level...")
    verify_streaming_equivalence(enc_w, erb_w, df_w)

    print("[re-export] exporting encoder...")
    export_encoder(enc_w, OUT_DIR / "enc.onnx")
    print("[re-export] exporting ERB decoder...")
    export_erb_dec(erb_w, OUT_DIR / "erb_dec.onnx")
    print("[re-export] exporting DF decoder...")
    export_df_dec(df_w, OUT_DIR / "df_dec.onnx")

    print("[re-export] checking ONNX + ORT load...")
    verify_ort_loads(OUT_DIR)

    print(f"[re-export] done -> {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
