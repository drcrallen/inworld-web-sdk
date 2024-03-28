export class GrpcAudioRecorder {
  private static SAMPLE_RATE_HZ = 16000;
  private static INTERVAL_TIMEOUT_MS = 200;

  private currentMediaStreamSourceNode: MediaStreamAudioSourceNode | null =
    null;
  private audioWorkletNode: AudioWorkletNode | null = null;
  private listener: ((base64AudioChunk: string) => void) | null = null;

  stopConvertion() {
    if (!this.currentMediaStreamSourceNode) {
      return;
    }
    this.audioWorkletNode.port.postMessage({ kind: 'flush' });
    this.currentMediaStreamSourceNode.mediaStream
      .getTracks()
      .forEach((t) => t.stop());
    this.currentMediaStreamSourceNode.disconnect(this.audioWorkletNode);
    this.currentMediaStreamSourceNode = null;
  }

  isRecording() {
    return this.currentMediaStreamSourceNode != null;
  }

  // Consumes stream that is coming out of local webrtc loopback and converts it to the messages for the server.
  async startConvertion(
    stream: MediaStream,
    listener: (chunk: string) => void,
  ) {
    this.listener = listener;
    const context = new AudioContext({
      sampleRate: GrpcAudioRecorder.SAMPLE_RATE_HZ,
      latencyHint: 'interactive',
    });
    await context.audioWorklet
      .addModule(new URL('./audio.recorder.worklet.js', import.meta.url))
      .catch(console.error);
    // need to keep track of this two in order to properly disconnect later on;
    this.audioWorkletNode = new AudioWorkletNode(
      context,
      'inworld-audio-worklet-processor',
      {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        parameterData: {
          silenceFloor: 0.01,
          silenceFlushRatio: 0.08,
        },
        processorOptions: {},
      },
    );
    this.audioWorkletNode.onprocessorerror = (event) => {
      console.error('audio worklet failed', event);
    };
    this.audioWorkletNode.port.onmessage = (event) => {
      if (event.data.kind === 'pcm16iaudio') {
        this.listener(btoa(event.data.data));
      } else if (event.data.kind === 'message') {
        console.log(event.data.data);
      } else {
        console.warn('unknown event', event);
      }
    };
    this.currentMediaStreamSourceNode = context.createMediaStreamSource(stream);
    this.currentMediaStreamSourceNode.connect(this.audioWorkletNode);
    // This will play out of the speakers as a loopback
    //.connect(context.destination);
  }
}
