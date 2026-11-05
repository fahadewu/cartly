// Pip's automatic fit: places and sizes an item from body pose landmarks.
// Boxes are in photo pixels: { cx, cy, w, h, rot } where (cx, cy) is the
// centre and rot is in degrees.
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

// Rough standing-person landmarks, used when pose detection isn't available.
export const FALLBACK_POSE = (() => {
  const p = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, v: 0 }))
  const set = (i, x, y) => (p[i] = { x, y, v: 1 })
  set(0, 0.5, 0.1)
  set(2, 0.475, 0.085)
  set(5, 0.525, 0.085)
  set(7, 0.45, 0.095)
  set(8, 0.55, 0.095)
  set(11, 0.6, 0.2)
  set(12, 0.4, 0.2)
  set(15, 0.66, 0.5)
  set(16, 0.34, 0.5)
  set(23, 0.56, 0.5)
  set(24, 0.44, 0.5)
  set(25, 0.56, 0.7)
  set(26, 0.44, 0.7)
  set(27, 0.56, 0.9)
  set(28, 0.44, 0.9)
  return p
})()

export function fitBox(slot, aspect, landmarks, W, H) {
  const P = (i) => ({ x: landmarks[i].x * W, y: landmarks[i].y * H })
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  const angle = (a, b) => {
    let deg = (Math.atan2(a.y - b.y, a.x - b.x) * 180) / Math.PI
    if (deg > 90) deg -= 180
    if (deg < -90) deg += 180
    return Math.round(Math.max(-25, Math.min(25, deg)))
  }

  const lSh = P(11), rSh = P(12), lHip = P(23), rHip = P(24)
  const lKnee = P(25), rKnee = P(26), lAnk = P(27), rAnk = P(28)
  const sh = mid(lSh, rSh), hip = mid(lHip, rHip), knee = mid(lKnee, rKnee), ank = mid(lAnk, rAnk)
  const sw = Math.max(dist(lSh, rSh), H * 0.06)
  const hw = Math.max(dist(lHip, rHip), sw * 0.6)
  const torsoRot = angle(lSh, rSh)
  // Body widths estimated from the joints (hip joints sit inside the body outline).
  const torsoW = sw * 1.05
  const hipW = clamp(hw * 1.6, sw * 0.85, sw * 1.5)
  const box = (cx, cy, w, rot = 0) => ({ cx, cy, w, h: w * aspect, rot })
  const seen = (i) => (landmarks[i].v ?? 1) > 0.5
  // Head width from ear to ear, but never implausibly small next to the shoulders (a turned head).
  const headW = Math.max(dist(P(7), P(8)), sw * 0.38)

  switch (slot) {
    case 'top': {
      // A flat-laid top is about 1.75× the torso width once sleeves are included.
      const w = clamp(torsoW * 1.75, sw * 1.45, sw * 2.3)
      const top = sh.y - sw * 0.16
      return box(sh.x, top + (w * aspect) / 2, w, torsoRot)
    }
    case 'outer': {
      const w = clamp(torsoW * 1.95, sw * 1.6, sw * 2.5)
      const top = sh.y - sw * 0.2
      return box(sh.x, top + (w * aspect) / 2, w, torsoRot)
    }
    case 'dress': {
      const top = sh.y - sw * 0.12
      const bottom = knee.y + (ank.y - knee.y) * 0.45
      const h = Math.max(bottom - top, sw)
      const w = clamp(h / aspect, Math.max(sw * 1.5, hipW * 1.25), sw * 3.2)
      return { cx: sh.x, cy: top + (w * aspect) / 2, w, h: w * aspect, rot: torsoRot }
    }
    case 'bottom': {
      const top = hip.y - hw * 0.25
      const h = Math.max(ank.y - top + hw * 0.1, hw)
      const w = clamp(h / aspect, hipW * 1.15, hipW * 2.4)
      return { cx: hip.x, cy: top + (w * aspect) / 2, w, h: w * aspect, rot: angle(lHip, rHip) }
    }
    case 'feet': {
      const w = Math.max(dist(lAnk, rAnk) * 2.1, hw * 2.4)
      const cy = ank.y + (ank.y - knee.y) * 0.1
      return box(ank.x, cy, w)
    }
    case 'eyes': {
      // Frames are about 2.5× the distance between the pupils.
      const lEye = P(2), rEye = P(5)
      const e = mid(lEye, rEye)
      const w = Math.max(dist(lEye, rEye) * 2.5, headW * 1.05)
      return box(e.x, e.y + w * aspect * 0.08, w, angle(lEye, rEye))
    }
    case 'head': {
      // A hat sits on the head: its lower edge on the brow, a little wider than the head.
      const e = mid(P(2), P(5))
      const w = headW * 1.4
      const bottom = e.y - headW * 0.2
      return box(e.x, bottom - (w * aspect) / 2, w, angle(P(7), P(8)))
    }
    case 'ears': {
      // Over-ear headphones: the cups (centred about 80% down the photo) on the ears, either side of
      // the face, and the band over the head.
      const c = mid(P(7), P(8))
      const w = headW * 1.75
      return box(c.x, c.y - w * aspect * 0.3, w, angle(P(7), P(8)))
    }
    case 'wrist': {
      // Watches go on the left wrist, unless it's out of sight.
      const wr = P(seen(15) || !seen(16) ? 15 : 16)
      return box(wr.x, wr.y, sw * 0.32)
    }
    case 'hand': {
      // Carried in the lower hand, hanging from it; with both hands raised, at the side by the hip.
      const w = sw * 0.8
      const h = w * aspect
      const [a, b] = [15, 16].filter(seen)
      const wr = a === undefined ? null : b === undefined ? P(a) : P(landmarks[a].y > landmarks[b].y ? a : b)
      if (wr && wr.y > hip.y - sw * 0.25) return box(wr.x, wr.y + h * 0.4, w)
      return box(rHip.x - hw * 0.9, hip.y + h * 0.35, w)
    }
    default:
      return box(W / 2, H / 2, W * 0.4)
  }
}
