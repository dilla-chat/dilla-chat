// Spike 0b.1: DeepFilterNet 3 ONNX availability + IO contract verification
//
// Loads the three ONNX graphs that ship in the official Rikorose/DeepFilterNet
// release tarball (`models/DeepFilterNet3_onnx.tar.gz`):
//   - enc.onnx       (encoder)
//   - erb_dec.onnx   (ERB-band gain decoder)
//   - df_dec.onnx    (deep filter coefficient decoder)
//
// DFN3 is NOT a single end-to-end PCM-in/PCM-out ONNX graph. The official
// export splits the model into three sub-graphs that run inside an STFT/ERB
// front-end + deep-filter post-processing loop. The host code (libDF in
// Rust, or our future TS pipeline) is responsible for:
//   1. Streaming STFT (FFT size 960, hop 480, 48kHz → 50 fps)
//   2. ERB band feature extraction (32 bands)
//   3. DF complex feature extraction (96 lowest bins)
//   4. Running enc → erb_dec → df_dec
//   5. Applying ERB gains + deep filter coefficients to the spectrogram
//   6. iSTFT
//
// This script's purpose is purely to:
//   1. Confirm all three ONNX graphs load via onnxruntime-node.
//   2. Print the input/output tensor names + shapes (to fill the spec memo).
//   3. Run a single forward pass on each with shape-correct dummy tensors,
//      verifying we get non-NaN floats out.

import * as ort from 'onnxruntime-node';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPORT = resolve(__dirname, 'models/tmp/export');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fileSize(path) {
  return statSync(path).size;
}

function describe(name, sess) {
  console.log(`\n[${name}]`);
  console.log('  inputs:');
  for (const n of sess.inputNames) {
    const meta = sess.inputMetadata?.[n] ?? {};
    console.log(
      `    - ${n}  dims=${JSON.stringify(meta.dimensions ?? meta.shape ?? '?')}  type=${meta.type ?? '?'}`,
    );
  }
  console.log('  outputs:');
  for (const n of sess.outputNames) {
    const meta = sess.outputMetadata?.[n] ?? {};
    console.log(
      `    - ${n}  dims=${JSON.stringify(meta.dimensions ?? meta.shape ?? '?')}  type=${meta.type ?? '?'}`,
    );
  }
}

function rand(n) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.random() * 2 - 1;
  return a;
}

function checkNonNaN(label, tensor) {
  let nans = 0;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const v of tensor.data) {
    if (Number.isNaN(v)) nans++;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  console.log(
    `    ${label}: shape=${JSON.stringify(tensor.dims)} len=${tensor.data.length} NaN=${nans} range=[${minV.toFixed(4)}, ${maxV.toFixed(4)}]`,
  );
  return nans === 0;
}

