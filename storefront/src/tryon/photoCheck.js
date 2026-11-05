// How well will the shopper's photo work for try-on? Judged on-device from the
// body landmarks: the AI can only dress what it can see.
const seen = (p) => p && p.v > 0.5 && p.x > 0.01 && p.x < 0.99 && p.y > 0.01 && p.y < 0.99

/** { fullBody, head, feet, tips: [{ ok, text }] } for the fitting room's checklist. */
export function assessPhoto(landmarks, size) {
  if (!landmarks) {
    return {
      fullBody: false,
      head: false,
      feet: false,
      tips: [{ ok: false, text: 'I couldn’t find a full body. A head-to-toe photo, facing the camera, gives the most accurate fit.' }],
    }
  }
  const L = (i) => landmarks[i]
  const head = seen(L(0))
  const shoulders = seen(L(11)) && seen(L(12))
  const hips = seen(L(23)) && seen(L(24))
  const feet = seen(L(27)) && seen(L(28))
  const tips = []
  tips.push(head && feet ? { ok: true, text: 'Head to toe in the frame' } : !feet
    ? { ok: false, text: 'Your feet aren’t in the photo, so shoes won’t show. Step back so you’re head to toe.' }
    : { ok: false, text: 'Your head is cut off, so hats and glasses can’t be placed. Leave a little space above you.' })
  if (shoulders && hips) {
    const width = Math.abs(L(11).x - L(12).x) * size.w
    const torso = Math.abs((L(11).y + L(12).y) / 2 - (L(23).y + L(24).y) / 2) * size.h
    tips.push(width / Math.max(torso, 1) > 0.42
      ? { ok: true, text: 'Facing the camera' }
      : { ok: false, text: 'You’re turned to the side. Face the camera straight on for the most accurate fit.' })
  } else {
    tips.push({ ok: false, text: 'Stand facing the camera with your shoulders and hips visible.' })
  }
  if (Math.min(size.w, size.h) < 640) tips.push({ ok: false, text: 'The photo is quite small. A sharper one makes the try-on more realistic.' })
  return { fullBody: head && feet && shoulders && hips, head, feet, tips }
}
