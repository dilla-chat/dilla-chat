// AudioWorkletProcessor — buffer pump between audio thread and inference Worker.
//
// Each render quantum (typically 128 samples at the AudioContext's sample
// rate, expected to be 48 kHz) we:
//   1. Push the input render quantum into `inputSab` (samples consumed by
//      the inference worker).
//   2. Pull a render quantum from `outputSab` (samples produced by the
//      inference worker) and emit them as our processor output.
//
// Layout of each ring SAB matches `ringProtocol.ts`:
//   [Int32 writeIdx][Int32 readIdx][Float32 capacity samples ...]
//
// Both rings are configured large enough that an inference round-trip can
// fit comfortably without overflow under normal scheduling. Underrun on
// the output side is handled by emitting silence (audible blip — counted
// upstream by the diagnostics module).

const HEADER_INTS = 2;
const HEADER_BYTES = HEADER_INTS * 4;

class RingBufferProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    const { inputSab, outputSab, inputCapacity, outputCapacity } = options.processorOptions;
    this.inputInts = new Int32Array(inputSab, 0, HEADER_INTS);
    this.inputFloats = new Float32Array(inputSab, HEADER_BYTES, inputCapacity);
    this.outputInts = new Int32Array(outputSab, 0, HEADER_INTS);
    this.outputFloats = new Float32Array(outputSab, HEADER_BYTES, outputCapacity);
    this.inputCapacity = inputCapacity;
    this.outputCapacity = outputCapacity;
    this.droppedFrames = 0;
    this.underruns = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    // ---- Input -> input ring (single channel, mono mix if multi-channel) ----
    if (input && input.length > 0 && input[0]) {
      const frame = input[0];
      const writeIdx = Atomics.load(this.inputInts, 0);
      const readIdx = Atomics.load(this.inputInts, 1);
      const used = (writeIdx - readIdx + this.inputCapacity) % this.inputCapacity;
      const free = this.inputCapacity - used - 1;
      if (frame.length <= free) {
        for (let i = 0; i < frame.length; i++) {
          this.inputFloats[(writeIdx + i) % this.inputCapacity] = frame[i];
        }
        Atomics.store(this.inputInts, 0, (writeIdx + frame.length) % this.inputCapacity);
      } else {
        this.droppedFrames += frame.length;
      }
    }

    // ---- Output ring -> output channel(s) ----
    if (output && output.length > 0 && output[0]) {
      const oFrame = output[0];
      const writeIdx = Atomics.load(this.outputInts, 0);
      const readIdx = Atomics.load(this.outputInts, 1);
      const avail = (writeIdx - readIdx + this.outputCapacity) % this.outputCapacity;

      if (avail >= oFrame.length) {
        for (let i = 0; i < oFrame.length; i++) {
          oFrame[i] = this.outputFloats[(readIdx + i) % this.outputCapacity];
        }
        Atomics.store(this.outputInts, 1, (readIdx + oFrame.length) % this.outputCapacity);
      } else {
        // Underrun: emit silence and count.
        for (let i = 0; i < oFrame.length; i++) oFrame[i] = 0;
        this.underruns += 1;
      }
    }

    return true;
  }
}

registerProcessor('voice-iso-ring-pump', RingBufferProcessor);
