import { approvedOrdinanceUrl, clean, normalizeName } from './railwayZoning.ts';
import { isRetiredWorkbookRow } from './retiredWorkbookRow.ts';

const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
function kind(v: unknown) {
  const k = clean(v).toLowerCase();
  if (['city', 'town', 'village', 'borough', 'municipality'].includes(k)) return 'municipality';
  return ['township', 'county'].includes(k) ? k : '';
}

function publisherIdentityMatches(item: any) {
  if (!item.url) return false;
  const u = new URL(item.url), parts = u.pathname.split('/').filter(Boolean);
  // Other publishers' numeric book IDs and government domains require source
  // classification; they are preserved as candidates rather than guessed.
  if (u.hostname !== 'library.municode.com' || parts[0]?.toUpperCase() !== item.state || !parts[1]) return false;
  const normalized = (v: unknown) => normalizeName(v).replace(/[^A-Z0-9]/g, '');
  return normalized(decodeURIComponent(parts[1])) === normalized(item.name);
}

export function parseHarvest(body: any) {
  const platforms = Array.isArray(body?.municipalities) ? { package: { municipalities: body.municipalities } } : body?.platforms;
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) throw new Error('municipalities array or platforms object is required');
  const items: any[] = [], seen = new Map<string, string>();
  for (const platform of Object.values(platforms) as any[]) {
    if (!Array.isArray(platform?.municipalities)) throw new Error('Every platform needs a municipalities array');
    for (const m of platform.municipalities) {
      const state = clean(m.state).toUpperCase(), name = clean(m.municipality || m.jurisdiction), authority = kind(m.jurisdiction_type || m.kind);
      if (!STATES.has(state) || !name || !authority) throw new Error('Each municipality needs a valid state, name and explicit jurisdiction_type');
      const countyFips = clean(m.county_fips);
      if (countyFips && !/^\d{5}$/.test(countyFips)) throw new Error('county_fips must be five digits, including leading zeros');
      const candidate = clean(m.ordinance_source_url || m.url);
      let url = '', heldSource = '';
      if (candidate) {
        try { url = approvedOrdinanceUrl(candidate); } catch { heldSource = candidate; }
      }
      const identity = [state, authority, normalizeName(name), countyFips].join('|');
      if (seen.has(identity)) {
        if (seen.get(identity) !== url) throw new Error('Conflicting source URLs for one incoming jurisdiction');
        continue;
      }
      seen.set(identity, url);
      items.push({ state, name, kind: authority, county_fips: countyFips, url, identity, held_source: heldSource,
        reference_urls: [...new Set([candidate, ...(Array.isArray(m.all_urls) ? m.all_urls : [])].filter(Boolean))] });
      if (items.length > 500) throw new Error('Maximum 500 jurisdictions per batch');
    }
  }
  return items;
}

export function planHarvest(items: any[], rows: any[]) {
  const active = rows.filter(r => !isRetiredWorkbookRow(r));
  return items.map(item => {
    const matches = active.filter(row => clean(row.state).toUpperCase() === item.state &&
      normalizeName(row.jurisdiction || row.county) === normalizeName(item.name) &&
      kind(row.jurisdiction_kind || row.jurisdiction_type) === item.kind &&
      (!item.county_fips || clean(row.county_fips) === item.county_fips));
    if (matches.length !== 1) return { ...item, action: matches.length ? 'ambiguous' : 'needs_identity', record_id: null };
    const row = matches[0], old = clean(row.ordinance_url);
    if (!item.url) return { ...item, record_id: row.id, action: item.held_source ? 'needs_source_review' : 'no_source_url' };
    if (!old && !publisherIdentityMatches(item)) return { ...item, record_id: row.id, action: 'needs_source_review' };
    return { ...item, record_id: row.id, action: old ? old === item.url ? 'already_present' : 'preserve_existing' : 'fill_missing_url' };
  });
}
