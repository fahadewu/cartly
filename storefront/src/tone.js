// An on-device estimate of skin tone (Monk scale 1–10) from a photo the shopper picks, for colour
// suggestions. The photo never leaves the browser: pose landmarks (the same MediaPipe model as the quick try-on)
// find the cheeks, their median colour goes through CIELAB, and the shopper confirms or corrects the result before
// anything is saved. Lighting moves it a step or two, which is why it's only a starting point. Undertone isn't
// estimated: camera white balance swings it more than skin does, so the shopper picks it (veins, jewellery).
import { detectPose } from './tryon/pose.js'

// Monk Skin Tone scale swatches (Google, CC BY 4.0), 1 lightest to 10 deepest.
export const MONK = ['#f6ede4', '#f3e7db', '#f7ead0', '#eadaba', '#d7bd96', '#a07e56', '#825c43', '#604134', '#3a312a', '#292420']

function lab([r, g, b]) {
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (t * 24389) / 27 / 116 + 16 / 116)
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047)
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B)
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const MONK_LAB = MONK.map((h) => lab(hexRgb(h)))
const hueOf = ([, a, b]) => (Math.atan2(b, a) * 180) / Math.PI

/**
 * Monk tone (the nearest swatch in CIELAB, lightness weighted most) and undertone (the colour's hue against that
 * swatch's: yellower is warm, pinker is cool). Exported for tests.
 */
export function classify(c) {
  const dist = (m) => Math.hypot(1.5 * (c[0] - m[0]), c[1] - m[1], c[2] - m[2])
  const i = MONK_LAB.reduce((best, m, j) => (dist(m) < dist(MONK_LAB[best]) ? j : best), 0)
  const shift = hueOf(c) - hueOf(MONK_LAB[i])
  const undertone = shift > 4 ? 'warm' : shift < -4 ? 'cool' : 'neutral'
  return { tone: i + 1, undertone }
}

function load(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('That photo couldn’t be opened.'))
    img.src = URL.createObjectURL(file)
  })
}

export async function estimateTone(file) {
  const img = await load(file)
  try {
    const lm = await detectPose(img)
    const seen = (i) => lm?.[i] && lm[i].v > 0.5
    if (!lm || ![2, 5, 9, 10].every(seen)) throw new Error('No face found. Use a front-facing photo in daylight, without a filter.')
    const scale = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight))
    const W = Math.round(img.naturalWidth * scale)
    const H = Math.round(img.naturalHeight * scale)
    const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H })
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0, W, H)
    const eyes = Math.hypot((lm[2].x - lm[5].x) * W, (lm[2].y - lm[5].y) * H)
    const r = Math.max(3, Math.round(eyes * 0.12))
    const L = []
    const A = []
    const B = []
    // Each cheek: halfway between the eye and the mouth corner, nudged towards the ear.
    for (const [eye, mouth, ear] of [[2, 9, 7], [5, 10, 8]]) {
      const ex = seen(ear) ? lm[ear].x : lm[eye].x
      const cx = Math.round((((lm[eye].x + lm[mouth].x) / 2) * 0.8 + ex * 0.2) * W)
      const cy = Math.round(((lm[eye].y + lm[mouth].y) / 2) * H)
      const px = ctx.getImageData(Math.max(0, cx - r), Math.max(0, cy - r), r * 2, r * 2).data
      for (let i = 0; i < px.length; i += 4) {
        const [l, a, b] = lab([px[i], px[i + 1], px[i + 2]])
        if (l < 15 || l > 96) continue // shadows and highlights
        L.push(l), A.push(a), B.push(b)
      }
    }
    if (L.length < 20) throw new Error('Couldn’t read the skin clearly. Try a brighter, sharper photo.')
    return { tone: classify([median(L), median(A), median(B)]).tone }
  } finally {
    URL.revokeObjectURL(img.src)
  }
}
