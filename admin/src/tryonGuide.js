// How to photograph each kind of product so the AI try-on puts it on shoppers accurately.
// The AI copies the product from this photo onto the shopper's body: whatever the photo
// shows (other items, a hanger, a cropped sleeve, a watermark) can end up in the result.

export const SLOTS = [
  ['', 'Can’t be tried on'], ['top', 'Top'], ['outer', 'Outerwear'], ['dress', 'Dress or jumpsuit'], ['bottom', 'Bottoms'], ['feet', 'Shoes'],
  ['eyes', 'Eyewear'], ['head', 'Headwear'], ['ears', 'Headphones'], ['wrist', 'Watch'], ['hand', 'Bag'],
]

export const PHOTO_TYPES = [
  ['on-model', 'On a model'],
  ['ghost-mannequin', 'Ghost mannequin'],
  ['flat-lay', 'Flat lay'],
  ['product-shot', 'Product shot'],
]

export const GARMENT = ['top', 'outer', 'dress', 'bottom']
export const MIN_SIDE = (slot) => (GARMENT.includes(slot) ? { error: 512, best: 1024 } : { error: 400, best: 800 })
export const MAX_BYTES = 15 * 1024 * 1024
export const ACCEPT = 'image/jpeg,image/png,image/webp'

export const RULES = [
  'Only this product in the photo: no other clothes, props or packaging.',
  'All of it visible with a small margin: sleeves, hem, straps, both shoes.',
  'Plain, light background (white or light grey) that contrasts with the item. Transparent PNG cut-outs are ideal.',
  'Soft, even light and true colour: no harsh shadows, filters or colour casts.',
  'Sharp, and 1024 px or more on the short side. JPG, PNG or WebP up to 15 MB.',
  'No text, badges, price tags, watermarks or collages.',
]

const garment = [
  'Shoot straight on from the front, not at an angle.',
  'No hangers: they pull the shoulders out of shape.',
  'Steam out creases. Flat lays should be smooth and symmetrical.',
  'Nothing covering it: no hair, hands, bags or crossed arms.',
]

export const GUIDE = {
  top: { best: 'On a model or ghost mannequin, front view, portrait framing (3:4).', tips: [...garment, 'Show the whole length, including the hem, and both sleeves.'] },
  outer: { best: 'On a model or ghost mannequin, front view, worn the way shoppers usually wear it.', tips: [...garment, 'The AI layers outerwear over the shopper’s outfit. Set “wear it open” below if that’s how it looks best.'] },
  dress: { best: 'On a model or ghost mannequin, front view, full length down to the hem.', tips: [...garment, 'Show belts, ties and slits clearly; they’re copied as shown.'] },
  bottom: { best: 'On a model (waist to feet) or a flat lay, front view, legs side by side.', tips: [...garment, 'Show the waistband down to the hem, with the legs not folded or crossed.'] },
  feet: { best: 'The pair from the side (profile) on a plain background, or one shoe at a slight three-quarter angle.', tips: ['Both shoes fully in frame, not overlapping much.', 'Laces tidy and no stuffing paper showing.', 'Shoot at shoe height, not from above.'] },
  eyes: { best: 'Straight-on front view with the arms open and the lenses facing the camera.', tips: ['Centred and level, not tilted.', 'Avoid reflections that hide the frame’s shape.', 'Only one pair, without the case.'] },
  head: { best: 'Front or three-quarter view, on a mannequin head or a plain background.', tips: ['Show the brim or peak and the crown clearly.', 'Shape it as it’s worn, not folded flat.'] },
  ears: { best: 'Front view with the headband up and both ear cups visible.', tips: ['Open to their normal wearing width.', 'Hide or remove cables that aren’t part of the product.'] },
  wrist: { best: 'The watch face straight on, with the strap laid open.', tips: ['Keep the face free of glare so the dial reads clearly.', 'Show the strap’s full width and buckle.'] },
  hand: { best: 'Front view, standing upright, with the handles or strap up.', tips: ['Stuff it gently so it keeps its shape.', 'Show the strap length if it’s a shoulder or crossbody bag.'] },
}

/** Instant checks in the browser, before uploading. Returns an error message or ''. */
export async function precheck(file, slot) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return 'Use a JPG, PNG or WebP photo.'
  if (file.size > MAX_BYTES) return 'That photo is over 15 MB. Export it at a smaller size (around 2000 px is plenty).'
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = reject
      i.src = url
    })
    const short = Math.min(img.naturalWidth, img.naturalHeight)
    const { error } = MIN_SIDE(slot)
    if (short < error) return `This photo is ${img.naturalWidth}×${img.naturalHeight} px. Use one at least ${error} px on the short side.`
    return ''
  } catch {
    return 'That file can’t be opened as an image.'
  } finally {
    URL.revokeObjectURL(url)
  }
}

export const GRADE = {
  great: { label: 'Great for try-on', tone: 'good' },
  good: { label: 'Good for try-on', tone: 'good' },
  fix: { label: 'Works, but could be better', tone: 'warn' },
  fail: { label: 'Won’t try on accurately', tone: 'bad' },
}

// What the storefront's on-device quick preview shows (when AI try-on is off): small, rigid items.
// Clothes and shoes need the AI try-on.
export const PREVIEW_SLOTS = ['eyes', 'head', 'ears', 'wrist', 'hand']

// Sample models for previews (the same photos shoppers can pick in the fitting room).
export const SAMPLE_MODELS = [
  '1683126257977-5142e52acc7e',
  '1666358085605-b3b717d5a210',
  '1650003775377-81b873410f64',
  '1666358777243-320bf3632bc3',
].map((id, i) => ({ index: i, thumb: `https://images.unsplash.com/photo-${id}?w=160&h=220&fit=crop&q=70` }))
