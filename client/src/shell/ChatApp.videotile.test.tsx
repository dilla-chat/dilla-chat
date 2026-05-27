// VideoTile is the one ChatApp.tsx export that lacks dedicated coverage.
// It's a pure presentational <video> wrapper with feature-detected
// requestVideoFrameCallback, so it tests cleanly in jsdom once we stub
// HTMLMediaElement.prototype.play (jsdom would otherwise reject).

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, act } from '@testing-library/react';

import { VideoTile } from './ChatApp';

beforeAll(() => {
  // jsdom's HTMLMediaElement.play() returns undefined and warns; stub it.
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined as never);
  HTMLMediaElement.prototype.pause = vi.fn();
});

function fakeStream(): MediaStream {
  // jsdom doesn't implement MediaStream; we only need a minimal shape
  // that survives srcObject assignment and the getVideoTracks() probe.
  return {
    id: 'stream-1',
    getVideoTracks: () => [],
    getAudioTracks: () => [],
    getTracks: () => [],
  } as unknown as MediaStream;
}

describe('VideoTile', () => {
  it('renders a <video> element with autoplay/playsInline/muted', () => {
    const { container } = render(<VideoTile stream={fakeStream()} />);
    const video = container.querySelector('video') as HTMLVideoElement | null;
    expect(video).toBeTruthy();
    expect(video!.autoplay).toBe(true);
    expect(video!.playsInline).toBe(true);
    expect(video!.muted).toBe(true);
  });

  it('applies object-fit="cover" by default', () => {
    const { container } = render(<VideoTile stream={fakeStream()} />);
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.style.objectFit).toBe('cover');
  });

  it('applies object-fit="contain" when fit="contain"', () => {
    const { container } = render(<VideoTile stream={fakeStream()} fit="contain" />);
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.style.objectFit).toBe('contain');
  });

  it('mirror prop applies scaleX(-1) transform', () => {
    const { container } = render(<VideoTile stream={fakeStream()} mirror />);
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.style.transform).toContain('scaleX(-1)');
  });

  it('non-mirror leaves the transform off', () => {
    const { container } = render(<VideoTile stream={fakeStream()} mirror={false} />);
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.style.transform).not.toContain('scaleX(-1)');
  });

  it('hides stats overlay when showStats={false}', () => {
    const { container } = render(<VideoTile stream={fakeStream()} showStats={false} />);
    // The stats overlay uses a known class on the wrapper; with showStats=false
    // it should not render any text label like fps/kbps.
    expect(container.textContent || '').not.toMatch(/fps|kbps/i);
  });

  it('assigns srcObject from the supplied stream', async () => {
    const stream = fakeStream();
    const { container } = render(<VideoTile stream={stream} />);
    await act(async () => {
      await Promise.resolve();
    });
    const video = container.querySelector('video') as HTMLVideoElement;
    // The component's effect should have set srcObject = stream.
    expect(video.srcObject).toBe(stream);
  });

  it('unmounts cleanly (cleanup teardown does not throw)', () => {
    const { unmount } = render(<VideoTile stream={fakeStream()} />);
    expect(() => unmount()).not.toThrow();
  });
});
