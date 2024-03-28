export class GrpcAudioRecorder {
  private static SAMPLE_RATE_HZ = 16000;
  private static INTERVAL_TIMEOUT_MS = 200;

  private currentMediaStream: MediaStream | null = null;
  private audioWorkletNode: AudioWorkletNode | null = null;
  private listener: ((base64AudioChunk: string) => void) | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  stopConvertion() {
    if (!this.currentMediaStream) {
      return;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.audioWorkletNode.port.postMessage({ kind: 'flush' });
    this.currentMediaStream.getTracks().forEach((track) => {
      track.stop();
    });
    this.currentMediaStream = null;
    this.audioWorkletNode.disconnect();
  }

  isRecording() {
    return this.currentMediaStream != null;
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
      .addModule(
        'https://storage.googleapis.com/danger-cors-duck-ai-testing/audio.recorder.worklet11.js',
      )
      .catch(console.error);
    // need to keep track of this two in order to properly disconnect later on;
    this.currentMediaStream = stream;
    this.audioWorkletNode = new AudioWorkletNode(
      context,
      'inworld-audio-worklet-processor',
      {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        parameterData: {},
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
    const source = context.createMediaStreamSource(stream);
    source.connect(this.audioWorkletNode).connect(context.destination);
    this.interval = setInterval(() => {
      const n = this.audioWorkletNode;
      if (n) {
        n.port.postMessage({ kind: 'flush' });
      }
    }, GrpcAudioRecorder.INTERVAL_TIMEOUT_MS);
  }
}
