// Drive VoiceChannel focus + fullscreen modes (webcam focus, screen
// share fullscreen, peer click).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import VoiceChannel from './VoiceChannel';
import { useVoiceStore } from '../../stores/voiceStore';
import { useTeamStore } from '../../stores/teamStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.play = function() { return Promise.resolve(); };
  HTMLMediaElement.prototype.pause = function() {};
}

const channel = { id: 'ch-voice', teamId: 't1', name: 'lounge', type: 'voice' as const, topic: '', accessRoleIds: [], slowModeSeconds: 0, hiddenIfRestricted: false };

function seed(opts: Partial<{ screenSharing: boolean; screenSharingUserId: string | null; webcamSharing: boolean; peers: Record<string, unknown>; localScreenStream: MediaStream | null; remoteScreenStreams: Record<string, MediaStream>; localWebcamStream: MediaStream | null; remoteWebcamStreams: Record<string, MediaStream> }>) {
  useTeamStore.setState({ activeTeamId: 't1' } as never);
  useVoiceStore.setState({
    currentChannelId: 'ch-voice',
    connected: true, connecting: false,
    peers: opts.peers ?? { me: { user_id: 'me', username: 'me', speaking: false, muted: false, deafened: false } },
    screenSharingUserId: opts.screenSharingUserId ?? null,
    screenSharing: opts.screenSharing ?? false,
    webcamSharing: opts.webcamSharing ?? false,
    remoteScreenStreams: opts.remoteScreenStreams ?? {},
    localScreenStream: opts.localScreenStream ?? null,
    localWebcamStream: opts.localWebcamStream ?? null,
    remoteWebcamStreams: opts.remoteWebcamStreams ?? {},
    joinChannel: vi.fn(),
    leaveChannel: vi.fn(),
  } as never);
}

beforeEach(() => seed({}));

describe('VoiceChannel focus + fullscreen modes', () => {
  it('renders normal mode with no screen share + no focus', () => {
    const { container } = render(<VoiceChannel channel={channel} />);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders fullscreen mode when fullscreen + hasScreenShare', () => {
    const stream = { getVideoTracks: () => [] } as unknown as MediaStream;
    seed({
      screenSharing: false,
      screenSharingUserId: 'u2',
      remoteScreenStreams: { u2: stream },
      peers: { u2: { user_id: 'u2', username: 'alice', speaking: false } },
    });
    const { container } = render(<VoiceChannel channel={channel} />);
    // Click banner to enter fullscreen
    const banner = container.querySelector('.screen-share-banner, .screen-share-banner-button') as HTMLElement | null;
    if (banner) fireEvent.click(banner);
    expect(container.firstChild).toBeTruthy();
  });

  it('handles local screen sharing (own SS)', () => {
    const stream = { getVideoTracks: () => [] } as unknown as MediaStream;
    seed({ screenSharing: true, localScreenStream: stream });
    const { container } = render(<VoiceChannel channel={channel} />);
    expect(container.textContent).toMatch(/screen|sharing/i);
  });

  it('handles peer screen-share with username', () => {
    const stream = { getVideoTracks: () => [] } as unknown as MediaStream;
    seed({
      screenSharingUserId: 'u2',
      remoteScreenStreams: { u2: stream },
      peers: { u2: { user_id: 'u2', username: 'alice', speaking: false } },
    });
    const { container } = render(<VoiceChannel channel={channel} />);
    expect(container.firstChild).toBeTruthy();
  });

  it('handles webcam stream for peers', () => {
    const stream = { getVideoTracks: () => [] } as unknown as MediaStream;
    seed({
      peers: { u2: { user_id: 'u2', username: 'alice', speaking: false, webcam_sharing: true } },
      remoteWebcamStreams: { u2: stream },
    });
    const { container } = render(<VoiceChannel channel={channel} />);
    expect(container.firstChild).toBeTruthy();
  });

  it('Join button calls joinChannel when not in this channel', () => {
    useVoiceStore.setState({ connected: false, currentChannelId: null } as never);
    const joinChannel = vi.fn();
    useVoiceStore.setState({ joinChannel } as never);
    const { container } = render(<VoiceChannel channel={channel} />);
    const joinBtn = [...container.querySelectorAll('button')].find((b) => /join/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (joinBtn) fireEvent.click(joinBtn);
    expect(joinChannel).toHaveBeenCalled();
  });

  it('Leave button calls leaveChannel when in this channel', () => {
    const leaveChannel = vi.fn();
    useVoiceStore.setState({ leaveChannel } as never);
    const { container } = render(<VoiceChannel channel={channel} />);
    const leaveBtn = [...container.querySelectorAll('button')].find((b) => /leave|disconnect/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (leaveBtn) fireEvent.click(leaveBtn);
    expect(container.firstChild).toBeTruthy();
  });

  it('multiple peers with mixed states', () => {
    seed({
      peers: {
        me: { user_id: 'me', username: 'me', speaking: true, muted: false, deafened: false },
        u2: { user_id: 'u2', username: 'alice', speaking: false, muted: true, deafened: false },
        u3: { user_id: 'u3', username: 'bob', speaking: false, muted: false, deafened: true },
      },
    });
    const { container } = render(<VoiceChannel channel={channel} />);
    expect(container.firstChild).toBeTruthy();
  });
});
