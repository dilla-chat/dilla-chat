// Public pipeline API: assembles the AudioWorklet ring-pump, the
// SharedArrayBuffer ring buffers, and the inference Worker into a single
// `Pipeline` object that exposes a cleaned `MediaStreamTrack` for an input
// `MediaStreamTrack`.
//
// Models are loaded once per AudioContext lifetime. Subsequent
// `createPipeline` calls reuse the same Worker and re-attach to it with a
// fresh stream id and ring pair.

import { createRing } from './audioWorklet/ringProtocol';

const INPUT_RING_CAPACITY = 16384; // ~340 ms at 48 kHz
const OUTPUT_RING_CAPACITY = 16384;

export interface PipelineConfig {
  audioContext: AudioContext;
  worker: Worker;
  track: MediaStreamTrack;
  /**
   * Identifier of the previously-loaded `models-loaded` session in the
   * worker. The caller is responsible for posting the `load-models`
   * message and waiting for the `models-loaded` reply before constructing
   * a pipeline.
   */
  sessionId: string;
}

export interface Pipeline {
  outputTrack: MediaStreamTrack;
  destroy(): void;
}

let nextStreamId = 0;

export function createPipeline(config: PipelineConfig): Pipeline {
  const streamId = `stream-${nextStreamId++}`;
  const inputRing = createRing(INPUT_RING_CAPACITY);
  const outputRing = createRing(OUTPUT_RING_CAPACITY);

  config.worker.postMessage({
    type: 'attach-stream',
    sessionId: config.sessionId,
    streamId,
    inputSab: inputRing.sab,
    outputSab: outputRing.sab,
    inputCapacity: INPUT_RING_CAPACITY,
    outputCapacity: OUTPUT_RING_CAPACITY,
  });

  const workletNode = new AudioWorkletNode(config.audioContext, 'voice-iso-ring-pump', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      inputSab: inputRing.sab,
      outputSab: outputRing.sab,
      inputCapacity: INPUT_RING_CAPACITY,
      outputCapacity: OUTPUT_RING_CAPACITY,
    },
  });

  const source = config.audioContext.createMediaStreamSource(
    new MediaStream([config.track]),
  );
  const destination = config.audioContext.createMediaStreamDestination();
  source.connect(workletNode);
  workletNode.connect(destination);

  return {
    outputTrack: destination.stream.getAudioTracks()[0],
    destroy() {
      config.worker.postMessage({ type: 'detach-stream', streamId });
      try {
        workletNode.disconnect();
      } catch {
        // already disconnected
      }
      try {
        source.disconnect();
      } catch {
        // already disconnected
      }
    },
  };
}
