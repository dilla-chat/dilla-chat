import { useVoiceStore } from '../stores/voiceStore';
import { useShallow } from 'zustand/react/shallow';

export function useVoiceMedia() {
  return useVoiceStore(
    useShallow((s) => ({
      screenSharing: s.screenSharing,
      webcamSharing: s.webcamSharing,
      localScreenStream: s.localScreenStream,
      remoteScreenStream: s.remoteScreenStream,
      localWebcamStream: s.localWebcamStream,
      remoteWebcamStreams: s.remoteWebcamStreams,
      setScreenSharing: s.setScreenSharing,
      setWebcamSharing: s.setWebcamSharing,
      setLocalScreenStream: s.setLocalScreenStream,
      setLocalWebcamStream: s.setLocalWebcamStream,
    })),
  );
}
