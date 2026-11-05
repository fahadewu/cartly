// Pip's dummy brain: a rule-based shopping assistant that runs entirely in the
// browser. It parses what the shopper asks for, searches the real catalog and
// returns a reply plus actions for the UI to perform. No API key needed; swap
// `respond()` for a real LLM call later and the UI stays the same.
import { money } from '../data.js'
import { products, productById, categories } from '../catalog.js'
import { isWearable, needsAiTryOn, specFor, SLOT_LABEL } from '../tryon/specs.js'

// Clothes and shoes when the AI try-on is off (the quick preview only shows accessories).
const NEEDS_AI_TRYON = {
  text: 'Clothes and shoes need the AI try-on, which isn’t switched on here yet. I can put **glasses, hats, headphones, watches and bags** on you, though!',
  chips: ['Show me sunglasses', 'Show me bags'],
  mood: 'sorry',
}

const STOP = new Set(
  'a an the i im i\'m me my mine we our you your it its is are am was be been to for of in on at by with and or but so some any something anything thing things show find get give want need looking look search please can could would like love lets let\'s do does have has just really very also maybe perhaps pip hey hi hello there this that these those one ones stuff item items product products buy shop shopping see me more about what which who how'.split(' '),
)

const GENDER = {
  men: /\b(men|mens|men's|man|male|guy|guys|him|his|boyfriend|husband|dad|father|brother|son|grandpa|uncle)\b/,
  women: /\b(women|womens|women's|woman|female|lady|ladies|her|hers|girlfriend|wife|mom|mum|mother|sister|daughter|grandma|aunt)\b/,
}

// Words that point at a product type, with extra search terms to boost.
const TYPES = [
  { type: 'Shoes', re: /\b(shoes?|sneakers?|trainers?|kicks|footwear|runners?|heels?|slip-?ons?)\b/ },
  { type: 'Clothing', re: /\b(clothes|clothing|outfit|wear|dress(es)?|jackets?|coats?|tees?|t-?shirts?|shirts?|hoodies?|sweat(shirt|er)s?|jumpers?|jeans|denim|trousers|pants|poncho|tops?)\b/ },
  { type: 'Accessories', re: /\b(accessor(y|ies)|bags?|handbags?|purse|watch(es)?|sunglasses|shades|caps?|hats?|beanies?|backpacks?)\b/ },
  { type: 'Home', re: /\b(home|house|decor|candles?|plants?|succulents?|cactus|mugs?|cups?|bottles?|kitchen|living)\b/ },
]

const COLORS = {
  red: ['Scarlet'],
  pink: ['Blush'],
  orange: ['Copper', 'Terracotta'],
  yellow: ['Lemon', 'Butter', 'Gold'],
  gold: ['Gold'],
  green: ['Mint', 'Sage'],
  mint: ['Mint'],
  blue: ['Cobalt', 'Sky', 'Ice', 'Denim', 'Navy'],
  navy: ['Navy'],
  black: ['Black'],
  white: ['White', 'Cream'],
  cream: ['Cream'],
  grey: ['Stone'],
  gray: ['Stone'],
  brown: ['Chestnut', 'Tan'],
  beige: ['Sand', 'Tan', 'Cream'],
  tan: ['Tan'],
}

// Occasions map to search terms (and sometimes a collection).
const OCCASIONS = [
  { re: /\b(winter|cold|cosy|cozy|warm|snow|layer(s|ing)?)\b/, terms: ['hoodie', 'jacket', 'beanie', 'sweatshirt', 'candle', 'denim', 'bomber'], label: 'cosy winter picks' },
  { re: /\b(party|wedding|date|night out|occasion|dinner|event|dressy|fancy)\b/, terms: ['dress', 'heels', 'maxi', 'wrap', 'leather', 'bag'], label: 'going-out pieces' },
  { re: /\b(run|running|gym|sport|sporty|workout|training|jog)\b/, terms: ['runner', 'trainer', 'hoop', 'knit', 'bottle'], label: 'sporty picks' },
  { re: /\b(work|office|meeting|smart|formal|interview)\b/, terms: ['oxford', 'shirt', 'watch', 'backpack', 'leather'], label: 'work-ready picks' },
  { re: /\b(summer|beach|holiday|vacation|sunny|hot)\b/, terms: ['sunglasses', 'shades', 'cap', 'maxi', 'poncho', 'woven'], label: 'summer picks' },
  { re: /\b(relax|lounge|lazy|casual|weekend|comfy|comfortable)\b/, terms: ['hoodie', 'sweatshirt', 'tee', 'slip', 'court'], label: 'laid-back favourites' },
]

// Input is normalised first, so "#2" and "no. 2" arrive as "number 2".
const ORDINALS = [
  [/\b(first|1st|number (one|1))\b/, 0],
  [/\b(second|2nd|number (two|2))\b/, 1],
  [/\b(third|3rd|number (three|3))\b/, 2],
  [/\b(fourth|4th|number (four|4))\b/, 3],
  [/\b(fifth|5th|number (five|5))\b/, 4],
  [/\b(sixth|6th|number (six|6))\b/, 5],
  [/\b(last|final)\b/, -1],
]

const PAGES = [
  { re: /\b(orders?|purchases?|order history)\b/, to: '/orders', name: 'your orders' },
  { re: /\b(favou?rites?|wishlist|saved|liked)\b/, to: '/favourites', name: 'your favourites' },
  { re: /\b(account|profile|settings|password)\b/, to: '/account', name: 'your account' },
  { re: /\b(team|members?|invite)\b/, to: '/team', name: 'your team' },
  { re: /\b(request|can'?t find|source)\b/, to: '/request', name: 'the request form' },
  { re: /\b(inspiration|stories|ideas|lookbook|blog)\b/, to: '/inspiration', name: 'Inspiration' },
  { re: /\b(popular|best ?sellers?|trending)\b/, to: '/popular', name: 'Popular products', catalog: true },
  { re: /\b(offers?|deals?|sale|discounts?)\b/, to: '/collection/offers', name: 'the offers', catalog: true },
  { re: /\b(home ?page|explore|start)\b/, to: '/', name: 'Explore', catalog: true },
]

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const stem = (w) => w.replace(/'s$/, '').replace(/(es|s)$/, (m, _g, i, s) => (s.length > 3 ? '' : m))
const tokens = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9$'\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))

// Precompute a searchable blob per product.
const TYPE_TAGS = {
  Shoes: 'shoe shoes sneaker sneakers trainer trainers footwear kicks',
  Clothing: 'clothes clothing wear outfit top',
  Accessories: 'accessory accessories',
  Home: 'home decor living gift',
  Gifts: 'gift gifts present',
}
// Search text per product, rebuilt whenever the live catalog is (re)loaded.
let indexed = null
let entries = []
const index = () => {
  if (indexed !== products[0] || entries.length !== products.length) {
    indexed = products[0]
    entries = products.map((p) => ({
      p,
      name: p.name.toLowerCase(),
      blob: `${p.name} ${p.label} ${p.type} ${TYPE_TAGS[p.type] ?? ''} ${categories[p.category]?.title ?? ''} ${p.description} ${p.colors.map((c) => c.name).join(' ')}`.toLowerCase(),
    }))
  }
  return entries
}

function parseFilters(t) {
  const f = {}
  if (GENDER.women.test(t) && !GENDER.men.test(t)) f.gender = 'women'
  else if (GENDER.men.test(t) && !GENDER.women.test(t)) f.gender = 'men'

  const types = TYPES.filter((x) => x.re.test(t)).map((x) => x.type)
  if (types.length) f.types = types
  if (/\bgifts?\b|\bpresent\b|\bbirthday\b|\banniversary\b/.test(t)) f.gift = true

  const colors = Object.keys(COLORS).filter((c) => new RegExp(`\\b${c}\\b`).test(t))
  if (colors.length) f.colors = colors.flatMap((c) => COLORS[c])

  let m
  if ((m = t.match(/between\s*\$?(\d+)\s*(?:and|-|to)\s*\$?(\d+)/))) [f.min, f.max] = [Number(m[1]), Number(m[2])]
  else {
    if ((m = t.match(/(?:under|below|less than|cheaper than|max(?:imum)?|up to|within|no more than|budget(?: of| is)?)\s*\$?(\d+)/))) f.max = Number(m[1])
    if ((m = t.match(/(?:over|above|more than|at least|from|min(?:imum)?)\s*\$?(\d+)/))) f.min = Number(m[1])
    if (!f.max && !f.min && (m = t.match(/\$(\d+)/))) f.max = Number(m[1])
  }
  if (/\b(cheap|affordable|budget|inexpensive|low cost)\b/.test(t) && !f.max) f.max = 50
  if (/\b(premium|luxury|luxurious|expensive|high end|splurge)\b/.test(t) && !f.min) f.min = 120

  if (/\b(sale|deals?|discount(ed)?|offers?|bargains?|reduced)\b/.test(t)) f.sale = true
  if (/\b(new|latest|fresh|new in|arrivals?)\b/.test(t)) f.isNew = true
  if (/\b(popular|trending|best ?sellers?|top|hot|favourite)\b/.test(t)) f.sort = 'popular'
  if (/\b(top rated|best rated|highest rated|reviews?)\b/.test(t)) f.sort = 'rating'

  const occ = OCCASIONS.find((o) => o.re.test(t))
  if (occ) f.occasion = occ

  // Leftover words become free-text search terms.
  const known = new Set([
    'gift', 'gifts', 'present', 'cheap', 'under', 'over', 'between', 'sale', 'new', 'popular', 'budget', 'premium',
    'cheaper', 'expensive', 'less', 'only', 'just', 'similar', 'else', 'different', 'option', 'options', 'other', 'others',
    'next', 'fancier', 'nicer', 'affordable', 'lower', 'price', 'higher', 'end', 'trending', 'top', 'best', 'deal', 'deals',
    'size', 'medium', 'small', 'large', 'nice', 'cute', 'good', 'cool', 'great',
    ...Object.keys(COLORS),
  ])
  f.terms = tokens(t)
    .filter((w) => !/^\$?\d+$/.test(w) && !known.has(w) && !GENDER.men.test(w) && !GENDER.women.test(w))
    .map(stem)
  return f
}

function search(f, { limit = 4, offset = 0, exclude = [] } = {}) {
  const terms = [...(f.terms ?? []), ...(f.occasion?.terms ?? [])]
  const scored = index()
    .filter(({ p }) => !exclude.includes(p.id))
    .filter(({ p }) => !f.gender || p.gender === f.gender || p.gender === 'unisex')
    .filter(({ p }) => !f.types || f.types.includes(p.type) || (f.gift && p.type === 'Gifts'))
    .filter(({ p }) => !f.gift || f.types || p.category === 'gifts-living')
    .filter(({ p }) => f.min == null || p.price >= f.min)
    .filter(({ p }) => f.max == null || p.price <= f.max)
    .filter(({ p }) => !f.sale || p.compareAt)
    .filter(({ p }) => !f.isNew || p.isNew)
    .filter(({ p }) => !f.colors || p.colors.some((c) => f.colors.includes(c.name)))
    .map((e) => {
      let score = 0
      for (const w of terms) {
        if (w.length < 2) continue
        if (e.name.includes(w)) score += 4
        else if (e.blob.includes(w)) score += 1
      }
      return { ...e, score }
    })

  // If the shopper typed specific words, only keep products that match at least one.
  const hasTerms = (f.terms ?? []).some((w) => w.length > 2 && index().some((e) => e.blob.includes(w)))
  const pool = hasTerms || f.occasion ? scored.filter((e) => e.score > 0) : scored
  const sortFn =
    f.sort === 'rating' ? (a, b) => b.p.rating - a.p.rating : (a, b) => b.score - a.score || b.p.popularity - a.p.popularity
  const sorted = pool.sort(sortFn)
  return { items: sorted.slice(offset, offset + limit).map((e) => e.p), total: sorted.length }
}

const NOUNS = {
  Shoes: ['shoe', 'shoes'],
  Clothing: ['clothing pick', 'clothing picks'],
  Accessories: ['accessory', 'accessories'],
  Home: ['home piece', 'home pieces'],
}
function describe(f, n = 2) {
  const one = n === 1
  const bits = []
  if (f.colors) bits.push(Object.keys(COLORS).find((c) => COLORS[c].join() === f.colors.join()) ?? 'colourful')
  if (f.sale) bits.push('on-sale')
  if (f.isNew) bits.push('new')
  const who = f.gender === 'men' ? "men's " : f.gender === 'women' ? "women's " : ''
  const what = f.gift
    ? one ? 'gift idea' : 'gift ideas'
    : f.types?.length === 1
      ? NOUNS[f.types[0]][one ? 0 : 1]
      : f.occasion
        ? one ? f.occasion.label.replace(/s$/, '') : f.occasion.label
        : one ? 'pick' : 'picks'
  let price = ''
  if (f.min != null && f.max != null) price = ` between ${money(f.min)} and ${money(f.max)}`
  else if (f.max != null) price = ` under ${money(f.max)}`
  else if (f.min != null) price = ` over ${money(f.min)}`
  return `${bits.join(' ')} ${who}${what}${price}`.replace(/\s+/g, ' ').trim()
}

function resolveRef(t, memory) {
  const list = memory.results ?? []
  if (/\b(it|this|that|this one|that one)\b/.test(t) && !ORDINALS.some(([re]) => re.test(t)) && memory.focus) return productById(memory.focus)
  for (const [re, i] of ORDINALS) {
    if (re.test(t) && list.length) return productById(list[i === -1 ? list.length - 1 : i])
  }
  // By name: "add the copper bomber"
  const hit = index()
    .map((e) => ({ e, n: tokens(t).map(stem).filter((w) => w.length > 2 && e.name.includes(w)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)[0]
  if (hit && hit.n >= 1) return hit.e.p
  return list.length === 1 ? productById(list[0]) : null
}

const SIZE_WORDS = { 'extra small': 'XS', 'extra large': 'XL', small: 'S', medium: 'M', large: 'L' }
// "the third one" when only two were shown.
function outOfRange(t, memory) {
  const n = memory.results?.length ?? 0
  const hit = ORDINALS.find(([re]) => re.test(t))
  if (!hit || hit[1] === -1 || hit[1] < n) return null
  return {
    text: n ? `I only showed you ${n} item${n > 1 ? 's' : ''} just now. Pick one of those, or ask me to “show more”.` : 'I haven’t shown you anything yet. What are you looking for?',
    chips: n ? ['Show more', 'Add the first one'] : ['Show me trending sneakers'],
    mood: 'curious',
  }
}

function parseSize(t, product) {
  const word = Object.keys(SIZE_WORDS).find((w) => t.includes(w))
  if (word && product.sizes.includes(SIZE_WORDS[word])) return SIZE_WORDS[word]
  const m = t.match(/\bsize\s*([a-z0-9]+)\b/) ?? t.match(/\b(xs|xl|s|m|l|\d{2})\b/)
  if (!m) return null
  const s = m[1].toUpperCase()
  return product.sizes.find((x) => x.toUpperCase() === s) ?? null
}
function parseColor(t, product) {
  const names = Object.keys(COLORS).filter((c) => new RegExp(`\\b${c}\\b`).test(t)).flatMap((c) => COLORS[c])
  return product.colors.find((c) => names.includes(c.name) || t.includes(c.name.toLowerCase()))?.name ?? null
}

const resultChips = (items) => [
  items.length ? `Add the first one` : null,
  items.some((p) => isWearable(p.id)) ? `Try on number ${items.findIndex((p) => isWearable(p.id)) + 1}` : null,
  items.length > 1 ? 'Tell me about #2' : null,
  'Show cheaper',
  'Show more',
].filter(Boolean)

function addReply(product, size, color, memory) {
  memory.focus = product.id
  memory.pending = null
  return {
    text: pick([
      `Done! I added the **${product.name}** (${color}, ${size}) to your cart. Anything to go with it?`,
      `Great choice! The **${product.name}** in ${color}, size ${size}, is in your cart.`,
      `Added **${product.name}** · ${color} · ${size}. Want me to find something that matches?`,
    ]),
    actions: [{ type: 'add', id: product.id, size, color }],
    chips: ['Open my cart', 'Find something that matches', 'Checkout'],
    mood: 'happy',
  }
}

function wantAdd(product, t, memory) {
  const size = product.sizes.length === 1 ? product.sizes[0] : parseSize(t, product)
  const color = parseColor(t, product) ?? product.colors[0].name
  if (!size) {
    memory.pending = { type: 'size', id: product.id, color }
    memory.focus = product.id
    return {
      text: `Love it. Which size would you like for the **${product.name}**?`,
      speech: `Love it. Which size would you like for the ${product.name}?`,
      chips: product.sizes.map((s) => `Size ${s}`),
      products: [product.id],
      mood: 'curious',
    }
  }
  return addReply(product, size, color, memory)
}

/**
 * @param {string} input   what the shopper said or typed
 * @param {object} memory  mutable conversation memory (results, filters, focus, pending)
 * @param {object} ctx     { userName, cart: [{name, qty, price}], cartTotal, orders, liked }
 */
export function respond(input, memory, ctx) {
  const t = ` ${input
    .toLowerCase()
    .replace(/(?:#|\bno\.?)\s?(\d)\b/g, ' number $1 ')
    .replace(/[?!.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `
  const name = ctx.userName ? ` ${ctx.userName}` : ''

  // 1. Answering a question Pip asked (size).
  if (memory.pending?.type === 'size') {
    const product = productById(memory.pending.id)
    const size = parseSize(t, product) ?? product.sizes.find((s) => t.includes(` ${s.toLowerCase()} `))
    if (size) return addReply(product, size, parseColor(t, product) ?? memory.pending.color, memory)
    if (!/\b(no|cancel|never ?mind|stop|forget)\b/.test(t) && t.trim().split(' ').length <= 3)
      return {
        text: `Hmm, the ${product.name} comes in ${product.sizes.join(', ')}. Which one?`,
        chips: product.sizes.map((s) => `Size ${s}`),
        mood: 'curious',
      }
    memory.pending = null
  }

  // 2. Small talk.
  if (/^\s*(hi|hey|hello|hiya|yo|good (morning|afternoon|evening))\b/.test(t) && t.trim().split(' ').length <= 4)
    return {
      text: pick([`Hey${name}! 👋 What are we shopping for today?`, `Hi${name}! Tell me what you need and I'll find it.`]),
      chips: ['Show me trending sneakers', 'Gift for my mom under $60', 'Something cosy for winter'],
      mood: 'happy',
    }
  if (/\b(keep shopping|nothing|no thanks|that'?s all|i'?m good)\b/.test(t))
    return { text: 'Sounds good! Just call me whenever you need something 🛍️', chips: ['Show me new arrivals', 'Show me deals'], mood: 'happy' }
  if (/\b(thanks|thank you|thx|cheers|awesome|perfect|great|love it|nice)\b/.test(t) && t.trim().split(' ').length <= 5 && !TYPES.some((x) => x.re.test(t)))
    return { text: pick(['Anytime! 💙', 'Happy to help!', 'You got it! Need anything else?']), chips: ['Show me deals', 'Open my cart'], mood: 'happy' }
  if (/\b(who are you|your name|what are you)\b/.test(t))
    return {
      text: "I'm **Pip**, your little shopping buddy! I can search the store, compare products, add things to your cart and take you anywhere in the app.",
      chips: ['What can you do?', 'Show me new arrivals'],
      mood: 'happy',
    }
  if (/\b(help|what can you do|how does this work|commands)\b/.test(t))
    return {
      text:
        'Try asking me things like:\n• “Red sneakers under $100”\n• “A gift for my dad”\n• “Add the second one in size 42”\n• “Try on number 2” (see it on you!)\n• “Show cheaper” or “Only on sale”\n• “Where is my order?”\n• “Take me to checkout”',
      speech: 'You can ask me for products by colour, price or occasion, ask me to add things to your cart, check your orders, or take you to checkout.',
      chips: ['Red sneakers under $100', 'A gift for my dad', 'Where is my order?'],
    }

  // 3. Cart, checkout and orders.
  if (/\b(check ?out|pay|place (the |my )?order|buy (it|them) now)\b/.test(t)) {
    if (!ctx.cart.length) return { text: "Your cart is empty right now. Want me to find something first?", chips: ['Show me popular picks'], mood: 'sorry' }
    return { text: `Heading to checkout: ${ctx.cart.length} item${ctx.cart.length > 1 ? 's' : ''}, ${money(ctx.cartTotal)} so far.`, actions: [{ type: 'navigate', to: '/checkout' }], mood: 'happy' }
  }
  if (/\b(buy (it|that|them) again|reorder|order (it )?again)\b/.test(t)) {
    const o = ctx.orders[0]
    if (!o) return { text: "You don't have any past orders to repeat yet.", chips: ['Show me popular picks'] }
    return { text: `Added everything from order **${o.id}** back to your cart.`, actions: [{ type: 'reorder', id: o.id }], chips: ['Open my cart', 'Checkout'], mood: 'happy' }
  }
  if (/\b(cart|basket)\b/.test(t) && !/\b(add|put|throw|drop)\b/.test(t)) {
    if (!ctx.cart.length) return { text: 'Your cart is empty. Shall I suggest a few things?', chips: ['Show me popular picks', 'Show me deals'], mood: 'sorry' }
    const list = ctx.cart.map((l) => `• ${l.qty} × ${l.name}`).join('\n')
    return {
      text: `You have ${ctx.cart.length} item${ctx.cart.length > 1 ? 's' : ''} (${money(ctx.cartTotal)}):\n${list}`,
      speech: `You have ${ctx.cart.length} item${ctx.cart.length > 1 ? 's' : ''} in your cart, totalling ${money(ctx.cartTotal)}.`,
      actions: [{ type: 'openCart' }],
      chips: ['Checkout', 'Keep shopping'],
    }
  }
  if (/\b(where('?s| is)|track|status|when will|arriv)\b.*\b(order|package|parcel|delivery)\b|\bmy (last |latest )?order\b/.test(t)) {
    const o = ctx.orders[0]
    if (!o) return { text: "You haven't placed any orders yet.", chips: ['Show me popular picks'] }
    return {
      text: `Your latest order **${o.id}** is **${o.status.toLowerCase()}**. It has ${o.items.length} item${o.items.length > 1 ? 's' : ''} and came to ${money(o.total)}. I've opened it for you.`,
      speech: `Your latest order is ${o.status.toLowerCase()}. I've opened it for you.`,
      actions: [{ type: 'navigate', to: `/orders/${o.id}` }],
      chips: ['Show all orders', 'Buy it again'],
    }
  }

  // 4a. Virtual try-on.
  const tryOn = ctx.tryOn ?? { hasPhoto: false, on: [] }
  if (/\b(sample model|use a model|use (the |a )?sample|model instead)\b/.test(t))
    return { text: 'Sure! I’ll use a sample model so you can see how things look. You can switch to your own photo any time.', actions: [{ type: 'sampleModel' }], chips: ['Try on sunglasses', 'Show me shoes'], mood: 'happy' }
  if (/\b(fitting room|dressing room|try-?on (room|studio))\b/.test(t) && !/\btry (it|this|that|them|number|the)\b/.test(t))
    return {
      text: tryOn.hasPhoto ? 'Opening your fitting room ✨' : 'Opening the fitting room! First I’ll need a full-length photo of you.',
      actions: [{ type: 'fittingRoom' }],
      chips: ['Try on number 1', 'Show me dresses'],
    }
  if (tryOn.on.length) {
    const ADJUST = [
      [/\b(reset|re-?fit|fit (it|them|everything) again|auto-?fit|pip'?s fit)\b/, 'reset', 'Back to my fit ✨'],
      [/\b(bigger|larger|scale up|size up)\b/, 'bigger', 'Made it a little bigger.'],
      [/\b(smaller|scale down|size down|tinier)\b/, 'smaller', 'Made it a little smaller.'],
      [/\b(wider|broader|looser)\b/, 'wider', 'A bit wider now.'],
      [/\b(narrower|slimmer|thinner|tighter)\b/, 'narrower', 'Slimmed it down a touch.'],
      [/\b(longer|lengthen|taller)\b/, 'longer', 'Made it a little longer.'],
      [/\b(shorter|shorten)\b/, 'shorter', 'Made it a little shorter.'],
      [/\bmove (it |this |that )?(up|higher)\b|\braise it\b/, 'up', 'Moved it up.'],
      [/\bmove (it |this |that )?(down|lower)\b|\blower it\b/, 'down', 'Moved it down.'],
      [/\bmove (it |this |that )?left\b/, 'left', 'Moved it left.'],
      [/\bmove (it |this |that )?right\b/, 'right', 'Moved it right.'],
    ]
    const hit = ADJUST.find(([re]) => re.test(t))
    if (hit && !/\b(cheaper|expensive|price)\b/.test(t)) {
      const all = hit[1] === 'reset' && /\b(everything|all|them|whole)\b/.test(t)
      memory.lastAdjust = hit[1] === 'reset' ? null : hit[1]
      return {
        text: `${hit[2]} Keep telling me, or use the sliders in the fitting room.`,
        speech: hit[2],
        actions: [{ type: 'adjust', op: hit[1], all }],
        chips: hit[1] === 'reset' ? ['Make it bigger', 'Move it up'] : ['A bit more', 'Reset the fit', 'Looks good'],
        mood: 'happy',
      }
    }
    if (/\b(a bit more|a little more|more|again)\b/.test(t) && memory.lastAdjust && t.trim().split(' ').length <= 4)
      return { text: 'A little more, done.', actions: [{ type: 'adjust', op: memory.lastAdjust }], chips: ['A bit more', 'Reset the fit', 'Looks good'], mood: 'happy' }
  }
  if (/\b(looks good|perfect fit|that'?s (good|perfect|great))\b/.test(t) && tryOn.on.length)
    return { text: 'Looking sharp! 😍 Want to add the look to your cart or keep styling?', chips: ['Add the look to cart', 'Try on sunglasses', 'Show me shoes'], mood: 'happy' }
  if (/\b(take (it|that|this|them|everything|it all) off|remove (it|that|this)|undress|take off)\b/.test(t) && tryOn.on.length) {
    const all = /\b(everything|it all|them|all)\b/.test(t)
    return {
      text: all ? 'All cleared! Your fitting room is empty again.' : 'Done, I took it off. Want to try something else?',
      actions: [{ type: all ? 'clearLook' : 'untry' }],
      chips: ['Show me something else', 'Show me shoes'],
    }
  }
  if (/\b(add|buy|get) (the |my |this |whole )?(look|outfit)\b/.test(t) && tryOn.on.length)
    return {
      text: `Adding your whole look to the cart: ${tryOn.on.map((x) => x.name).join(', ')}.`,
      actions: [{ type: 'buyLook' }],
      chips: ['Checkout', 'Keep shopping'],
      mood: 'happy',
    }
  if (/\b(try (it|this|that|them|these|number|the|on)|try-?on|on me|how (would|does|will) (it|this|that|they).*look|see (it|this|that) on|wear it|put (it|this|that) on)\b/.test(t)) {
    const oor = outOfRange(t, memory)
    if (oor) return oor
    const product = resolveRef(t, memory)
    if (!product) {
      // "try on a red dress": search for it and put the best match on.
      const f = parseFilters(t.replace(/\b(try|on|me|wear|see|how|would|look)\b/g, ' '))
      const { items } = search({ ...f }, { limit: 6 })
      const wearable = items.find((p) => isWearable(p.id))
      if (!wearable && items.some((p) => needsAiTryOn(p.id))) return { ...NEEDS_AI_TRYON }
      if (!wearable) return { text: 'Tell me which item to try on, e.g. “try on number 2” or “try on a red dress”.', chips: ['Show me dresses', 'Show me sunglasses'], mood: 'curious' }
      memory.results = items.filter((p) => isWearable(p.id)).slice(0, 4).map((p) => p.id)
      memory.focus = wearable.id
      return tryOnReply(wearable, tryOn, memory.results)
    }
    if (needsAiTryOn(product.id)) return { ...NEEDS_AI_TRYON }
    if (!isWearable(product.id))
      return {
        text: `The **${product.name}** isn’t something you can wear, so I can’t put it on you, but it would look great in your cart!`,
        chips: ['Add it to my cart', 'Show me something to wear'],
        mood: 'sorry',
      }
    memory.focus = product.id
    return tryOnReply(product, tryOn)
  }

  // 4b. Acting on a product Pip showed.
  if (/\b(add|put|throw|get me|i'?ll take|buy)\b/.test(t)) {
    const oor = outOfRange(t, memory)
    if (oor) return oor
    const product = resolveRef(t, memory)
    if (product) return wantAdd(product, t, memory)
    if (!memory.results?.length && !/\b(shoes?|dress|jacket|bag|watch|gift)\b/.test(t))
      return { text: 'Sure! Which product should I add? Tell me what you’re looking for first.', chips: ['Show me trending sneakers'], mood: 'curious' }
  }
  if (/\b(save|favou?rite|like|wishlist|heart)\b/.test(t) && !/\b(my favou?rites|show)\b/.test(t)) {
    const oor = outOfRange(t, memory)
    if (oor) return oor
    const product = resolveRef(t, memory)
    if (product) {
      memory.focus = product.id
      return { text: `Saved **${product.name}** to your favourites ❤️`, actions: [{ type: 'like', id: product.id }], chips: ['Show my favourites'], mood: 'happy' }
    }
  }
  if (/\b(tell me (more )?about|details|more about|describe|what about|more info)\b/.test(t) && memory.results?.length) {
    const oor = outOfRange(t, memory)
    if (oor) return oor
    const product = resolveRef(t, memory)
    if (product) {
      memory.focus = product.id
      return {
        text: `**${product.name}** · ${money(product.price)}${product.compareAt ? ` (was ${money(product.compareAt)})` : ''}\n${product.description}\nRated ${product.rating.toFixed(1)}★ by ${product.reviewCount} shoppers. Comes in ${product.colors.map((c) => c.name).join(' and ')}${product.sizes.length > 1 ? `, sizes ${product.sizes[0]}–${product.sizes.at(-1)}` : ''}.`,
        speech: `The ${product.name} is ${money(product.price)}. ${product.description}`,
        products: [product.id],
        chips: ['Add it to my cart', 'Open the product page', 'Show similar'],
      }
    }
  }
  if (/\b(open|go to|view) (the )?product( page)?\b/.test(t) && memory.focus)
    return { text: 'Opening it now.', actions: [{ type: 'navigate', to: `/product/${memory.focus}` }] }
  if (/\bcompare\b/.test(t) && memory.results?.length >= 2) {
    const [a, b] = memory.results.slice(0, 2).map(productById)
    const cheaper = a.price <= b.price ? a : b
    const better = a.rating >= b.rating ? a : b
    return {
      text: `**${a.name}**: ${money(a.price)}, ${a.rating.toFixed(1)}★\n**${b.name}**: ${money(b.price)}, ${b.rating.toFixed(1)}★\nThe ${cheaper.name} is the better deal; the ${better.name} has the happier reviewers.`,
      products: [a.id, b.id],
      chips: ['Add the first one', 'Add the second one'],
    }
  }

  // 5. Navigation.
  // "show me deals" should list products in the chat; "take me to deals" navigates.
  const explicitNav = /\b(go to|take me|open|navigate|bring me|visit|request this)\b/.test(t)
  if (explicitNav || /\bshow( me)?( my| all)?\b/.test(t)) {
    const page = PAGES.find((pg) => pg.re.test(t) && (explicitNav || !pg.catalog))
    if (page && !TYPES.some((x) => x.re.test(t))) return { text: `Taking you to ${page.name}.`, actions: [{ type: 'navigate', to: page.to }] }
  }

  // 6. Refinements on the last search (only when the message doesn't describe something new).
  const fresh = parseFilters(t)
  const bare = !fresh.types && !fresh.occasion && !fresh.gift && !fresh.terms.some((w) => w.length > 2)
  const last = bare ? memory.filters : null
  if (last && /\b(cheaper|less expensive|lower price|more affordable)\b/.test(t)) {
    const prices = (memory.results ?? []).map((id) => productById(id).price)
    return runSearch({ ...last, max: Math.max(10, Math.floor(Math.min(...prices, last.max ?? Infinity) - 1)), min: undefined }, memory, name, { refine: 'cheaper' })
  }
  if (last && /\b(more expensive|premium|fancier|higher end|nicer)\b/.test(t)) {
    const prices = (memory.results ?? []).map((id) => productById(id).price)
    return runSearch({ ...last, min: Math.ceil(Math.max(...prices, 0) + 1), max: undefined }, memory, name, { refine: 'pricier' })
  }
  if (last && /\b(show more|more options|others|something else|anything else|different|next)\b/.test(t))
    return runSearch(last, memory, name, { offset: (memory.offset ?? 0) + (memory.results?.length ?? 4) })
  if (last && /\b(similar|like this|matches|go with it|match)\b/.test(t) && memory.focus) {
    const f = productById(memory.focus)
    return runSearch({ types: f.type === 'Shoes' ? ['Clothing'] : ['Shoes', 'Accessories'], gender: f.gender === 'unisex' ? undefined : f.gender, terms: [] }, memory, name, { exclude: [f.id], refine: 'match' })
  }
  if (last && t.trim().split(' ').length <= 5) {
    const extra = fresh
    const merged = { ...last, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))), terms: last.terms }
    return runSearch(merged, memory, name)
  }

  if (/\b(surprise me|random|anything|inspire me)\b/.test(t)) {
    const ids = [...products].sort(() => Math.random() - 0.5).slice(0, 4)
    memory.results = ids.map((p) => p.id)
    memory.filters = { terms: [] }
    return { text: 'Ooh, fun! Here are four random things I love right now ✨', products: memory.results, chips: resultChips(ids), mood: 'happy' }
  }

  // 7. Everything else is a product search.
  const unknown = fresh.terms.filter((w) => w.length > 2 && !index().some((e) => e.blob.includes(w)))
  const anyFilter = fresh.types || fresh.colors || fresh.gender || fresh.min != null || fresh.max != null || fresh.occasion || fresh.sale || fresh.isNew || fresh.gift || fresh.sort
  if (unknown.length && unknown.length === fresh.terms.filter((w) => w.length > 2).length && !anyFilter) {
    const { items } = search({ sort: 'popular', terms: [] })
    memory.results = items.map((p) => p.id)
    memory.filters = { terms: [] }
    return {
      text: `Hmm, I don't think we carry “${unknown.join(' ')}”. You can send a request and our buyers will try to find it. Meanwhile, here's what's popular:`,
      products: memory.results,
      chips: ['Request this product', 'Show me deals', 'What can you do?'],
      mood: 'sorry',
    }
  }
  return runSearch(fresh, memory, name)
}

function tryOnReply(product, tryOn, products) {
  const slot = SLOT_LABEL[specFor(product.id).slot].toLowerCase()
  if (!tryOn.hasPhoto)
    return {
      text: `Let’s see the **${product.name}** on you! 📸 I need a **full-length photo** first: head to toe, facing the camera. Upload one, take one with your camera, or pick a sample model.`,
      speech: `Let's see the ${product.name} on you! I need a full-length photo first, head to toe, facing the camera. You can upload one, take one with your camera, or use a sample model.`,
      actions: [{ type: 'tryon', id: product.id }],
      products,
      chips: ['Use a sample model'],
      mood: 'curious',
    }
  const next = { top: 'Show matching trousers', outerwear: 'Show me t-shirts', dress: 'Try on heels', bottoms: 'Show me tops', shoes: 'Try on sunglasses' }[slot] ?? 'Show me shoes'
  return {
    text: `I’ve fitted the **${product.name}** to your body ✨ If anything looks off, drag it or just tell me, like “make it a bit bigger” or “move it up”. Want to add more to the look?`,
    actions: [{ type: 'tryon', id: product.id }],
    products,
    chips: [next, 'Take it off', 'Add the look to cart'],
    mood: 'happy',
  }
}

// Live suggestions while the shopper is still talking: search only, no memory changes.
export function preview(text) {
  const t = ` ${text.toLowerCase()} `
  if (t.trim().length < 3) return []
  const f = parseFilters(t)
  const meaningful = f.types || f.colors || f.gift || f.occasion || f.sale || f.isNew || f.max != null || f.min != null ||
    f.terms.some((w) => w.length > 2 && index().some((e) => e.name.includes(w)))
  if (!meaningful) return []
  return search(f, { limit: 6 }).items.map((p) => p.id)
}

function runSearch(f, memory, name, { offset = 0, exclude = [], refine } = {}) {
  let { items, total } = search(f, { offset, exclude })
  let relaxed = false
  if (!items.length && offset === 0) {
    // Relax the strictest constraints: first colour/new/sale, then (unless asked for cheaper) the price.
    const loose = { ...f, colors: undefined, isNew: undefined, sale: undefined }
    ;({ items, total } = search(loose, { exclude }))
    if (!items.length && refine !== 'cheaper') ({ items, total } = search({ ...loose, min: undefined, max: undefined }, { exclude }))
    relaxed = items.length > 0
  }

  if (!items.length) {
    return {
      text: offset
        ? "That's everything I've got for that search! Want to try something different?"
        : `Hmm, I couldn't find anything for that${name}. Try describing it differently, like “black sneakers” or “gift under $50”.`,
      chips: ['Show me popular picks', 'Show me deals', 'Surprise me'],
      mood: 'sorry',
    }
  }

  memory.filters = f
  memory.offset = offset
  memory.results = items.map((p) => p.id)
  memory.focus = items[0].id
  const what = describe(f)
  const top = items[0]

  let text
  if (relaxed) text = `No exact match for ${what}, but these are close:`
  else if (items.length === 1) text = `I found one ${describe(f, 1)}: the **${top.name}** at ${money(top.price)}.`
  else if (refine === 'cheaper') text = `Here are some more budget-friendly options, all under ${money(f.max + 1)}:`
  else if (refine === 'pricier') text = 'Treat yourself! A few more premium picks:'
  else if (refine === 'match') text = 'These would pair nicely with it:'
  else if (offset) text = `Here are ${items.length} more ${what}:`
  else
    text = pick([
      `Found ${total} ${what}. Here are my top ${items.length}: the **${top.name}** is a crowd favourite at ${money(top.price)}.`,
      `Here are ${items.length} ${what} I think you'll love. My pick is the **${top.name}** (${money(top.price)}).`,
      `Ooh, good taste! ${total} ${what} match. Start with the **${top.name}**, it's ${money(top.price)}.`,
    ])

  return {
    text,
    speech: `${text.replace(/\*\*/g, '')} Say “add number one” or ask for something cheaper.`,
    products: memory.results,
    chips: resultChips(items),
    mood: relaxed ? 'curious' : 'happy',
  }
}

export function greeting(userName) {
  return {
    text: `Hi${userName ? ` ${userName}` : ''}! I'm **Pip** 👋 your shopping buddy. Tell me what you're after (a colour, a budget, an occasion) and I'll find it.`,
    speech: `Hi${userName ? ` ${userName}` : ''}! I'm Pip, your shopping buddy. What are we looking for today?`,
    chips: ['Show me trending sneakers', 'Try on a red dress', 'Gift for my mom under $60', 'What can you do?'],
    mood: 'happy',
  }
}
