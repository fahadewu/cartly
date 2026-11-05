// The transparent "sticker" of an accessory for the quick preview. The server makes it from the
// try-on photo whatever the background (tryOn.cutout); without one, a studio shot's plain backdrop is
// flood-filled away here.
import { specFor } from './specs.js'
import { productById } from '../catalog.js'

const cache = new Map()

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load image'))
    img.src = src
  })
}

export async function cutout(productId) {
  if (cache.has(productId)) return cache.get(productId)
  const job = make(productId)
  cache.set(productId, job)
  try {
    return await job
  } catch (e) {
    cache.delete(productId)
    throw e
  }
}

async function make(productId) {
  const product = productById(productId)
  const made = product.tryOn?.cutout
  if (made) {
    const img = await loadImage(made) // already transparent and trimmed to the item
    return { src: made, aspect: img.naturalHeight / img.naturalWidth }
  }
  // A dedicated try-on photo (uploaded in the admin panel) is a clean shot of just the item,
  // so it's used whole; otherwise the item's crop of the product photo.
  const dedicated = product.tryOn?.image
  const crop = dedicated ? [0, 0, 1, 1] : specFor(productId).crop
  const src = dedicated ?? (product.photo ? `https://images.unsplash.com/photo-${product.photo}?w=900&q=85&auto=format` : product.image)
  const img = await loadImage(src)
  const [x0, y0, x1, y1] = crop
  const sx = Math.round(x0 * img.naturalWidth)
  const sy = Math.round(y0 * img.naturalHeight)
  const sw = Math.round((x1 - x0) * img.naturalWidth)
  const sh = Math.round((y1 - y0) * img.naturalHeight)
  const scale = Math.min(1, 700 / Math.max(sw, sh))
  const w = Math.round(sw * scale)
  const h = Math.round(sh * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h)

  removeBackground(ctx, w, h)
  const out = trim(canvas, ctx)
  return { src: out.toDataURL('image/png'), aspect: out.height / out.width }
}

// Crop away fully transparent margins so the fit uses the garment's real size.
function trim(canvas, ctx) {
  const { width: w, height: h } = canvas
  const a = ctx.getImageData(0, 0, w, h).data
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (a[(y * w + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  if (x1 < 0) return canvas
  const pad = 2
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad)
  x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad)
  const out = document.createElement('canvas')
  out.width = x1 - x0 + 1
  out.height = y1 - y0 + 1
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height)
  return out
}

function removeBackground(ctx, w, h, tol = 48) {
  const data = ctx.getImageData(0, 0, w, h)
  const px = data.data
  const idx = (x, y) => (y * w + x) * 4

  // Background references. Border colours are bucketed; the most common bucket is
  // the backdrop, and only buckets close to it (its lighter/darker shades) are kept.
  // That handles gradients and shadows without ever treating a garment that
  // touches the edge as background.
  const buckets = new Map()
  const sample = (x, y) => {
    const i = idx(x, y)
    const key = (px[i] >> 4) * 256 + (px[i + 1] >> 4) * 16 + (px[i + 2] >> 4)
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    e.n++; e.r += px[i]; e.g += px[i + 1]; e.b += px[i + 2]
    buckets.set(key, e)
  }
  for (let x = 0; x < w; x += 2) { sample(x, 1); sample(x, h - 2) }
  for (let y = 0; y < h; y += 2) { sample(1, y); sample(w - 2, y) }
  const ranked = [...buckets.values()].map((e) => ({ n: e.n, c: [e.r / e.n, e.g / e.n, e.b / e.n] })).sort((p, q) => q.n - p.n)
  const primary = ranked[0].c
  const refs = ranked
    .filter((e) => e.n >= 3 && Math.hypot(e.c[0] - primary[0], e.c[1] - primary[1], e.c[2] - primary[2]) < 90)
    .slice(0, 40)
    .map((e) => e.c)

  const near = (i) => {
    let best = Infinity
    for (const c of refs) {
      const d = (px[i] - c[0]) ** 2 + (px[i + 1] - c[1]) ** 2 + (px[i + 2] - c[2]) ** 2
      if (d < best) best = d
    }
    return Math.sqrt(best)
  }
  const TOL = tol // how far from the nearest background sample a pixel can be and still count as background
  const STEP = 20 // max colour jump between neighbouring background pixels

  const seen = new Uint8Array(w * h)
  const stack = []
  const push = (x, y) => {
    const k = y * w + x
    if (!seen[k]) { seen[k] = 1; stack.push(k) }
  }
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1) }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y) }

  const mask = new Uint8Array(w * h) // 1 = background
  while (stack.length) {
    const k = stack.pop()
    const x = k % w
    const y = (k / w) | 0
    const i = k * 4
    if (near(i) > TOL) continue
    mask[k] = 1
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const nk = ny * w + nx
      if (seen[nk]) continue
      const ni = nk * 4
      if (Math.hypot(px[ni] - px[i], px[ni + 1] - px[i + 1], px[ni + 2] - px[i + 2]) < STEP || near(ni) < TOL * 0.7) {
        seen[nk] = 1
        stack.push(nk)
      }
    }
  }

  // Feather: alpha falls off over a couple of pixels at the mask edge.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x
      if (mask[k]) { px[k * 4 + 3] = 0; continue }
      let edge = 0
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx, ny = y + dy
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx]) edge++
        }
      if (edge) px[k * 4 + 3] = Math.round(255 * (1 - edge / 25) ** 0.8)
    }
  }
  ctx.putImageData(data, 0, 0)
}
