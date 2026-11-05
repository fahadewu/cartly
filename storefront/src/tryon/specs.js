import { productById } from '../catalog.js'
import { caps } from '../capabilities.js'

// Where each item goes on the body. The catalog decides what can be tried on (admins set a try-on
// slot per product) and, for the quick preview, where an accessory sits in its product photo.
export function specFor(id) {
  const t = productById(id)?.tryOn
  return t?.slot ? { slot: t.slot, crop: t.crop ?? [0, 0, 1, 1] } : null
}

// What the on-device quick preview can show convincingly: small, rigid items. Clothes and shoes need
// the AI try-on (a flat cut-out can't drape, go behind the arms or replace what you're wearing).
export const PREVIEW_SLOTS = new Set(['eyes', 'head', 'ears', 'wrist', 'hand'])
export const inPreview = (slot) => PREVIEW_SLOTS.has(slot)
/** Can the shopper try it on here: anything with a slot when AI try-on is on, else accessories. */
export function isWearable(id) {
  const spec = specFor(id)
  return !!spec && (!!caps.tryon || inPreview(spec.slot))
}
/** Wearable in principle, but only with the AI try-on, which is off. */
export const needsAiTryOn = (id) => !!specFor(id) && !isWearable(id)

export const SLOT_LABEL = {
  top: 'Top',
  outer: 'Outerwear',
  dress: 'Dress',
  bottom: 'Bottoms',
  feet: 'Shoes',
  eyes: 'Eyewear',
  head: 'Headwear',
  ears: 'Headphones',
  wrist: 'Watch',
  hand: 'Bag',
}

// Drawing order (back to front) and which slots a new item replaces.
export const Z = { bottom: 1, feet: 2, dress: 3, top: 4, outer: 5, hand: 6, wrist: 7, eyes: 8, head: 9, ears: 10 } // headphones go over a hat
export const REPLACES = {
  top: ['top', 'dress'],
  outer: ['outer'],
  dress: ['dress', 'top', 'bottom'],
  bottom: ['bottom', 'dress'],
  feet: ['feet'],
  eyes: ['eyes'],
  head: ['head'],
  ears: ['ears'],
  wrist: ['wrist'],
  hand: ['hand'],
}

// Full body, facing the camera, fitted clothes, plain studio backdrop: what the AI try-on needs to
// dress someone well, and what the quick preview needs to find their eyes, ears and wrists.
export const SAMPLE_MODELS = [
  { id: 'm1', label: 'Model A', photo: '1683126257977-5142e52acc7e' },
  { id: 'm2', label: 'Model B', photo: '1666358085605-b3b717d5a210' },
  { id: 'm3', label: 'Model C', photo: '1650003775377-81b873410f64' },
  { id: 'm4', label: 'Model D', photo: '1666358777243-320bf3632bc3' },
]
