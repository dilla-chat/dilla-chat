// Spike 0a: VoiceFilter ONNX availability test
//
// Loads the ailia-models VoiceFilter ONNX checkpoint (mask predictor + d-vector
// embedder) via onnxruntime-node, runs it on the bundled mixed.wav reference
// input using ref-voice.wav as the enrollment, computes SNR improvement against
// the published expected output, and prints a summary.
//
// This is a throwaway script. It only needs to:
//   1. Confirm both ONNX graphs load.
//   2. Print the input/output tensor names + shapes (so we can fill the spec memo).
//   3. Run a real inference end-to-end.
//   4. Compute SNR improvement vs the bundled expected output.
//
// We re-implement the (very small) STFT / mel front-end in pure JS so we don't
// have to pull a Python toolchain into the spike. Hyperparameters are taken
// verbatim from ailia-models/audio_processing/voicefilter/audio_utils.py.

import * as ort from 'onnxruntime-node';
import wavefilePkg from 'wavefile';
const { WaveFile } = wavefilePkg;
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS = resolve(__dirname, 'models');

// ---- Hyperparameters (from ailia voicefilter/audio_utils.py) ----------------

const SR = 16000;

// Mask model STFT
const MASK_NFFT = 1200;
const MASK_HOP = 160;
const MASK_WIN = 400;
const MASK_FREQ = MASK_NFFT / 2 + 1; // 601
const MIN_LEVEL_DB = -100.0;
const REF_LEVEL_DB = 20.0;

// Embedder STFT
const EMB_NFFT = 512;
const EMB_NMELS = 40;

// ---- Tiny DSP helpers --------------------------------------------------------

function loadWavMono16k(path) {
  const wf = new WaveFile(readFileSync(path));
  wf.toBitDepth('32f');
  wf.toSampleRate(SR);
  let samples = wf.getSamples();
  if (Array.isArray(samples) && samples.length > 0 && samples[0]?.length !== undefined) {
    // multi-channel — average to mono
    const ch = samples;
    const n = ch[0].length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < ch.length; c++) s += ch[c][i];
      out[i] = s / ch.length;
    }
    return out;
  }
  return Float32Array.from(samples);
}

function hannWindow(N) {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  return w;
}

// Real-input naive DFT (O(N^2)) — we only call it on N=512 and N=1200
// frames a few times, so this is fine for a spike.
function rfft(frame, nfft) {
  // frame.length === nfft (zero-padded)
  const re = new Float32Array(nfft / 2 + 1);
  const im = new Float32Array(nfft / 2 + 1);
  for (let k = 0; k <= nfft / 2; k++) {
    let sr = 0,
      si = 0;
    for (let n = 0; n < nfft; n++) {
      const ang = (-2 * Math.PI * k * n) / nfft;
      sr += frame[n] * Math.cos(ang);
      si += frame[n] * Math.sin(ang);
    }
    re[k] = sr;
    im[k] = si;
  }
  return { re, im };
}

function irfft(re, im, nfft) {
  const out = new Float32Array(nfft);
  for (let n = 0; n < nfft; n++) {
    let s = 0;
    for (let k = 0; k <= nfft / 2; k++) {
      const ang = (2 * Math.PI * k * n) / nfft;
      const c = Math.cos(ang);
      const ss = Math.sin(ang);
      // Hermitian symmetry: contribute conjugate for k in (0, nfft/2)
      const w = k === 0 || k === nfft / 2 ? 1 : 2;
      s += w * (re[k] * c - im[k] * ss);
    }
    out[n] = s / nfft;
  }
  return out;
}

// librosa-style centered STFT with Hann window
function stft(y, nfft, hop, win) {
  const window = hannWindow(win);
  const padBefore = Math.floor(nfft / 2);
  const padded = new Float32Array(y.length + padBefore * 2);
  // reflect padding
  for (let i = 0; i < padBefore; i++) padded[i] = y[padBefore - i] ?? 0;
  padded.set(y, padBefore);
  for (let i = 0; i < padBefore; i++)
    padded[padded.length - 1 - i] = y[y.length - 1 - (padBefore - 1 - i)] ?? 0;

  const numFrames = 1 + Math.floor((padded.length - nfft) / hop);
  const freqBins = nfft / 2 + 1;
  const mag = new Float32Array(numFrames * freqBins);
  const phase = new Float32Array(numFrames * freqBins);

  const winPadStart = Math.floor((nfft - win) / 2);
  const frame = new Float32Array(nfft);

  for (let f = 0; f < numFrames; f++) {
    frame.fill(0);
    for (let i = 0; i < win; i++) {
      frame[winPadStart + i] = padded[f * hop + winPadStart + i] * window[i];
    }
    const { re, im } = rfft(frame, nfft);
    for (let k = 0; k < freqBins; k++) {
      mag[f * freqBins + k] = Math.hypot(re[k], im[k]);
      phase[f * freqBins + k] = Math.atan2(im[k], re[k]);
    }
  }
  return { mag, phase, numFrames, freqBins };
}

