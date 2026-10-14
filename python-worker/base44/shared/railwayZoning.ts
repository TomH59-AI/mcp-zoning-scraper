// Uses the existing master promotion gate; no second zoning data store.
import { columnsForHeader } from './masterHeaderColumns.ts';
import { fillBlankPending, headerForColumn } from './masterPromotion.ts';
import { isRetiredWorkbookRow } from './retiredWorkbookRow.ts';

export const RESEARCH_HEADERS = [4, 6, 8, 9, 10, 11, 12, 13, 14, 15, 29, 16, 17, 18, 20, 24];
export const RESEARCH_COLUMNS = ['zoning_contact', 'permit_type', 'ldc_sections', 'maximum_tower_height',
  'height_restrictions', 'setback_rule', 'stealth_mandate', 'colocation_policy', 'residential_separation',
  'tower_separation', 'structure_separation', 'measured_from', 'fall_zone_requirements',
  'pe_letter_acceptable', 'site_plan_jurisdiction', 'building_permit_jurisdiction'];
export const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
export const normalizeName = (v: unknown) => clean(v).toUpperCase()
  .replace(/^(?:CITY|TOWN|VILLAGE|TOWNSHIP|COUNTY|BOROUGH)\s+OF\s+/, '').replace(/[^A-Z0-9]+/g, ' ').trim();

export function missingColumns(row: any): string[] {
  return RESEARCH_COLUMNS.filter((column, i) =>
    !columnsForHeader(RESEARCH_HEADERS[i]).some(name => clean(row?.[name])));
}

export function approvedOrdinanceUrl(value: unknown): string {
  const u = new URL(clean(value));
  const host = u.hostname.toLowerCase();
  const approved = ['municode.com', 'ecode360.com', 'amlegal.com', 'icccodesolutions.org', 'elaws.us'];
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') ||
      !(host.endsWith('.gov') || approved.some(s => host === s || host.endsWith('.' + s))))
    throw new Error('An approved official ordinance URL is required');
  return u.href;
}

export function buildRailwayPatch(row: any, extraction: any, retrieval: any, actor: string, batch: string) {
  if (isRetiredWorkbookRow(row)) throw new Error('Master row is retired');
  if (clean(extraction?.state).toUpperCase() !== clean(row.state).toUpperCase() ||
      normalizeName(extraction?.jurisdiction_name) !== normalizeName(row.jurisdiction || row.county))
    throw new Error('Retrieved jurisdiction does not match the master row');
  const sourceUrl = approvedOrdinanceUrl(retrieval.final_url);
  const text = clean(retrieval.raw_ordinance_text);
  if (!text || !retrieval.text_sha256 || !retrieval.retrieved_at) throw new Error('Retrieval evidence is incomplete');
  const allowed = new Set(missingColumns(row));
  const patch: Record<string, any> = {};
  const filled: string[] = [], rejected: string[] = [], history: any[] = [];
  let working = { ...row };
  for (const field of Array.isArray(extraction?.fields) ? extraction.fields : []) {
    const column = clean(field.column), value = clean(field.value), quote = clean(field.quote), section = clean(field.section_ref);
    if (!allowed.has(column) || filled.includes(column)) continue;
    // Values are verbatim excerpts, not inferred numeric answers or paraphrases.
    if (quote.length < 20 || !text.includes(quote) || !value || !quote.includes(value) ||
        !section || !text.includes(section)) { rejected.push(column); continue; }
    const spec = headerForColumn(column);
    if (!spec) continue;
    const decision = fillBlankPending(working, spec.no, {
      value, quote, section_ref: section, source_url: sourceUrl, source_system: 'railway_playwright',
      sources: [{ url: sourceUrl, quote, section, accessed: retrieval.retrieved_at, title: retrieval.page_title }],
    }, actor, batch, column);
    if (!decision.ok || !decision.patch || decision.action !== 'filled_pending') { rejected.push(column); continue; }
    Object.assign(patch, decision.patch);
    working = { ...working, ...decision.patch };
    filled.push(column);
    if (decision.history) history.push({ ...decision.history, evidence: { ...decision.history.evidence,
      retrieved_text_sha256: retrieval.text_sha256, retrieved_at: retrieval.retrieved_at,
      retrieved_page_only: true, source_truncated: retrieval.truncated === true } });
  }
  if (filled.length && row.verification_status !== 'master_accepted') patch.field_release_policy = 'reviewed_fields_only';
  return { patch, filled, rejected, history };
}

// A concurrent importer/reviewer wins over a stale extraction. No blind update.
export async function compareAndSetMaster(entity: any, row: any, patch: any, requestId?: string) {
  if (!row.id || !row.updated_date) throw new Error('Master version is required');
  const query: Record<string, any> = { id: row.id, updated_date: row.updated_date };
  if (requestId) query['railway_enrichment.request_id'] = requestId;
  await entity.updateMany(query, { $set: patch });
  return await entity.get(row.id);
}
