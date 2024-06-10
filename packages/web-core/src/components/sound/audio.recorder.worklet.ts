// https://github.com/microsoft/TypeScript/issues/28308
interface AudioWorkletProcessor {
  readonly port: MessagePort;
}
interface AudioWorkletProcessorImpl extends AudioWorkletProcessor {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare var AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  // eslint-disable-next-line prettier/prettier
  new (): AudioWorkletProcessor;
};
interface AudioWorkletProcessorConstructor {
  // eslint-disable-next-line prettier/prettier
  new (): AudioWorkletProcessorImpl;
}
declare function registerProcessor(
  name: string,
  processorCtor: AudioWorkletProcessorConstructor,
): void;

/**
 * This is a grpc audio bundler with some special consideration for speaking length. It has two timeouts of note:
 * 1. Waiting for more data in the audio stream. It assumes there is up to 50ms of "quiet" before it starts to think things are silent
 * 2. It waits for between 200ms and 1500ms to think that you are "done" speaking.
 * In essense, it drops "silent" packets that after you finish speaking but before you are "done" talking. It is natural to pause
 * for a moment while speaking and this handles such a case. It assumes that the longer you speak the more you are likely to pause
 */
class GrpcAudioWorkletProcessor extends AudioWorkletProcessor {
  leftChannel: Int16Array[];
  recordLength: number;
  startOfNoise: number | null;
  targetEndOfNoise: number | null;
  targetSilence: number;
  constructor() {
    super();
    this.leftChannel = [];
    this.recordLength = 0;
    this.port.onmessage = (event: any) => {
      if (event.data.kind === 'flush') {
        this.flush();
      }
    };
    const dtNow = Date.now();
    // Start off silent
    this.startOfNoise = null;
    this.targetEndOfNoise = null;
    this.targetSilence = dtNow - 1;
  }

  static get parameterDescriptors() {
    return [
      {
        // If the sound is mostly under this threshold, treat the packet like Silence and skip it.
        name: 'silenceFloor',
        defaultValue: 0.01,
        minValue: 0.0,
        maxValue: 1.0,
        automationRate: 'k-rate',
      },
      {
        // The longer someone talks, the longer it waits to flush the sound.
        // Defaults to 0.05 or %5. If you talk for 10 seconds it waits for 500ms. If you talk for 1 minute it waits for 3 seconds.
        name: 'silenceFlushRatio',
        defaultValue: 0.05,
        minValue: 0.0,
        maxValue: 5.0,
        automationRate: 'k-rate',
      },
      /*
      {
        // This is NOT a max, this is a flush threshold.
        name: 'bufferFlushBytes',
        defaultValue: 102400.0 / 2.0,
        minValue: 0.0,
        maxValue: 200000.0,
        automationRate: 'k-rate',
      },
      */
    ];
  }

  /**
   * Do the actual processing of data. We skip Silence unless it is silent for more than silenceFlushRatio.
   * The parameters control the silence detection.
   * @param {Float32Array[][]} inputs Inputs of the processing
   * @param {Float32Array[][]} outputs Outputs of the processing
   * @param {Record<string, Float32Array>} parameters The parameters, which must be declared
   * @returns boolean True always
   */
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    try {
      const input0 = inputs[0];
      const chan0 = input0[0];
      if (!input0 || !chan0) {
        // We are disconnected, so cleanup and exit
        this.flush();
        this.leftChannel = [];
        this.recordLength = 0;
        return false;
      }
      // Check for if we see noise. If we do see noise, keep increasing the target for silence flushing
      const dtNow = Date.now();
      const noisySamples = chan0
        .filter((v) => Math.abs(v) > parameters['silenceFloor'][0])
        .reduce((a, _) => a + 1.0, 0.0);
      const beyondNoisyThreshold = noisySamples >= chan0.length / 4.0;

      if (beyondNoisyThreshold) {
        if (!this.startOfNoise) {
          // First time for this noise instance
          this.startOfNoise = dtNow;
        }
        this.targetSilence = dtNow + 50; // 50ms silence buffer
      }
      const currentlySpeaking = this.targetSilence > dtNow;
      const shouldSendSilence =
        this.targetEndOfNoise && this.targetEndOfNoise < dtNow;
      if (currentlySpeaking || shouldSendSilence) {
        // We send data when we are speaking but NOT just being silent.

        // Clone the array and convert to PCM16iSamples
        const leftChanInputCopy = Int16Array.from(
          chan0,
          // wish: SIMD
          (k) => (k < 0 ? k * 0x8000 : 0x7fff * k), //(k) => 32767 * Math.min(1, k),
        );
        this.leftChannel.push(leftChanInputCopy);
        this.recordLength += leftChanInputCopy.length;
      }
      if (currentlySpeaking) {
        // Min 200ms
        const silenceExpectedMs = Math.max(
          (dtNow - this.startOfNoise) * parameters['silenceFlushRatio'][0],
          200,
        );
        // Max 1500ms
        this.targetEndOfNoise = dtNow + Math.min(silenceExpectedMs, 1500);
      }
      // We are now quiet
      if (!currentlySpeaking && this.startOfNoise) {
        this.flush();
        this.startOfNoise = null;
      }

      // Just copy the input to the output.
      for (let i = 0; i < Math.min(inputs.length, outputs.length); i++) {
        for (
          let j = 0;
          j < Math.min(inputs[i].length, outputs[i].length);
          j++
        ) {
          // The "hot" loop should be the 'set' operation. The outer loops are low count
          outputs[i][j].set(inputs[i][j]);
        }
      }
      // Magic websocket number 102400 bytes which is about 2x the Int16 (duh), with a very small overhead
      // Flush if we are over a buffer limit. Assume 2 bytes per entry and a 10% overhead.
      // We are looking at something like 100ms of buffer we want to send. at 16k that's about 1600 samples per buffer
      if (this.recordLength > 1600) {
        this.flush();
      }
    } catch (e) {
      this.port.postMessage({ kind: 'message', data: e });
    }
    return true;
  }

  /**
   * Merge various buffers
   * @param {Int16Array[]} channelBuffer Buffer input
   * @param {number} recordingLength Memoized length of the arrays
   * @returns A concatenated array
   */
  private mergeBuffers(channelBuffer: Int16Array[], recordingLength: number) {
    const result = new Int16Array(recordingLength);
    let offset = 0;
    for (let i = 0; i < channelBuffer.length; i++) {
      result.set(channelBuffer[i], offset);
      offset += channelBuffer[i].length;
    }

    return result;
  }

  flush() {
    try {
      if (this.recordLength === 0) {
        return;
      }
      const PCM16iSamples = this.mergeBuffers(
        this.leftChannel,
        this.recordLength,
      );
      // reset "buffer" on each iteration
      this.leftChannel = [];
      this.recordLength = 0;

      this.port.postMessage({
        kind: 'pcm16iaudio',
        data: this.arrayBufferToBase64(PCM16iSamples.buffer),
      });
    } catch (e) {
      this.port.postMessage({ kind: 'message', data: e });
    }
  }

  /**
   * Convert an audio buffer to a form suitable for sending across net connections
   * @param {ArrayBuffer} buffer Audio data buffer to convert to byte form
   * @returns A string representation of the audio data. It still needs btoa
   */
  arrayBufferToBase64(buffer: ArrayBuffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const length = bytes.byteLength;
    for (let i = 0; i < length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return binary;
  }
}
registerProcessor('inworld-audio-worklet-processor', GrpcAudioWorkletProcessor);