function istft(mag, phase, numFrames, freqBins, nfft, hop, win) {
  const window = hannWindow(win);
  const winPadStart = Math.floor((nfft - win) / 2);
  const padBefore = Math.floor(nfft / 2);
  const length = nfft + (numFrames - 1) * hop;
  const out = new Float32Array(length);
  const norm = new Float32Array(length);
  for (let f = 0; f < numFrames; f++) {
    const re = new Float32Array(freqBins);
    const im = new Float32Array(freqBins);
    for (let k = 0; k < freqBins; k++) {
      const m = mag[f * freqBins + k];
      const p = phase[f * freqBins + k];
      re[k] = m * Math.cos(p);
      im[k] = m * Math.sin(p);
    }
    const frame = irfft(re, im, nfft);
    for (let i = 0; i < win; i++) {
      const idx = f * hop + winPadStart + i;
      out[idx] += frame[winPadStart + i] * window[i];
      norm[idx] += window[i] * window[i];
    }
  }
  for (let i = 0; i < length; i++) if (norm[i] > 1e-8) out[i] /= norm[i];
  // strip the centered-padding offset
  return out.slice(padBefore, padBefore + length - 2 * padBefore);
}

// Mel filter bank (HTK-like, librosa default 'slaney' is fine for this spike's
// rough validation)
function melFilterbank(sr, nfft, nmels) {
  const fmin = 0;
  const fmax = sr / 2;
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const invMel = (m) => 700 * (Math.pow(10, m / 2595) - 1);
  const mmin = mel(fmin);
  const mmax = mel(fmax);
  const points = new Float32Array(nmels + 2);
  for (let i = 0; i < points.length; i++)
    points[i] = invMel(mmin + ((mmax - mmin) * i) / (nmels + 1));
  const bins = points.map((f) => Math.floor(((nfft + 1) * f) / sr));
  const fb = new Array(nmels);
  const numFreq = nfft / 2 + 1;
  for (let m = 1; m <= nmels; m++) {
    const row = new Float32Array(numFreq);
    const lo = bins[m - 1],
      mid = bins[m],
      hi = bins[m + 1];
    for (let k = lo; k < mid; k++) row[k] = (k - lo) / Math.max(1, mid - lo);
    for (let k = mid; k < hi; k++) row[k] = (hi - k) / Math.max(1, hi - mid);
    fb[m - 1] = row;
  }
  return fb;
}

function getMelForEmbedder(y) {
  const { mag, numFrames, freqBins } = stft(y, EMB_NFFT, MASK_HOP, MASK_WIN);
  const power = new Float32Array(mag.length);
  for (let i = 0; i < mag.length; i++) power[i] = mag[i] * mag[i];
  const fb = melFilterbank(SR, EMB_NFFT, EMB_NMELS);
  // mel: [n_mels, n_frames]
  const out = new Float32Array(EMB_NMELS * numFrames);
  for (let m = 0; m < EMB_NMELS; m++) {
    for (let f = 0; f < numFrames; f++) {
      let s = 0;
      for (let k = 0; k < freqBins; k++) s += fb[m][k] * power[f * freqBins + k];
      out[m * numFrames + f] = Math.log10(s + 1e-6);
    }
  }
  return { data: out, shape: [EMB_NMELS, numFrames] };
}

function ampToDb(x) {
  return 20 * Math.log10(Math.max(1e-5, x));
}
function dbToAmp(x) {
  return Math.pow(10, x * 0.05);
}

function magToNormDb(magArr) {
  // S = amp_to_db(|D|) - REF_LEVEL_DB
  // S_norm = clip(S / -MIN_LEVEL_DB, -1, 0) + 1
  const out = new Float32Array(magArr.length);
  for (let i = 0; i < magArr.length; i++) {
    const s = ampToDb(magArr[i]) - REF_LEVEL_DB;
    let n = s / -MIN_LEVEL_DB;
    if (n < -1) n = -1;
    if (n > 0) n = 0;
    out[i] = n + 1;
  }
  return out;
}

