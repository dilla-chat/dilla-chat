// Programmatic notification sounds using Web Audio API — no audio files needed.

import { useUserSettingsStore } from '../stores/userSettingsStore';

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

function playTone(frequency: number, duration: number, type: OscillatorType = 'sine', volume = 0.15) {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(frequency, ctx.currentTime);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch {
    // AudioContext not available
  }
}

/** Short rising two-tone chime — someone joined the voice channel. */
export function playJoinSound() {
  if (!useUserSettingsStore.getState().soundNotifications) return;
  try {
    playTone(440, 0.12, 'sine', 0.12);
    setTimeout(() => {
      playTone(554, 0.15, 'sine', 0.12);
    }, 80);
  } catch {
    // ignore
  }
}

/** Short falling tone — someone left the voice channel. */
export function playLeaveSound() {
  if (!useUserSettingsStore.getState().soundNotifications) return;
  try {
    playTone(440, 0.12, 'sine', 0.1);
    setTimeout(() => {
      playTone(330, 0.18, 'sine', 0.1);
    }, 80);
  } catch {
    // ignore
  }
}
