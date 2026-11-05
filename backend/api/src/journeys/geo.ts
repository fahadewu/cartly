import { Logger } from '@nestjs/common';
import type { Request } from 'express';
import { env } from '../config.js';

export interface Geo {
  country: string | null;
  region: string | null;
  city: string | null;
  /** cdn | geoip | device */
  source: string | null;
}

// Same table the AI service uses (backend/ai/app/culture.py), for when nothing better is known.
const TZ_COUNTRY: Record<string, string> = {
  'Asia/Dhaka': 'BD', 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Karachi': 'PK', 'Asia/Kathmandu': 'NP',
  'Asia/Colombo': 'LK', 'Asia/Jakarta': 'ID', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Singapore': 'SG', 'Asia/Bangkok': 'TH',
  'Asia/Manila': 'PH', 'Asia/Ho_Chi_Minh': 'VN', 'Asia/Saigon': 'VN', 'Asia/Shanghai': 'CN', 'Asia/Hong_Kong': 'HK',
  'Asia/Taipei': 'TW', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Dubai': 'AE', 'Asia/Riyadh': 'SA', 'Asia/Qatar': 'QA',
  'Asia/Tehran': 'IR', 'Europe/Istanbul': 'TR', 'Africa/Cairo': 'EG', 'Africa/Casablanca': 'MA', 'Africa/Lagos': 'NG',
  'Africa/Nairobi': 'KE', 'Africa/Johannesburg': 'ZA', 'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Europe/Stockholm': 'SE',
  'Europe/Warsaw': 'PL', 'Europe/Lisbon': 'PT', 'Europe/Kyiv': 'UA', 'Europe/Kiev': 'UA', 'Europe/Moscow': 'RU',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US',
  'America/Phoenix': 'US', 'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Mexico_City': 'MX',
  'America/Sao_Paulo': 'BR', 'America/Argentina/Buenos_Aires': 'AR', 'America/Bogota': 'CO', 'America/Lima': 'PE',
  'America/Santiago': 'CL', 'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Perth': 'AU',
  'Pacific/Auckland': 'NZ',
};

const header = (req: Request, name: string) => {
  const v = req.headers[name];
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  if (!s || s === 'XX' || s === 'T1') return null; // Cloudflare: unknown / Tor
  try {
    return decodeURIComponent(s).slice(0, 80); // Vercel URL-encodes city names
  } catch {
    return s.slice(0, 80);
  }
};

type CityReader = { city(ip: string): { country?: { isoCode?: string }; subdivisions?: { names?: { en?: string } }[]; city?: { names?: { en?: string } } } };
let reader: CityReader | null | undefined;
const log = new Logger('Geo');

/** Opens the GeoLite2/GeoIP2 City database once, if GEOIP_DB points at one. */
export async function openGeoIp() {
  if (reader !== undefined || !env.geoipDb) return;
  try {
    const { Reader } = await import('@maxmind/geoip2-node');
    reader = (await Reader.open(env.geoipDb, { cache: { max: 5000 } })) as unknown as CityReader;
    log.log(`GeoIP database loaded from ${env.geoipDb}`);
  } catch (e) {
    reader = null;
    log.warn(`GeoIP database not loaded: ${(e as Error).message}`);
  }
}

/**
 * Approximate location for a request. Only the country, region and city are kept; the IP address is
 * read here and never stored. In order: the CDN's location headers (Cloudflare, Vercel, CloudFront),
 * the GeoIP database, then the device's own time zone or language (country only).
 */
export function geoOf(req: Request, device: { timeZone?: string; locale?: string } = {}): Geo {
  const country = header(req, 'cf-ipcountry') ?? header(req, 'x-vercel-ip-country') ?? header(req, 'cloudfront-viewer-country');
  if (country) {
    return {
      country: country.toUpperCase(),
      region: header(req, 'cf-region') ?? header(req, 'x-vercel-ip-country-region') ?? header(req, 'cloudfront-viewer-country-region-name'),
      city: header(req, 'cf-ipcity') ?? header(req, 'x-vercel-ip-city') ?? header(req, 'cloudfront-viewer-city'),
      source: 'cdn',
    };
  }
  if (reader && req.ip) {
    try {
      const r = reader.city(req.ip.replace(/^::ffff:/, ''));
      if (r.country?.isoCode) {
        return { country: r.country.isoCode, region: r.subdivisions?.[0]?.names?.en ?? null, city: r.city?.names?.en ?? null, source: 'geoip' };
      }
    } catch {
      // private or unknown address: fall through
    }
  }
  const fromLocale = device.locale?.split(/[-_]/).slice(1).find((p) => /^[A-Za-z]{2}$/.test(p));
  const fromTz = device.timeZone ? TZ_COUNTRY[device.timeZone] : undefined;
  const guess = fromTz ?? fromLocale?.toUpperCase();
  return { country: guess ?? null, region: null, city: null, source: guess ? 'device' : null };
}
