// Languages for Pip's voice. With server speech-to-text the spoken language is
// detected automatically; the browser's own recogniser needs one picked up front,
// so the voice screen offers this list (and Pip switches to whatever you last used).
export const LANGUAGES = [
  'en-US', 'en-GB', 'bn-BD', 'hi-IN', 'ur-PK', 'ar-SA', 'es-ES', 'es-MX', 'pt-BR', 'fr-FR', 'de-DE', 'it-IT', 'nl-NL',
  'tr-TR', 'ru-RU', 'pl-PL', 'id-ID', 'ms-MY', 'fil-PH', 'th-TH', 'vi-VN', 'zh-CN', 'ja-JP', 'ko-KR', 'ta-IN', 'sw-KE',
]

// A sensible region when only a language is known ("bn" → "bn-BD").
const REGION = {
  en: 'en-US', bn: 'bn-BD', hi: 'hi-IN', ur: 'ur-PK', ar: 'ar-SA', es: 'es-ES', pt: 'pt-BR', fr: 'fr-FR', de: 'de-DE',
  it: 'it-IT', nl: 'nl-NL', tr: 'tr-TR', ru: 'ru-RU', pl: 'pl-PL', id: 'id-ID', ms: 'ms-MY', fil: 'fil-PH', tl: 'fil-PH',
  th: 'th-TH', vi: 'vi-VN', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', ta: 'ta-IN', sw: 'sw-KE', fa: 'fa-IR', uk: 'uk-UA',
}

export const deviceLocale = () => (typeof navigator !== 'undefined' && navigator.language) || 'en-US'
export const deviceTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}
export const baseOf = (tag) => (tag || '').toLowerCase().split(/[-_]/)[0]

/** A full tag to listen and speak in: "bn" → the device's "bn-IN" if it matches, else "bn-BD". */
export function fullTag(tag) {
  if (!tag) return deviceLocale()
  if (/-/.test(tag)) return tag
  const device = deviceLocale()
  return baseOf(device) === baseOf(tag) ? device : REGION[baseOf(tag)] ?? tag
}

/** The language's own name ("বাংলা", "Español"), with the region ("English (UK)") unless `region: false`. */
export function languageName(tag, { region = true } = {}) {
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(region ? tag : baseOf(tag))
    return name ? name.charAt(0).toLocaleUpperCase(tag) + name.slice(1) : tag
  } catch {
    return tag
  }
}

export const isRtl = (tag) => ['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi'].includes(baseOf(tag))
