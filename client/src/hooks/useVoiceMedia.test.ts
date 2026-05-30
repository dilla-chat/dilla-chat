import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceMedia } from './useVoiceMedia';
import { useVoiceStore } from '../stores/voiceStore';

describe('useVoiceMedia', () => {
  beforeEach(() => {
    useVoiceStore.setState({
      screenSharing: false,
      webcamSharing: false,
      localScreenStream: null,
      remoteScreenStreams: {},
      localWebcamStream: null,
      remoteWebcamStreams: {},
    });
  });

  it('selects the voice media slice', () => {
    const { result } = renderHook(() => useVoiceMedia());
    expect(result.current.screenSharing).toBe(false);
    expect(result.current.webcamSharing).toBe(false);
    expect(result.current.localScreenStream).toBeNull();
    expect(result.current.localWebcamStream).toBeNull();
    expect(result.current.remoteScreenStreams).toEqual({});
    expect(result.current.remoteWebcamStreams).toEqual({});
  });

  it('exposes setScreenSharing / setWebcamSharing setters', () => {
    const { result } = renderHook(() => useVoiceMedia());
    expect(typeof result.current.setScreenSharing).toBe('function');
    expect(typeof result.current.setWebcamSharing).toBe('function');
    expect(typeof result.current.setLocalScreenStream).toBe('function');
    expect(typeof result.current.setLocalWebcamStream).toBe('function');
  });

  it('re-renders when screenSharing changes in the store', () => {
    const { result, rerender } = renderHook(() => useVoiceMedia());
    expect(result.current.screenSharing).toBe(false);
    act(() => {
      result.current.setScreenSharing(true);
    });
    rerender();
    expect(result.current.screenSharing).toBe(true);
  });

  it('useShallow stops re-render when an unrelated slice changes', () => {
    const { result } = renderHook(() => useVoiceMedia());
    const before = result.current;
    // Mutate an unrelated field on the same store.
    act(() => {
      useVoiceStore.setState({ muted: true } as never);
    });
    // useShallow ensures the result reference stays equal when none of
    // the picked fields changed.
    expect(result.current).toBe(before);
  });
});