async function run() {
  console.log('=== Spike 0b.1: DeepFilterNet 3 ONNX availability ===\n');

  const encPath = resolve(EXPORT, 'enc.onnx');
  const erbDecPath = resolve(EXPORT, 'erb_dec.onnx');
  const dfDecPath = resolve(EXPORT, 'df_dec.onnx');

  console.log('File metadata:');
  for (const p of [encPath, erbDecPath, dfDecPath]) {
    console.log(`  ${p.split('/').slice(-2).join('/')}`);
    console.log(`    size:   ${fileSize(p)} bytes`);
    console.log(`    sha256: ${sha256(p)}`);
  }

  console.log('\nLoading sessions...');
  const enc = await ort.InferenceSession.create(encPath);
  describe('enc', enc);
  const erbDec = await ort.InferenceSession.create(erbDecPath);
  describe('erb_dec', erbDec);
  const dfDec = await ort.InferenceSession.create(dfDecPath);
  describe('df_dec', dfDec);

  // ---------------------------------------------------------------------------
  // Build shape-correct dummy inputs based on the DFN3 config:
  //   sr           = 48000
  //   fft_size     = 960
  //   hop_size     = 480           → 10 ms frames @ 48 kHz, 50 fps
  //   nb_freq      = 481           → fft_size/2 + 1
  //   nb_erb       = 32            → ERB band gain count
  //   nb_df        = 96            → low-frequency bins covered by deep filter
  //   conv_lookahead = 2           → encoder uses 2-frame lookahead
  //   df_order     = 5             → deep filter order
  //
  // We dispatch a single 1-frame batch (T=1) since the export uses dynamic
  // time dimension.
  // ---------------------------------------------------------------------------
  const T = 1;
  const NB_ERB = 32;
  const NB_DF = 96;
  const NB_FREQ = 481;
  const DF_ORDER = 5;

  // ---- Encoder ---------------------------------------------------------------
  // Inspecting the libDF tract.rs source: encoder takes
  //   feat_erb : [B, 1, T, nb_erb]              ERB-band log power features
  //   feat_spec: [B, 2, T, nb_df]               complex (re/im) low-band spec
  // and returns:
  //   e0, e1, e2, e3 (skip connections), emb (gru embedding), c0
  console.log('\n[enc] forward pass with dummy inputs');
  const featErb = new ort.Tensor('float32', rand(1 * 1 * T * NB_ERB), [1, 1, T, NB_ERB]);
  const featSpec = new ort.Tensor('float32', rand(1 * 2 * T * NB_DF), [1, 2, T, NB_DF]);
  const encInputs = {};
  // Bind by declared input order
  encInputs[enc.inputNames[0]] = featErb;
  encInputs[enc.inputNames[1]] = featSpec;
  let encOut;
  try {
    encOut = await enc.run(encInputs);
  } catch (e) {
    console.log(`  first attempt failed: ${e.message}`);
    console.log('  retrying with swapped argument order...');
    const swapped = {};
    swapped[enc.inputNames[0]] = featSpec;
    swapped[enc.inputNames[1]] = featErb;
    encOut = await enc.run(swapped);
  }
  for (const k of Object.keys(encOut)) {
    if (!checkNonNaN(k, encOut[k])) {
      throw new Error(`encoder output ${k} contains NaN`);
    }
  }

  // ---- ERB decoder -----------------------------------------------------------
  // Takes the encoder skip connections + embedding, returns ERB-band gains
  // shaped [B, 1, T, nb_erb].
  console.log('\n[erb_dec] forward pass — wiring encoder outputs by name');
  const erbDecInputs = {};
  for (const inputName of erbDec.inputNames) {
    if (encOut[inputName] !== undefined) {
      erbDecInputs[inputName] = encOut[inputName];
    } else {
      // Fall back: positional from the encoder outputs that haven't been bound
      const unused = enc.outputNames.find(
        (n) => encOut[n] && !Object.values(erbDecInputs).includes(encOut[n]),
      );
      console.log(`  WARNING: erb_dec input '${inputName}' not in encoder outputs by name; positional fallback to '${unused}'`);
      erbDecInputs[inputName] = encOut[unused];
    }
  }
  const erbDecOut = await erbDec.run(erbDecInputs);
  for (const k of Object.keys(erbDecOut)) {
    if (!checkNonNaN(k, erbDecOut[k])) {
      throw new Error(`erb_dec output ${k} contains NaN`);
    }
  }

  // ---- DF decoder ------------------------------------------------------------
  // Takes (some of) the encoder outputs + embedding, returns deep-filter
  // complex coefficients shaped [B, T, nb_df, df_order, 2] (or similar).
  console.log('\n[df_dec] forward pass — wiring encoder outputs by name');
  const dfDecInputs = {};
  for (const inputName of dfDec.inputNames) {
    if (encOut[inputName] !== undefined) {
      dfDecInputs[inputName] = encOut[inputName];
    } else {
      const unused = enc.outputNames.find(
        (n) => encOut[n] && !Object.values(dfDecInputs).includes(encOut[n]),
      );
      console.log(`  WARNING: df_dec input '${inputName}' not in encoder outputs by name; positional fallback to '${unused}'`);
      dfDecInputs[inputName] = encOut[unused];
    }
  }
  const dfDecOut = await dfDec.run(dfDecInputs);
  for (const k of Object.keys(dfDecOut)) {
    if (!checkNonNaN(k, dfDecOut[k])) {
      throw new Error(`df_dec output ${k} contains NaN`);
    }
  }

  console.log(
    `\nDFN3 sample rate: 48000 Hz, FFT size: 960, hop size: 480 (10 ms), nb_erb: ${NB_ERB}, nb_df: ${NB_DF}, df_order: ${DF_ORDER}`,
  );
  console.log('\nSpike 0b.1 completed successfully — all three DFN3 sub-graphs loaded and produced non-NaN outputs.');
}

run().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
