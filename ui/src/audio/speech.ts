// Speech from the service: binary PCM frames between speech.start and speech.end, played through
// an AudioWorklet. One stream at a time; a new one replaces the old.
import workletUrl from './pcm-worklet.js?url'

class SpeechPlayer {
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private gain: GainNode | null = null
  private ready: Promise<void> | null = null
  private backlog: Float32Array[] = []
  private volume = 0.8

  /** Create the audio context inside a user gesture, so playback is allowed. */
  prime(): void {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'interactive' })
    void this.ctx.resume().catch(() => undefined)
  }

  setVolume(v: number): void {
    this.volume = v
    if (this.clip) this.clip.volume = v
    if (this.gain) this.gain.gain.value = v
  }

  start(sampleRate: number): void {
    this.flushNode()
    this.backlog = []
    if (!this.ctx || this.ctx.sampleRate !== sampleRate) {
      void this.ctx?.close().catch(() => undefined)
      this.ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' })
      this.node = null
    }
    const ctx = this.ctx
    void ctx.resume().catch(() => undefined)
    if (this.node) return
    this.ready = ctx.audioWorklet.addModule(workletUrl).then(() => {
      if (ctx !== this.ctx) return
      this.gain = ctx.createGain()
      this.gain.gain.value = this.volume
      this.node = new AudioWorkletNode(ctx, 'pcm-player', { outputChannelCount: [1] })
      this.node.connect(this.gain).connect(ctx.destination)
      for (const chunk of this.backlog) this.node.port.postMessage(chunk, [chunk.buffer])
      this.backlog = []
    })
    this.ready.catch(() => undefined)
  }

  push(frame: ArrayBuffer): void {
    const pcm = new Int16Array(frame, 0, Math.floor(frame.byteLength / 2))
    const f = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768
    if (this.node) this.node.port.postMessage(f, [f.buffer])
    else this.backlog.push(f)
  }

  end(): void {
    if (this.node) this.node.port.postMessage('end')
    else void this.ready?.then(() => this.node?.port.postMessage('end'))
  }

  stop(): void {
    this.backlog = []
    this.flushNode()
    this.clip?.pause()
    this.clip = null
  }

  /** A whole spoken clip, for voices Hermes cannot stream. */
  private clip: HTMLAudioElement | null = null
  playClip(url: string): void {
    this.clip?.pause()
    const a = new Audio(url)
    a.volume = this.volume
    this.clip = a
    void a.play().catch(() => undefined)
  }

  private flushNode(): void {
    this.node?.port.postMessage('flush')
  }
}

export const speech = new SpeechPlayer()
