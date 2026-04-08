// DeepFilterNet 3 uses the Vorbis "sin-of-sin" window:
//   w[i] = sin( pi/2 * sin^2( pi * (i + 0.5) / (window_size/2) ) )
// for i in [0, window_size). This window is symmetric and gives perfect
// reconstruction with 50% hop overlap-add when paired with itself for
// analysis and synthesis (the standard COLA condition).
//
// The forward STFT additionally multiplies the output spectrum by `wnorm`:
//   wnorm = 1 / (window_size^2 / (2 * frame_size))
// which is the libDF convention. The inverse STFT does not apply any
// extra normalisation — the synthesis window plus overlap-add already
// reconstructs unity gain at the COLA condition.

export function makeVorbisWindow(windowSize: number): Float32Array {
  if (windowSize <= 0 || (windowSize & 1) !== 0) {
    throw new Error(`Vorbis window size must be a positive even integer, got ${windowSize}`);
  }
  const half = windowSize / 2;
  const w = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    const sin = Math.sin((0.5 * Math.PI * (i + 0.5)) / half);
    w[i] = Math.sin(0.5 * Math.PI * sin * sin);
  }
  return w;
}

export function computeWNorm(windowSize: number, frameSize: number): number {
  return 1 / (Math.pow(windowSize, 2) / (2 * frameSize));
}
