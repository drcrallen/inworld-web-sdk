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
  }
  /**
   * Do the actual processing of data
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
      // Clone the array and convert to PCM16iSamples
      const leftChanInputCopy = Int16Array.from(
        inputs[0][0],
        (k) => (k < 0 ? k * 0x8000 : 0x7fff * k), //(k) => 32767 * Math.min(1, k),
      );
      this.leftChannel.push(leftChanInputCopy);
      this.recordLength += leftChanInputCopy.length;

      /*
      for (let i = 0; i < Math.min(inputs.length, outputs.length); i++) {
        for (
          let j = 0;
          j < Math.min(inputs[i].length, outputs[i].length);
          j++
        ) {
          outputs[i][j].set(inputs[i][j]);
        }
      }
      */
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
