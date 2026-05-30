import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PushToTalkManager } from './pushToTalk';
import { useAudioSettingsStore } from '../../stores/audioSettingsStore';

const voiceMuteMock = vi.fn();
vi.mock('../websocket', () => ({
  ws: { voiceMute: (...a: unknown[]) => voiceMuteMock(...a) },
}));

function makeStreamWithAudio() {
  const track = { enabled: true } as unknown as MediaStreamTrack;
  const stream = {
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

describe('PushToTalkManager', () => {
  beforeEach(() => {
    voiceMuteMock.mockReset();
    useAudioSettingsStore.setState({ pushToTalk: false, pushToTalkKey: 'Space' } as never);
  });

  it('setupPTT is a no-op when pushToTalk is disabled', () => {
    const mgr = new PushToTalkManager();
    const { stream, track } = makeStreamWithAudio();
    mgr.setupPTT(stream, 't1', 'c1');
    expect(track.enabled).toBe(true); // unchanged
    mgr.cleanupPTT();
  });

  it('mutes the mic immediately when PTT is enabled', () => {
    useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'Space' } as never);
    const mgr = new PushToTalkManager();
    const { stream, track } = makeStreamWithAudio();
    mgr.setupPTT(stream, 't1', 'c1');
    expect(track.enabled).toBe(false);
    mgr.cleanupPTT();
  });

  it('keydown with the configured key un-mutes the mic + sends voiceMute(false)', () => {
    useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'Space' } as never);
    const mgr = new PushToTalkManager();
    const { stream, track } = makeStreamWithAudio();
    mgr.setupPTT(stream, 't1', 'c1');

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    expect(track.enabled).toBe(true);
    expect(voiceMuteMock).toHaveBeenCalledWith('t1', 'c1', false);
    mgr.cleanupPTT();
  });

  it('keyup with the configured key re-mutes the mic + sends voiceMute(true)', () => {
    useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'Space' } as never);
    const mgr = new PushToTalkManager();
    const { stream, track } = makeStreamWithAudio();
    mgr.setupPTT(stream, 't1', 'c1');

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    voiceMuteMock.mockClear();
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
    expect(track.enabled).toBe(false);
    expect(voiceMuteMock).toHaveBeenCalledWith('t1', 'c1', true);
    mgr.cleanupPTT();
  });

  it('keys other than the configured PTT key do nothing', () => {
    useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'Space' } as never);
    const mgr = new PushToTalkManager();
    const { stream, track } = makeStreamWithAudio();
    mgr.setupPTT(stream, 't1', 'c1');

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }));
    expect(track.enabled).toBe(false); // still muted
    expect(voiceMuteMock).not.toHaveBeenCalled();
    mgr.cleanupPTT();
  });

  it('cleanupPTT removes all listeners', () => {
    useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'Space' } as never);
    const mgr = new PushToTalkManager();
    const { stream, track } = makeStreamWithAudio();
    mgr.setupPTT(stream, 't1', 'c1');
    mgr.cleanupPTT();

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    expect(track.enabled).toBe(false); // never un-muted
    expect(voiceMuteMock).not.toHaveBeenCalled();
  });

  it('does not send voiceMute when teamId or channelId is missing', () => {
    useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'Space' } as never);
    const mgr = new PushToTalkManager();
    const { stream, track } = makeStreamWithAudio();
    mgr.setupPTT(stream, null, null);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    expect(track.enabled).toBe(true);
    expect(voiceMuteMock).not.toHaveBeenCalled();
    mgr.cleanupPTT();
  });

  it('uses the LATEST pushToTalkKey from the store (re-reads per event)', () => {
    useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'Space' } as never);
    const mgr = new PushToTalkManager();
    const { stream, track } = makeStreamWithAudio();
    mgr.setupPTT(stream, 't1', 'c1');

    // Change the key after setup.
    useAudioSettingsStore.setState({ pushToTalkKey: 'KeyV' } as never);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' }));
    expect(track.enabled).toBe(true);
    mgr.cleanupPTT();
  });

  it('toggling pushToTalk off via the store cleans up + restores mic', () => {
    useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'Space' } as never);
    const mgr = new PushToTalkManager();
    const { stream, track } = makeStreamWithAudio();
    mgr.setupPTT(stream, 't1', 'c1');
    expect(track.enabled).toBe(false);

    useAudioSettingsStore.setState({ pushToTalk: false } as never);
    expect(track.enabled).toBe(true);
  });
});
