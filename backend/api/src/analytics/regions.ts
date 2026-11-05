// Where an order went, from the free-text address a shopper typed: a country, and for Bangladesh its
// division and district. Anything that can't be matched with confidence stays unmatched rather than
// guessed, so regional numbers only count what's known.

/** Bangladesh's 64 districts by division (spellings as the government uses them since 2018). */
const DIVISIONS: Record<string, string[]> = {
  Dhaka: ['Dhaka', 'Faridpur', 'Gazipur', 'Gopalganj', 'Kishoreganj', 'Madaripur', 'Manikganj', 'Munshiganj', 'Narayanganj', 'Narsingdi', 'Rajbari', 'Shariatpur', 'Tangail'],
  Chattogram: ['Bandarban', 'Brahmanbaria', 'Chandpur', 'Chattogram', 'Cumilla', "Cox's Bazar", 'Feni', 'Khagrachhari', 'Lakshmipur', 'Noakhali', 'Rangamati'],
  Rajshahi: ['Bogura', 'Joypurhat', 'Naogaon', 'Natore', 'Chapainawabganj', 'Pabna', 'Rajshahi', 'Sirajganj'],
  Khulna: ['Bagerhat', 'Chuadanga', 'Jashore', 'Jhenaidah', 'Khulna', 'Kushtia', 'Magura', 'Meherpur', 'Narail', 'Satkhira'],
  Barishal: ['Barguna', 'Barishal', 'Bhola', 'Jhalokati', 'Patuakhali', 'Pirojpur'],
  Sylhet: ['Habiganj', 'Moulvibazar', 'Sunamganj', 'Sylhet'],
  Rangpur: ['Dinajpur', 'Gaibandha', 'Kurigram', 'Lalmonirhat', 'Nilphamari', 'Panchagarh', 'Rangpur', 'Thakurgaon'],
  Mymensingh: ['Jamalpur', 'Mymensingh', 'Netrokona', 'Sherpur'],
};

/** Older spellings, abbreviations, Bangla names, and city neighbourhoods people write instead of the district. */
const ALIASES: Record<string, string> = {
  chittagong: 'Chattogram', ctg: 'Chattogram', chattagram: 'Chattogram', comilla: 'Cumilla', coxsbazar: "Cox's Bazar", coxbazar: "Cox's Bazar",
  bogra: 'Bogura', jessore: 'Jashore', barisal: 'Barishal', jhalakathi: 'Jhalokati', jhalokathi: 'Jhalokati', nawabganj: 'Chapainawabganj',
  chapainababganj: 'Chapainawabganj', maulvibazar: 'Moulvibazar', moulvi: 'Moulvibazar', netrakona: 'Netrokona', laxmipur: 'Lakshmipur',
  lakshmipur: 'Lakshmipur', bbaria: 'Brahmanbaria', khagrachari: 'Khagrachhari', rangamati: 'Rangamati', jaipurhat: 'Joypurhat',
  // Bangla
  ঢাকা: 'Dhaka', চট্টগ্রাম: 'Chattogram', সিলেট: 'Sylhet', খুলনা: 'Khulna', রাজশাহী: 'Rajshahi', বরিশাল: 'Barishal', রংপুর: 'Rangpur',
  ময়মনসিংহ: 'Mymensingh', কুমিল্লা: 'Cumilla', গাজীপুর: 'Gazipur', নারায়ণগঞ্জ: 'Narayanganj', বগুড়া: 'Bogura', যশোর: 'Jashore',
  // Dhaka city and around
  dhanmondi: 'Dhaka', gulshan: 'Dhaka', banani: 'Dhaka', mirpur: 'Dhaka', uttara: 'Dhaka', mohammadpur: 'Dhaka', motijheel: 'Dhaka',
  badda: 'Dhaka', bashundhara: 'Dhaka', baridhara: 'Dhaka', tejgaon: 'Dhaka', lalbagh: 'Dhaka', olddhaka: 'Dhaka', savar: 'Dhaka',
  keraniganj: 'Dhaka', khilgaon: 'Dhaka', rampura: 'Dhaka', malibagh: 'Dhaka', farmgate: 'Dhaka', shyamoli: 'Dhaka', mohakhali: 'Dhaka',
  wari: 'Dhaka', jatrabari: 'Dhaka', azimpur: 'Dhaka', lalmatia: 'Dhaka', shantinagar: 'Dhaka', moghbazar: 'Dhaka', niketan: 'Dhaka',
  // Elsewhere
  tongi: 'Gazipur', fatullah: 'Narayanganj', agrabad: 'Chattogram', halishahar: 'Chattogram', pahartali: 'Chattogram', nasirabad: 'Chattogram',
  panchlaish: 'Chattogram', zindabazar: 'Sylhet', ambarkhana: 'Sylhet',
};

const key = (s: string) => s.normalize('NFKC').toLowerCase().replace(/['’.\-\s]/g, '');
const DISTRICT: Map<string, { district: string; division: string }> = new Map();
for (const [division, districts] of Object.entries(DIVISIONS)) for (const d of districts) DISTRICT.set(key(d), { district: d, division });
for (const [alias, d] of Object.entries(ALIASES)) {
  const found = DISTRICT.get(key(d));
  if (found) DISTRICT.set(key(alias), found);
}
export const BD_DIVISIONS = Object.keys(DIVISIONS);

const BD = new Set(['bangladesh', 'bd', 'বাংলাদেশ', 'bangla desh']);
const COUNTRY_FIX: Record<string, string> = { uk: 'United Kingdom', 'great britain': 'United Kingdom', england: 'United Kingdom', usa: 'United States', us: 'United States', 'u.s.a.': 'United States', uae: 'United Arab Emirates' };
const title = (s: string) => s.trim().toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());

export interface Region {
  country: string;
  /** Bangladesh only: the division and district, when the address says which. */
  division: string | null;
  district: string | null;
  /** The finest known place: a district in Bangladesh, the city elsewhere. */
  place: string | null;
}

/** Finds the district in a piece of text: the whole text first, then word by word ("House 5, Dhanmondi"). */
function district(text: string) {
  const whole = DISTRICT.get(key(text));
  if (whole) return whole;
  const words = text.split(/[,/\s]+/).filter(Boolean);
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const hit = DISTRICT.get(key(words.slice(i, i + n).join(' ')));
      if (hit) return hit;
    }
  }
  return null;
}

export function regionOf(address: { city?: string; country?: string; street?: string } | null | undefined): Region {
  const rawCountry = (address?.country ?? '').trim();
  const lc = rawCountry.toLowerCase();
  const city = (address?.city ?? '').trim();
  const inBd = BD.has(lc) || (!rawCountry && !!district(city));
  if (!inBd) {
    const country = rawCountry ? (COUNTRY_FIX[lc] ?? title(rawCountry)) : 'Unknown';
    return { country, division: null, district: null, place: city ? title(city) : null };
  }
  const hit = district(city) ?? (address?.street ? district(address.street) : null);
  return { country: 'Bangladesh', division: hit?.division ?? null, district: hit?.district ?? null, place: hit?.district ?? null };
}

/** "Bangladesh · Dhaka division", "United Kingdom": the level regional reports group by. */
export const regionLabel = (r: Region) => (r.country === 'Bangladesh' ? (r.division ? `${r.division} division` : 'Bangladesh (area unknown)') : r.country);
