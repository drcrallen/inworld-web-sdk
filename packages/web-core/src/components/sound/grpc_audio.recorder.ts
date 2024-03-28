export class GrpcAudioRecorder {
  private static SAMPLE_RATE_HZ = 16000;
  private static INTERVAL_TIMEOUT_MS = 200;

  private currentMediaStream: MediaStream | null = null;
  private audioWorkletNode: AudioWorkletNode | null = null;
  private listener: ((base64AudioChunk: string) => void) | null = null;

  stopConvertion() {
    if (!this.currentMediaStream) {
      return;
    }
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
    await context.audioWorklet.addModule('modules/audio.recorder.worklet.js');
    // need to keep track of this two in order to properly disconnect later on;
    this.currentMediaStream = stream;
    this.audioWorkletNode = new AudioWorkletNode(
      context,
      'inworld-audio-worklet-processor',
      {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        parameterData: {},
        processorOptions: { intervalMs: GrpcAudioRecorder.INTERVAL_TIMEOUT_MS },
      },
    );
    this.audioWorkletNode.port.onmessage = (event) => {
      this.listener(event.data);
    };
    const source = context.createMediaStreamSource(stream);
    source.connect(this.audioWorkletNode).connect(context.destination);
  }
}
