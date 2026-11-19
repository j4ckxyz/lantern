// Plays signed 16-bit PCM pushed from the page, without gaps, and can be cut off at once.
// Messages in: Float32Array chunks, 'end' (play what is left, then report), 'flush' (stop now).
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []
    this.offset = 0
    this.ending = false
    this.started = false
    this.port.onmessage = (e) => {
      const d = e.data
      if (d === 'end') this.ending = true
      else if (d === 'flush') {
        this.queue = []
        this.offset = 0
        this.ending = false
        this.port.postMessage('drained')
      } else if (d instanceof Float32Array) this.queue.push(d)
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0]
    let i = 0
    // Wait for a little audio before starting, so a slow network does not stutter the first words.
    if (!this.started) {
      let buffered = 0
      for (const c of this.queue) buffered += c.length
      if (buffered < sampleRate * 0.12 && !this.ending) {
        out.fill(0)
        return true
      }
      this.started = true
    }
    while (i < out.length && this.queue.length) {
      const chunk = this.queue[0]
      const n = Math.min(out.length - i, chunk.length - this.offset)
      out.set(chunk.subarray(this.offset, this.offset + n), i)
      i += n
      this.offset += n
      if (this.offset >= chunk.length) {
        this.queue.shift()
        this.offset = 0
      }
    }
    if (i < out.length) out.fill(0, i)
    if (this.ending && !this.queue.length) {
      this.ending = false
      this.started = false
      this.port.postMessage('drained')
    }
    return true
  }
}

registerProcessor('pcm-player', PcmPlayer)