function normDbToMag(normArr) {
  const out = new Float32Array(normArr.length);
  for (let i = 0; i < normArr.length; i++) {
    let n = normArr[i];
    if (n < 0) n = 0;
    if (n > 1) n = 1;
    const s = (n - 1) * -MIN_LEVEL_DB;
    out[i] = dbToAmp(s + REF_LEVEL_DB);
  }
  return out;
}

// Compute SNR vs reference (energy ratio in dB)
function snr(signal, reference) {
  const n = Math.min(signal.length, reference.length);
  let sigE = 0,
    noiseE = 0;
  for (let i = 0; i < n; i++) {
    sigE += reference[i] * reference[i];
    const d = signal[i] - reference[i];
    noiseE += d * d;
  }
  if (noiseE < 1e-12) return Infinity;
  return 10 * Math.log10(sigE / noiseE);
}

// ---- Smoke test --------------------------------------------------------------

function describe(name, sess) {
  console.log(`\n[${name}]`);
  console.log('  inputs:');
  for (const n of sess.inputNames) {
    const meta = sess.inputMetadata?.[n] ?? {};
    console.log(`    - ${n}  dims=${JSON.stringify(meta.dimensions ?? meta.shape ?? '?')}  type=${meta.type ?? '?'}`);
  }
  console.log('  outputs:');
  for (const n of sess.outputNames) {
    const meta = sess.outputMetadata?.[n] ?? {};
    console.log(`    - ${n}  dims=${JSON.stringify(meta.dimensions ?? meta.shape ?? '?')}  type=${meta.type ?? '?'}`);
  }
}

