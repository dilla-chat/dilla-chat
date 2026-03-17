/**
 * Type declarations for WebRTC Encoded Transforms API.
 * These APIs are available in Chrome 86+ / Edge 86+ but not yet in TypeScript's lib.dom.d.ts.
 */

interface RTCRtpScriptTransformConstructor {
  new (worker: Worker, options?: Record<string, unknown>): RTCRtpScriptTransform;
}

interface RTCRtpScriptTransform {
  readonly port: MessagePort;
}

declare const RTCRtpScriptTransform: RTCRtpScriptTransformConstructor;

interface RTCRtpSender {
  transform: RTCRtpScriptTransform | null;
}

interface RTCRtpReceiver {
  transform: RTCRtpScriptTransform | null;
}

interface RTCEncodedAudioFrame {
  readonly timestamp: number;
  data: ArrayBuffer;
  getMetadata(): RTCEncodedAudioFrameMetadata;
}

interface RTCEncodedAudioFrameMetadata {
  synchronizationSource?: number;
  payloadType?: number;
  contributingSources?: number[];
}

interface RTCEncodedVideoFrame {
  readonly timestamp: number;
  readonly type: 'key' | 'delta' | 'empty';
  data: ArrayBuffer;
  getMetadata(): RTCEncodedVideoFrameMetadata;
}

interface RTCEncodedVideoFrameMetadata {
  synchronizationSource?: number;
  payloadType?: number;
  contributingSources?: number[];
  frameId?: number;
  dependencies?: number[];
  width?: number;
  height?: number;
}

interface RTCTransformEvent extends Event {
  readonly transformer: {
    readonly readable: ReadableStream;
    readonly writable: WritableStream;
    readonly options?: Record<string, unknown>;
  };
}

interface DedicatedWorkerGlobalScope {
  onrtctransform: ((event: RTCTransformEvent) => void) | null;
}
