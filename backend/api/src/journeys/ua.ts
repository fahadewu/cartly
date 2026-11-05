/** Device type, browser and OS from a user agent: enough for analytics, no library needed. */
export function parseUa(ua = '') {
  const device = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua) ? 'tablet' : /Mobi|iPhone|iPod|Android.*Mobile|Opera Mini/i.test(ua) ? 'mobile' : 'desktop';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /UCBrowser/.test(ua) ? 'UC Browser'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Other';
  const os =
    /Windows/.test(ua) ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'Other';
  return { device, browser, os };
}

const SEARCH = /(^|\.)(google|bing|yahoo|duckduckgo|baidu|yandex|ecosia|brave)\./i;
const SOCIAL = /(^|\.)(facebook|fb|instagram|t|twitter|x|tiktok|youtube|linkedin|pinterest|reddit|snapchat|whatsapp|messenger|threads|telegram)\.(com|me|co|org|net)$/i;

/** Where a visit came from: the campaign's utm_source if tagged, else the kind of referring site. */
export function sourceOf(referrer: string | null, ownHosts: string[], utmSource?: string | null) {
  let host: string | null = null;
  try {
    host = referrer ? new URL(referrer).hostname.replace(/^www\./, '').toLowerCase() : null;
  } catch {
    host = null;
  }
  if (host && ownHosts.includes(host)) host = null;
  const source = utmSource?.trim().toLowerCase().slice(0, 60) || (!host ? 'direct' : SEARCH.test(host) ? 'search' : SOCIAL.test(host) ? 'social' : 'referral');
  return { host, source };
}
