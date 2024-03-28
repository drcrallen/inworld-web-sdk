class GrpcAudioWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.leftChannel = [];
    this.recordLength = 0;
    this.processorOptions = options.processorOptions;
    this.port.onmessage = (event) => {
      if (event.data.kind === 'flush') {
        this.flush();
      }
    };
    const dtNow = Date.now();
    // "Fake" data just to make sure all comparisons work ok.
    this.startOfNoise = dtNow - 2;
    this.lastNoise = dtNow - 1;
    this.lastSilence = dtNow;
  }

  static get parameterDescriptors() {
    return [
      {
        // If the sound is mostly under this threshold, treat the packet like Silence and skip it.
        name: 'silenceFloor',
        defaultValue: 0.01,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate',
      },
      {
        // The longer someone talks, the longer it waits to flush the sound.
        // Defaults to 0.05 or %5. If you talk for 10 seconds it waits for 500ms. If you talk for 1 minute it waits for 3 seconds.
        name: 'silenceFlushRatio',
        defaultValue: 0.05,
        minValue: 0,
        maxValue: 5,
        automationRate: 'k-rate',
      },
      {
        // This is NOT a max, this is a flush threshold.
        name: 'bufferFlushBytes',
        defaultValue: 102400 / 2,
        minValue: 0,
        maxValue: 200000,
        automationRate: 'k-rate',
      },
    ];
  }

  /**
   * Do the actual processing of data. We skip Silence unless it is silent for more than silenceFlushRatio.
   * The parameters control the silence detection
   * @param {Float32Array[][]} inputs Inputs of the processing
   * @param {Float32Array[][]} outputs Outputs of the processing
   * @param {Record<string, Float32Array>} parameters The parameters, which must be declared
   * @returns boolean True always
   */
  process(inputs, outputs, parameters) {
    try {
      var _ = parameters;
      _ = outputs;
      _ = inputs;
      const input0 = inputs[0];
      const chan0 = input0[0];
      if (!input0 || !chan0) {
        // We are disconnected, so cleanup and exit
        this.flush();
        this.leftChannel = [];
        this.recordLength = 0;
        return false;
      }
      const dtNow = Date.now();
      const noisySamples = chan0
        .filter((v) => Math.abs(v) > parameters['silenceFloor'])
        .reduce((a, _) => a + 1.0, 0.0);
      const pastNoisyThreshold = noisySamples >= chan0.length / 4.0;
      if (pastNoisyThreshold) {
        if (this.lastSilence >= this.lastNoise) {
          // If we last heard Silence
          this.startOfNoise = dtNow - 1;
          // Technically this should be the dtNow minus the buffer lenght adjusted by sample rate, but this should be close enough
        }
        this.lastNoise = dtNow;
      } else {
        this.lastSilence = dtNow;
      }
      const silenceTime = Math.max(this.lastSilence - this.lastNoise, 0);
      const speakTime = Math.max(this.lastNoise - this.startOfNoise, 0);
      const pastSilenceThreshold =
        silenceTime > parameters['silenceFlushRatio'] * speakTime;
      const shouldBufferSample = pastSilenceThreshold || pastNoisyThreshold;

      if (shouldBufferSample) {
        // Clone the array and convert to PCM16iSamples
        const leftChanInputCopy = Int16Array.from(
          chan0,
          (k) => (k < 0 ? k * 0x8000 : 0x7fff * k), //(k) => 32767 * Math.min(1, k),
        );
        this.leftChannel.push(leftChanInputCopy);
        this.recordLength += leftChanInputCopy.length;
      }

      // Just copy the input to the output.
      for (let i = 0; i < Math.min(inputs.length, outputs.length); i++) {
        for (
          let j = 0;
          j < Math.min(inputs[i].length, outputs[i].length);
          j++
        ) {
          outputs[i][j].set(inputs[i][j]);
        }
      }
    } catch (e) {
      this.port.postMessage({ kind: 'message', data: e });
    }
    if (this.recordLength * 2 > this.parameters['bufferFlushBytes']) {
      this.flush();
    }
    return true;
  }

  /**
   * Merge various buffers
   * @param {Int16Array[]} channelBuffer Buffer input
   * @param {number} recordingLength Memoized length of the arrays
   * @returns A concatenated array
   */
  mergeBuffers(channelBuffer, recordingLength) {
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
  arrayBufferToBase64(buffer) {
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
