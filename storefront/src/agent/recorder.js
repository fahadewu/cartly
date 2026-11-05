// Records one spoken message for server speech-to-text. It waits for you to start
// talking and stops by itself after a short pause, so voice mode stays hands-free.
export const recordingSupported =
  typeof window !== 'undefined' && !!window.MediaRecorder && !!navigator.mediaDevices?.getUserMedia

const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

/**
 * Starts recording. Returns { done, stop, cancel }: `done` resolves with the audio
 * Blob, or null if nothing was said (or it was cancelled). Throws if the mic is blocked.
 */
export async function recordUtterance({ onLevel, onSpeech, maxMs = 20_000, silenceMs = 1200, noSpeechMs = 8000 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t))
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  const chunks = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)

  const Ctx = window.AudioContext || window.webkitAudioContext
  const ctx = new Ctx()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  ctx.createMediaStreamSource(stream).connect(analyser)
  const buf = new Float32Array(analyser.fftSize)

  const started = performance.now()
  let floor = 0.004 // room noise, measured in the first moments
  let spoke = false
  let lastLoud = started
  let keep = true
  let raf = 0

  const done = new Promise((resolve) => {
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      ctx.close().catch(() => {})
      resolve(keep && spoke && chunks.length ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null)
    }
  })
  const finish = (save) => {
    cancelAnimationFrame(raf)
    keep = save
    if (rec.state !== 'inactive') rec.stop()
  }

  const tick = () => {
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (const x of buf) sum += x * x
    const rms = Math.sqrt(sum / buf.length)
    const now = performance.now()
    if (now - started < 350) floor = Math.max(floor, rms)
    const loud = rms > Math.max(0.012, floor * 2.2)
    onLevel?.(Math.min(1, rms * 9))
    if (loud) {
      lastLoud = now
      if (!spoke) {
        spoke = true
        onSpeech?.()
      }
    }
    if ((spoke && now - lastLoud > silenceMs) || now - started > maxMs) return finish(true)
    if (!spoke && now - started > noSpeechMs) return finish(false)
    raf = requestAnimationFrame(tick)
  }
  rec.start(250)
  raf = requestAnimationFrame(tick)

  return {
    done,
    stop: () => finish(true), // "I'm done talking"
    cancel: () => finish(false),
    type: rec.mimeType || mimeType || 'audio/webm',
  }
}

/**
 * The recording as 16 kHz mono 16-bit WAV: what Meta's Muse Voice Transcribe takes (the capabilities say stt "meta").
 * Decoded and resampled in the browser, so nothing else is sent.
 */
export async function toWav(blob, rate = 16000) {
  const Ctx = window.AudioContext || window.webkitAudioContext
  const ctx = new Ctx()
  let decoded
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
  } finally {
    ctx.close?.()
  }
  const frames = Math.ceil(decoded.duration * rate)
  const offline = new OfflineAudioContext(1, frames, rate)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const pcm = (await offline.startRendering()).getChannelData(0)
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2))
  const text = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  out.setUint32(4, 36 + pcm.length * 2, true)
  text(8, 'WAVEfmt ')
  out.setUint32(16, 16, true)
  out.setUint16(20, 1, true) // PCM
  out.setUint16(22, 1, true) // mono
  out.setUint32(24, rate, true)
  out.setUint32(28, rate * 2, true)
  out.setUint16(32, 2, true)
  out.setUint16(34, 16, true)
  text(36, 'data')
  out.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true)
  return new Blob([out], { type: 'audio/wav' })
}