async function run() {
  console.log('=== Spike 0a: VoiceFilter ONNX availability ===\n');

  const embedderPath = resolve(MODELS, 'voicefilter_embedder.onnx');
  const modelPath = resolve(MODELS, 'voicefilter_model.onnx');

  console.log(`Loading embedder: ${embedderPath}`);
  const embedder = await ort.InferenceSession.create(embedderPath);
  describe('embedder', embedder);

  console.log(`\nLoading mask model: ${modelPath}`);
  const model = await ort.InferenceSession.create(modelPath);
  describe('mask model', model);

  // Load fixtures
  const refWav = loadWavMono16k(resolve(MODELS, 'ref-voice.wav'));
  const mixedWav = loadWavMono16k(resolve(MODELS, 'mixed.wav'));
  const expectedWav = loadWavMono16k(resolve(MODELS, 'output_reference.wav'));
  console.log(
    `\nFixtures: ref=${refWav.length} samp, mixed=${mixedWav.length} samp, expected=${expectedWav.length} samp`,
  );

  // Compute d-vector embedding
  // Embedder expects fixed time dim 301 (≈3s at hop=160). Truncate / loop ref.
  const EMB_TIME = 301;
  let mel = getMelForEmbedder(refWav);
  if (mel.shape[1] < EMB_TIME) {
    // tile
    const tiled = new Float32Array(EMB_NMELS * EMB_TIME);
    for (let m = 0; m < EMB_NMELS; m++) {
      for (let t = 0; t < EMB_TIME; t++) {
        tiled[m * EMB_TIME + t] = mel.data[m * mel.shape[1] + (t % mel.shape[1])];
      }
    }
    mel = { data: tiled, shape: [EMB_NMELS, EMB_TIME] };
  } else if (mel.shape[1] > EMB_TIME) {
    const trimmed = new Float32Array(EMB_NMELS * EMB_TIME);
    for (let m = 0; m < EMB_NMELS; m++) {
      for (let t = 0; t < EMB_TIME; t++) {
        trimmed[m * EMB_TIME + t] = mel.data[m * mel.shape[1] + t];
      }
    }
    mel = { data: trimmed, shape: [EMB_NMELS, EMB_TIME] };
  }
  console.log(`embedder mel shape: ${JSON.stringify(mel.shape)}`);
  const embIn = new ort.Tensor('float32', mel.data, mel.shape);
  const embInputName = embedder.inputNames[0];
  const embOut = await embedder.run({ [embInputName]: embIn });
  const embOutName = embedder.outputNames[0];
  const dvec = embOut[embOutName];
  console.log(`\nd-vector shape=${JSON.stringify(dvec.dims)} length=${dvec.data.length}`);
  console.log(`  first 6 values: ${Array.from(dvec.data.slice(0, 6)).map((x) => x.toFixed(4)).join(', ')}`);

  // STFT the mixed signal -> normalized magnitude in [time, freq]
  const { mag, phase, numFrames, freqBins } = stft(mixedWav, MASK_NFFT, MASK_HOP, MASK_WIN);
  console.log(`mixed STFT: numFrames=${numFrames} freqBins=${freqBins}`);

  // Transpose [freq, time] -> [time, freq] (input to model)
  const magTF = new Float32Array(numFrames * freqBins);
  for (let f = 0; f < numFrames; f++) {
    for (let k = 0; k < freqBins; k++) {
      magTF[f * freqBins + k] = mag[f * freqBins + k]; // already [t, f] from our stft impl
    }
  }
  const magNorm = magToNormDb(magTF);

  // Build inputs: shape [1, time, freq] for mag, [1, dvec_dim] for d-vector
  const dvecData = new Float32Array(dvec.data);
  const dvecBatched = new ort.Tensor('float32', dvecData, [1, dvecData.length]);
  const magBatched = new ort.Tensor('float32', magNorm, [1, numFrames, freqBins]);

  const modelInputs = {};
  // Bind by order, fall back to known names if order is unstable
  modelInputs[model.inputNames[0]] = magBatched;
  modelInputs[model.inputNames[1]] = dvecBatched;
  console.log(`\nRunning mask model with inputs: ${model.inputNames.join(', ')}`);

  let output;
  try {
    output = await model.run(modelInputs);
  } catch (e) {
    // Try swapping argument order
    console.log(`  first call failed (${e.message}), retrying with swapped inputs...`);
    const swapped = {};
    swapped[model.inputNames[0]] = dvecBatched;
    swapped[model.inputNames[1]] = magBatched;
    output = await model.run(swapped);
  }
  const outName = model.outputNames[0];
  const maskTensor = output[outName];
  console.log(`mask output shape=${JSON.stringify(maskTensor.dims)} len=${maskTensor.data.length}`);

  // Sanity: any NaNs?
  let nans = 0,
    minV = Infinity,
    maxV = -Infinity;
  for (const v of maskTensor.data) {
    if (Number.isNaN(v)) nans++;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  console.log(`  NaN count: ${nans}, range: [${minV.toFixed(4)}, ${maxV.toFixed(4)}]`);

  // Apply mask: estMag = magNorm * mask, then denormalize, then iSTFT with original phase
  const maskArr = new Float32Array(maskTensor.data);
  const estNorm = new Float32Array(magNorm.length);
  for (let i = 0; i < magNorm.length; i++) estNorm[i] = magNorm[i] * maskArr[i];
  const estMag = normDbToMag(estNorm);

  const enhanced = istft(estMag, phase, numFrames, freqBins, MASK_NFFT, MASK_HOP, MASK_WIN);
  console.log(`enhanced length=${enhanced.length}`);

  // SNR comparison vs the bundled expected output (which IS the ailia
  // reference inference output, so what we want is for our enhanced to be
  // close to it AND for both to be much closer to clean than the mixed input).
  const snrInputVsExpected = snr(mixedWav, expectedWav);
  const snrEnhancedVsExpected = snr(enhanced, expectedWav);
  const improvement = snrEnhancedVsExpected - snrInputVsExpected;

  console.log('\n=== SNR results (vs ailia reference output) ===');
  console.log(`  mixed -> ref:    ${snrInputVsExpected.toFixed(2)} dB`);
  console.log(`  enhanced -> ref: ${snrEnhancedVsExpected.toFixed(2)} dB`);
  console.log(`  improvement:     ${improvement.toFixed(2)} dB`);

  // Synthetic-noise SNR test (sine wave + white noise -> sine wave)
  console.log('\n=== Synthetic SNR test ===');
  const N = SR * 2;
  const clean = new Float32Array(N);
  for (let i = 0; i < N; i++)
    clean[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR) +
      0.2 * Math.sin((2 * Math.PI * 660 * i) / SR);
  const noisy = new Float32Array(N);
  for (let i = 0; i < N; i++) noisy[i] = clean[i] + 0.5 * (Math.random() * 2 - 1);
  console.log(`  baseline SNR (noisy vs clean): ${snr(noisy, clean).toFixed(2)} dB`);

  console.log('\nSpike script completed successfully.');
}

run().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
