// runScraper — reads the Notion database "The United States Zoning URL"
// (Jurisdiction | Authority Level | URL | State), scrapes every URL for a
// jurisdiction, and POSTs the cleaned page text to the SiteHawk Base44 intake
// function `zoningScraperIngest`, which LLM-extracts the complete five-section
// SCIP profile and upserts Jurisdiction / TelecomOrdinance / JurisdictionRegistry
// / JurisdictionResource.
//
// Env (Railway → Variables):
//   NOTION_KEY             Notion integration token (the DB must be shared with it)
//   NOTION_ZONING_DB       database id, e.g. 356274bf71c180af8163d29dfbd263df
//   BASE44_ZONING_INGEST   https://site-hawk-pro.base44.app/functions/zoningScraperIngest
//   BASE44_WEBHOOK_SECRET  the app's WEBHOOK_SECRET  (falls back to BASE44_API_KEY)
//   SCRAPFLY_API_KEY / SCRAPFLY_KEY, OXYLABS_USERNAME, OXYLABS_PASSWORD / OXYLABS_KEY
import axios from "axios";
import { renderWithOxylabsHeadless, renderWithPlaywright } from "./browserRenderer.js";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

// ---------- types ----------
export interface ZoningSource {
  jurisdiction: string;
  state: string;
  authority_level: string | null;
  url: string;
  notion_page_id: string;
}

export interface JurisdictionGroup {
  jurisdiction: string;
  state: string;
  sources: ZoningSource[];
}

export interface ScrapedSource {
  url: string;
  authority_level: string | null;
  text: string;
  ok: boolean;
  method: string | null;
  error?: string;
  chars: number;
}

export interface Base44DestinationProof {
  verified: boolean;
  canonical_key?: string;
  canonical_version?: string;
  projections_linked?: boolean;
  raw_verified?: boolean;
  record_ids?: {
    registry?: string | null;
    jurisdiction?: string | null;
    telecom_ordinance?: string | null;
    zoning_ordinance?: string | null;
  };
}

export interface Base44IngestResult {
  ok: boolean;
  skipped?: boolean;
  status: number;
  summary?: unknown;
  error?: string;
  destination_verified?: Base44DestinationProof;
  canonical_key?: string;
  canonical_version?: string;
  base44_record_ids?: Record<string, string | null | undefined>;
}

export interface JurisdictionResult {
  jurisdiction: string;
  state: string;
  sources: Array<Pick<ScrapedSource, "url" | "authority_level" | "ok" | "method" | "chars" | "error">>;
  polygon_found: boolean;
  ingest: Base44IngestResult;
  seconds: number;
}

export interface RunOptions {
  state?: string;
  jurisdiction?: string;
  /** Internal queue contract: run these exact names, in this exact order. */
  expectedJurisdictions?: string[];
  limit?: number;
  offset?: number;
  dryRun?: boolean;
  includePolygon?: boolean;
  skipExtraction?: boolean;
}

export interface RunSummary {
  run_id: string;
  total_jurisdictions_in_db: number;
  selected: number;
  processed: number;
  ingested_ok: number;
  ingested_failed: number;
  urls_scraped_ok: number;
  urls_failed: number;
  dry_run: boolean;
  results: JurisdictionResult[];
}

// ---------- env ----------
function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
function optionalEnv(...names: string[]): string | null {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return null;
}

// ---------- Notion reading ----------
const NOTION_API_VERSION = "2026-03-11";

type NotionPageList = {
  results: unknown[];
  has_more: boolean;
  next_cursor?: string | null;
};

async function notionApi<T>(apiKey: string, pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.notion.com/v1${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const message = typeof body?.message === "string" ? body.message : response.statusText;
    throw new Error(`Notion API ${response.status}: ${message}`);
  }
  return body as T;
}

async function resolveDataSourceId(apiKey: string, databaseId: string): Promise<string> {
  const configured = optionalEnv("NOTION_ZONING_DATA_SOURCE");
  if (configured) return configured;

  const database = await notionApi<{ data_sources?: Array<{ id?: string }> }>(
    apiKey,
    `/databases/${databaseId}`,
  );
  const dataSourceId = database.data_sources?.find((item) => item?.id)?.id;
  if (!dataSourceId) {
    throw new Error(
      "Notion database has no queryable data source. Set NOTION_ZONING_DATA_SOURCE to its data source ID.",
    );
  }
  return dataSourceId;
}

function plain(property: unknown): string | null {
  if (typeof property !== "object" || property === null || !("type" in property)) return null;
  const p = property as { type: string; [k: string]: unknown };
  const parts =
    p.type === "title" ? (p.title as Array<{ plain_text?: string }>) :
    p.type === "rich_text" ? (p.rich_text as Array<{ plain_text?: string }>) :
    null;
  if (parts) {
    const text = parts.map((t) => t?.plain_text ?? "").join("").trim();
    return text || null;
  }
  if (p.type === "url") return typeof p.url === "string" ? p.url.trim() || null : null;
  if (p.type === "select") return (p.select as { name?: string } | null)?.name?.trim() || null;
  return null;
}

// Many rows are Google-search-wrapped: https://www.google.com/search?q=https://city.gov/zoning
export function unwrapUrl(raw: string): string {
  let url = raw.trim();
  try {
    const u = new URL(url);
    if (/(^|\.)google\.com$/i.test(u.hostname) && u.pathname === "/search") {
      const q = u.searchParams.get("q") || "";
      const m = q.match(/https?:\/\/\S+/i);
      if (m) url = m[0];
    } else if (/(^|\.)google\.com$/i.test(u.hostname) && u.pathname === "/url") {
      url = u.searchParams.get("q") || u.searchParams.get("url") || url;
    }
  } catch {
    /* keep as-is */
  }
  return url.replace(/[),.]+$/, "");
}

const STATE_CODES: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO",
  CONNECTICUT: "CT", DELAWARE: "DE", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID",
  ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA",
  MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN",
  MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV",
  "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY",
  "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR",
  PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD",
  TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA",
  "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY", "DISTRICT OF COLUMBIA": "DC",
};
export function toStateCode(value: string): string {
  const s = value.trim().toUpperCase();
  if (s.length === 2) return s;
  return STATE_CODES[s] || s;
}

export async function getZoningSources(): Promise<ZoningSource[]> {
  const apiKey = requiredEnv("NOTION_KEY");
  const database_id = requiredEnv("NOTION_ZONING_DB");
  const data_source_id = await resolveDataSourceId(apiKey, database_id);
  const sources: ZoningSource[] = [];
  let cursor: string | undefined;

  do {
    const response = await notionApi<NotionPageList>(
      apiKey,
      `/data_sources/${data_source_id}/query`,
      {
        method: "POST",
        body: JSON.stringify({ start_cursor: cursor, page_size: 100 }),
      },
    );
    for (const page of response.results) {
      if (
        typeof page !== "object" ||
        page === null ||
        !("id" in page) ||
        !("properties" in page)
      ) continue;
      const fullPage = page as { id: string; properties: Record<string, unknown> };
      const props = fullPage.properties;
      const jurisdiction = plain(props.Jurisdiction);
      // The current registry has the state column under an empty display name,
      // while some Notion surfaces expose custom columns by their stable ID.
      // Keep the named properties first and accept both existing representations.
      const stateRaw = plain(props.State) ?? plain(props[""]);
      const urlRaw = plain(props.URL) ?? plain(props["userDefined:URL"]);
      const authority_level = plain(props["Authority Level"]);
      if (!jurisdiction || !stateRaw || !urlRaw || !/^https?:\/\//i.test(urlRaw)) continue;
      sources.push({
        jurisdiction,
        state: toStateCode(stateRaw),
        authority_level,
        url: unwrapUrl(urlRaw),
        notion_page_id: fullPage.id,
      });
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return sources;
}

export function groupByJurisdiction(sources: ZoningSource[]): JurisdictionGroup[] {
  const map = new Map<string, JurisdictionGroup>();
  for (const s of sources) {
    const key = `${s.state}::${s.jurisdiction.toLowerCase()}`;
    let g = map.get(key);
    if (!g) {
      g = { jurisdiction: s.jurisdiction, state: s.state, sources: [] };
      map.set(key, g);
    }
    if (!g.sources.some((x) => x.url === s.url)) g.sources.push(s);
  }
  return [...map.values()].sort((a, b) =>
    a.state === b.state ? a.jurisdiction.localeCompare(b.jurisdiction) : a.state.localeCompare(b.state)
  );
}

export function selectGroups(groups: JurisdictionGroup[], opts: RunOptions): JurisdictionGroup[] {
  let out = groups;
  if (opts.state) {
    const st = toStateCode(opts.state);
    out = out.filter((g) => g.state === st);
  }
  if (opts.jurisdiction) {
    const needle = opts.jurisdiction.toLowerCase();
    out = out.filter((g) => g.jurisdiction.toLowerCase().includes(needle));
  }
  if (opts.expectedJurisdictions) {
    if (!opts.expectedJurisdictions.length) {
      throw new Error("The queue supplied an empty exact jurisdiction claim.");
    }
    const uniqueNames = new Set(opts.expectedJurisdictions);
    if (uniqueNames.size !== opts.expectedJurisdictions.length) {
      throw new Error("The queue supplied duplicate exact jurisdiction names.");
    }
    const byName = new Map(out.map((group) => [group.jurisdiction, group]));
    const missing = opts.expectedJurisdictions.filter((name) => !byName.has(name));
    if (missing.length) {
      throw new Error(`The persisted queue claim no longer exists in Notion: ${missing.join(", ")}`);
    }
    return opts.expectedJurisdictions.map((name) => byName.get(name)!);
  }
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 500));
  return out.slice(offset, offset + limit);
}

// ---------- scraping ----------
export function cleanHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|p|div|li|tr|h[1-6]|section|article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const MAX_TEXT_CHARS = 60000;

function selectRelevantSourceText(text: string, limit = MAX_TEXT_CHARS): string {
  if (text.length <= limit) return text;

  const selected: Array<[number, number]> = [];
  let output = "";
  const appendRange = (start: number, end: number, label: string) => {
    if (output.length >= limit) return;
    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(text.length, end);
    if (safeEnd <= safeStart) return;
    const overlap = selected.some(([a, b]) => {
      const shared = Math.max(0, Math.min(b, safeEnd) - Math.max(a, safeStart));
      return shared / (safeEnd - safeStart) > 0.6;
    });
    if (overlap) return;
    const marker = output ? `\n\n[${label} near source character ${safeStart}]\n` : "";
    const remaining = limit - output.length - marker.length;
    if (remaining <= 0) return;
    output += marker + text.slice(safeStart, Math.min(safeEnd, safeStart + remaining));
    selected.push([safeStart, safeEnd]);
  };

  const sample = (pattern: RegExp, count: number, before: number, after: number, label: string) => {
    const positions = [...text.matchAll(pattern)].map((match) => match.index).filter((index): index is number => Number.isFinite(index));
    if (!positions.length) return;
    const sampleCount = Math.min(count, positions.length);
    for (let index = 0; index < sampleCount; index += 1) {
      const position = positions[Math.floor(index * (positions.length - 1) / Math.max(1, sampleCount - 1))];
      appendRange(position - before, position + after, label);
    }
  };

  appendRange(0, 4000, "Document opening");
  // Highest priority: distribute broad windows across the exact tower article,
  // even when that article is hundreds of pages into the source PDF.
  sample(/communication tower|tower site|communication antenna/gi, 12, 1800, 2600, "Communication tower excerpt");
  sample(/wireless|telecommunications?|antenna|collocat(?:e|ion)|small cell/gi, 6, 900, 1300, "Wireless facilities excerpt");
  sample(/conditional use|special exception|special permit|public hearing|board of zoning appeals|board of adjustment|appeal|site plan/gi, 6, 850, 1250, "Approval process excerpt");
  sample(/setback|fall zone|collapse zone|height|residential separation|tower separation|stealth|conceal|landscap|screen|fenc/gi, 6, 850, 1250, "Technical standards excerpt");
  sample(/building permit|planning department|zoning department|fee|validity|extension|bond|e-?911|address/gi, 5, 750, 1100, "Permitting excerpt");
  appendRange(text.length - 1500, text.length, "Document ending");
  return output.slice(0, limit);
}

async function scrapeWithOxyLabs(url: string): Promise<string> {
  return (await renderWithOxylabsHeadless(url)).html;
}

async function scrapeWithScrapfly(url: string): Promise<string> {
  const key = optionalEnv("SCRAPFLY_API_KEY", "SCRAPFLY_KEY");
  if (!key) throw new Error("Scrapfly key not configured");
  const response = await axios.get<{ result?: { content?: string; format?: string; content_type?: string } }>("https://api.scrapfly.io/scrape", {
    params: { key, url, render_js: !/\.pdf(?:$|[?#])/i.test(url), asp: true, country: "us" },
    timeout: 90000,
  });
  const result = response.data.result;
  const content = result?.content;
  if (!content) throw new Error("Scrapfly returned no content");
  const format = String(result?.format || "").toLowerCase();
  const isPdf = /\.pdf(?:$|[?#])/i.test(url) || /application\/pdf/i.test(String(result?.content_type || ""));
  if (isPdf || format === "binary" || format === "blob") {
    const bytes = format === "blob"
      ? Buffer.from((await axios.get<ArrayBuffer>(content, { params: { key }, responseType: "arraybuffer", timeout: 90000 })).data)
      : Buffer.from(content, "base64");
    const parsed = await pdfParse(bytes);
    if (!parsed.text || parsed.text.length < 400) throw new Error("Scrapfly PDF contained no extractable text");
    return parsed.text;
  }
  if (format === "clob" && /^https?:\/\//i.test(content)) {
    return String((await axios.get(content, { params: { key }, responseType: "text", timeout: 90000 })).data || "");
  }
  return content;
}

async function scrapeDirect(url: string): Promise<string> {
  const response = await axios.get<string>(url, {
    timeout: 30000,
    responseType: "text",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SiteHawk-ZoningScraper/1.0)" },
    maxRedirects: 5,
  });
  return String(response.data ?? "");
}

async function scrapeWithPlaywright(url: string): Promise<string> {
  return renderWithPlaywright(url);
}

function isJsHeavyCodeSite(url: string): boolean {
  return /municode|amlegal|generalcode|ecode360|codelibrary/i.test(url);
}

export function looksLikePlaceholder(text: string): boolean {
  return text.length < 400 || /loading\s*(please\s*)?wait|enable javascript|access denied|just a moment|initializing application|requested content cannot be found|not authorized to view it/i.test(text.slice(0, 1200));
}

// Resolve the exact library section through Municode's public JSON service.
// The browser shell can show a 200 error page for an otherwise valid section.
export async function scrapeMunicodeSection(
  url: string,
  getJson: (url: string) => Promise<any> = async (target) => (await axios.get(target, { timeout: 30000 })).data,
): Promise<string> {
  const source = new URL(url);
  const parts = source.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const nodeId = source.searchParams.get('nodeId');
  if (source.hostname !== 'library.municode.com' || parts[2] !== 'codes' || !nodeId || !parts[3]) {
    throw new Error('Municode API requires an explicit library code section URL');
  }
  const client = await getJson(`https://library.municode.com/localapi/Organizations/GetByUrlEncodedNames/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`);
  if (!client?.ClientID || String(client.State?.StateAbbreviation).toLowerCase() !== parts[0].toLowerCase()) {
    throw new Error('Municode library client identity mismatch');
  }
  const content = await getJson(`https://api.municode.com/ClientContent/${client.ClientID}`);
  const slug = (s: unknown) => String(s || '').trim().toLowerCase().replace(/\s+/g, '_');
  const products = (content?.codes || []).filter((p: any) => !p.hideInLibrary && slug(p.productName) === parts[3].toLowerCase());
  if (products.length !== 1) throw new Error('Municode code product is missing or ambiguous');
  const productId = products[0].productId;
  const job = await getJson(`https://api.municode.com/Jobs/latest/${productId}`);
  if (!job?.Id || String(job.ProductId) !== String(productId)) throw new Error('Municode edition identity mismatch');
  const query = new URLSearchParams({ productId: String(productId), jobId: String(job.Id), nodeId, groupChunks: 'false' });
  const section = await getJson(`https://api.municode.com/CodesContent?${query}`);
  const docs = Array.isArray(section?.Docs) ? section.Docs : [];
  if (!docs.some((d: any) => d.Id === nodeId)) throw new Error('Municode response does not contain the requested section');
  const text = docs.filter((d: any) => typeof d.Content === 'string').map((d: any) => `${d.Title || ''}\n${cleanHtml(d.Content)}`).join('\n\n');
  if (looksLikePlaceholder(text)) throw new Error('Municode section contains no usable ordinance text');
  return text;
}

export async function scrapeUrl(url: string): Promise<{ text: string; method: string }> {
  const attempts: Array<[string, () => Promise<string>]> = isJsHeavyCodeSite(url)
    ? [["scrapfly", () => scrapeWithScrapfly(url)], ["playwright", () => scrapeWithPlaywright(url)], ["oxylabs_headless", () => scrapeWithOxyLabs(url)]]
    : [["scrapfly", () => scrapeWithScrapfly(url)], ["direct", () => scrapeDirect(url)], ["playwright", () => scrapeWithPlaywright(url)], ["oxylabs_headless", () => scrapeWithOxyLabs(url)]];

  const errors: string[] = [];
  if (new URL(url).hostname === 'library.municode.com' && new URL(url).searchParams.has('nodeId')) {
    try { return { text: await scrapeMunicodeSection(url), method: 'municode_api' }; }
    catch (error) { errors.push(`municode_api: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const [method, fn] of attempts) {
    try {
      const html = await fn();
      const text = cleanHtml(html);
      if (looksLikePlaceholder(text)) {
        errors.push(`${method}: thin/placeholder page (${text.length} chars)`);
        continue;
      }
      return { text: selectRelevantSourceText(text), method };
    } catch (err) {
      errors.push(`${method}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(errors.join(" | "));
}

export async function renderZoningUrl(
  url: string,
  engine: "auto" | "oxylabs_headless" = "auto",
): Promise<{
  url: string;
  final_url: string;
  title: string | null;
  status_code: number | null;
  method: string;
  text: string;
  chars: number;
  source_chars: number;
  truncated: boolean;
  low_signal: boolean;
  links: Array<{ url: string; title: string }>;
}> {
  if (engine === "auto") {
    const result = await scrapeUrl(url);
    return {
      url,
      final_url: url,
      title: null,
      status_code: null,
      method: result.method,
      text: result.text,
      chars: result.text.length,
      source_chars: result.text.length,
      truncated: result.text.length >= MAX_TEXT_CHARS,
      low_signal: looksLikePlaceholder(result.text),
      links: [],
    };
  }

  const rendered = await renderWithOxylabsHeadless(url);
  const cleaned = cleanHtml(rendered.html);
  if (!cleaned) throw new Error("oxylabs_headless: rendered page contained no readable text");
  const selected = selectRelevantSourceText(cleaned);
  return {
    url,
    final_url: rendered.finalUrl,
    title: rendered.title || null,
    status_code: rendered.statusCode,
    method: "oxylabs_headless",
    text: selected,
    chars: selected.length,
    source_chars: cleaned.length,
    truncated: selected.length < cleaned.length,
    low_signal: looksLikePlaceholder(cleaned),
    links: rendered.links,
  };
}

async function scrapeGroup(group: JurisdictionGroup): Promise<ScrapedSource[]> {
  const out: ScrapedSource[] = [];
  for (const s of group.sources) {
    try {
      const { text, method } = await scrapeUrl(s.url);
      out.push({ url: s.url, authority_level: s.authority_level, text, ok: true, method, chars: text.length });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      out.push({ url: s.url, authority_level: s.authority_level, text: "", ok: false, method: null, error, chars: 0 });
    }
  }
  return out;
}

// ---------- polygon (best-effort, never fatal) ----------
let lastNominatimAt = 0;
async function getJurisdictionPolygon(jurisdiction: string, state: string): Promise<unknown | null> {
  try {
    const wait = 1100 - (Date.now() - lastNominatimAt); // Nominatim: max 1 req/s
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatimAt = Date.now();
    const isCounty = /\bcounty\b/i.test(jurisdiction);
    const params: Record<string, string | number> = {
      state,
      country: "USA",
      format: "geojson",
      polygon_geojson: 1,
      limit: 1,
    };
    if (isCounty) params.county = jurisdiction; else params.city = jurisdiction.replace(/\b(charter )?township\b/i, "").trim();
    const response = await axios.get<{ features?: Array<{ geometry?: unknown }> }>(
      "https://nominatim.openstreetmap.org/search",
      { params, headers: { "User-Agent": "mcp-zoning-scraper/1.0 (SiteHawk)" }, timeout: 15000 }
    );
    return response.data.features?.[0]?.geometry ?? null;
  } catch {
    return null;
  }
}

// ---------- Base44 intake ----------
function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function nonempty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function identity(value: unknown): string | null {
  const text = nonempty(value);
  return text ? text.replace(/\s+/g, " ").toLowerCase() : null;
}

function inferredAuthorityHint(jurisdiction: string): string {
  const normalized = jurisdiction.toLowerCase();
  if (/\bcounty\b/.test(normalized)) return "county";
  if (/\btownship\b/.test(normalized)) return "township";
  if (/\bvillage\b/.test(normalized)) return "village";
  if (/\bcity\b/.test(normalized)) return "city";
  return "municipality";
}

// Keep this identity check aligned with Base44 shared/canonicalZoning.ts. It
// binds a valid-looking proof to the jurisdiction that Railway actually sent,
// instead of accepting two internally matching keys for the wrong destination.
function expectedCanonicalKey(state: string, jurisdiction: string, suppliedAuthority?: unknown): string {
  const hint = `${nonempty(suppliedAuthority) || inferredAuthorityHint(jurisdiction)} ${jurisdiction}`.toLowerCase();
  const authorityKind = /\bstate\b/.test(hint)
    ? "state"
    : /special\s+district|authority|district/.test(hint)
      ? "special_district"
      : /township/.test(hint)
        ? "township"
        : /county|parish|county[- ]equivalent|unincorporated[_ -]county|census area/.test(hint)
          || (state === "AK" && /borough|municipality/.test(hint))
          ? "county"
          : /city|town|village|borough|municipal|municipality/.test(hint)
            ? "municipality"
            : "unknown";
  let name = jurisdiction
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .replace(/^\s*[A-Z]{2}\s*[-:]\s*/, "")
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:CITY|TOWN|VILLAGE|BOROUGH|TOWNSHIP|COUNTY) OF\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (authorityKind === "county") {
    name = name.replace(/\s+(?:COUNTY|PARISH|BOROUGH|CENSUS AREA|MUNICIPALITY)$/, "").trim();
  } else if (authorityKind === "municipality") {
    name = name.replace(/\s+(?:CITY|TOWN|VILLAGE|BOROUGH)$/, "").trim();
  } else if (authorityKind === "township") {
    name = name.replace(/\s+(?:CHARTER )?TOWNSHIP$/, "").trim();
  }
  return `US|${state}|${authorityKind}|${name}`;
}

function requestRequiresRaw(request: Record<string, any> | null): boolean {
  if (!request || request.skip_extraction === true || !Array.isArray(request.sources)) return false;
  return request.sources.some((value: unknown) => {
    const source = asRecord(value);
    return source?.ok !== false
      && typeof source?.text === "string"
      && source.text.length > 200;
  });
}

export function verifyBase44IngestResponse(
  responseBody: unknown,
  requestPayload: unknown,
): { ok: true; proof: Base44DestinationProof; body: Record<string, any> } | { ok: false; error: string; proof?: Base44DestinationProof } {
  const body = asRecord(responseBody);
  const request = asRecord(requestPayload);
  const proofRecord = asRecord(body?.destination_verified);
  const proof = proofRecord as Base44DestinationProof | null;
  const proofIds = asRecord(proofRecord?.record_ids) || {};
  const returnedIds = asRecord(body?.base44_record_ids) || {};
  const fail = (error: string) => ({
    ok: false as const,
    error,
    ...(proof ? { proof } : {}),
  });

  if (!body) return fail("Base44 response body is not a JSON object");
  if (body.ok !== true) return fail("Base44 response did not contain boolean ok=true");
  if (proofRecord?.verified !== true || proofRecord?.projections_linked !== true) {
    return fail("missing or failed destination_verified proof");
  }

  const canonicalKey = nonempty(body.canonical_key);
  const proofCanonicalKey = nonempty(proofRecord.canonical_key);
  if (!canonicalKey || !proofCanonicalKey || canonicalKey !== proofCanonicalKey) {
    return fail("canonical_key is missing or inconsistent with destination proof");
  }
  const canonicalVersion = nonempty(body.canonical_version);
  const proofCanonicalVersion = nonempty(proofRecord.canonical_version);
  if (!canonicalVersion || !proofCanonicalVersion || canonicalVersion !== proofCanonicalVersion) {
    return fail("canonical_version is missing or inconsistent with destination proof");
  }

  if (!request) return fail("request payload is not a JSON object");
  const responseState = nonempty(body.state);
  const requestState = nonempty(request.state);
  if (!responseState || !requestState || toStateCode(responseState) !== toStateCode(requestState)) {
    return fail("Base44 response state does not match the requested state");
  }
  const responseJurisdiction = identity(body.jurisdiction);
  const requestJurisdiction = identity(request.jurisdiction);
  if (!responseJurisdiction || !requestJurisdiction || responseJurisdiction !== requestJurisdiction) {
    return fail("Base44 response jurisdiction does not match the requested jurisdiction");
  }
  const expectedKey = expectedCanonicalKey(
    toStateCode(requestState),
    request.jurisdiction as string,
    request.authority_kind,
  );
  if (canonicalKey !== expectedKey) {
    return fail(`canonical_key does not match the requested jurisdiction identity (${expectedKey})`);
  }

  const idPairs: Array<[string, unknown, unknown]> = [
    ["registry", proofIds.registry, returnedIds.jurisdiction_registry_id],
    ["jurisdiction", proofIds.jurisdiction, returnedIds.jurisdiction_id],
    ["telecom_ordinance", proofIds.telecom_ordinance, returnedIds.telecom_ordinance_id],
  ];
  for (const [name, proofIdRaw, returnedIdRaw] of idPairs) {
    const proofId = nonempty(proofIdRaw);
    const returnedId = nonempty(returnedIdRaw);
    if (!proofId || !returnedId || proofId !== returnedId) {
      return fail(`Base44 ${name} record ID is missing or inconsistent with destination proof`);
    }
  }

  const requireRaw = requestRequiresRaw(request);
  const extractionAction = nonempty(asRecord(body.extraction)?.action);
  if (requireRaw && extractionAction !== "done") {
    return fail("Base44 did not complete extraction for usable source content");
  }
  if (!requireRaw && extractionAction !== "skipped") {
    return fail("Base44 extraction action is inconsistent with the request/source content");
  }
  if (requireRaw) {
    const proofRawId = nonempty(proofIds.zoning_ordinance);
    const returnedRawId = nonempty(returnedIds.zoning_ordinance_id);
    if (proofRecord.raw_verified !== true || !proofRawId || !returnedRawId || proofRawId !== returnedRawId) {
      return fail("destination proof did not verify the raw ZoningOrdinance archive");
    }
  }

  return { ok: true, proof: proof as Base44DestinationProof, body };
}

export async function sendToBase44(payload: unknown): Promise<Base44IngestResult> {
  const endpoint = requiredEnv("BASE44_ZONING_INGEST");
  const secret = optionalEnv("BASE44_WEBHOOK_SECRET", "BASE44_API_KEY");
  if (!secret) throw new Error("Missing BASE44_WEBHOOK_SECRET (or BASE44_API_KEY)");
  try {
    const response = await axios.post(endpoint, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": secret,
        Authorization: `Bearer ${secret}`,
      },
      timeout: 180000,
      validateStatus: () => true,
    });
    const httpOk = response.status >= 200 && response.status < 300;
    if (!httpOk) {
      return {
        ok: false,
        status: response.status,
        error: typeof response.data === "string"
          ? response.data.slice(0, 500)
          : JSON.stringify(response.data).slice(0, 500),
      };
    }

    const body = asRecord(response.data);
    const verified = verifyBase44IngestResponse(response.data, payload);
    if (!verified.ok) {
      return {
        ok: false,
        status: response.status,
        summary: response.data,
        destination_verified: verified.proof,
        canonical_key: typeof body?.canonical_key === "string" ? body.canonical_key : undefined,
        canonical_version: typeof body?.canonical_version === "string" ? body.canonical_version : undefined,
        base44_record_ids: asRecord(body?.base44_record_ids) || undefined,
        error: `Base44 returned HTTP ${response.status} but did not prove the canonical write: ${verified.error}`,
      };
    }

    return {
      ok: true,
      status: response.status,
      summary: response.data,
      destination_verified: verified.proof,
      canonical_key: verified.body.canonical_key,
      canonical_version: verified.body.canonical_version,
      base44_record_ids: asRecord(verified.body.base44_record_ids) || undefined,
    };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- orchestration ----------
export async function listZoningSources(opts: RunOptions = {}): Promise<{ total_jurisdictions: number; total_urls: number; selected: JurisdictionGroup[] }> {
  const sources = await getZoningSources();
  const groups = groupByJurisdiction(sources);
  return { total_jurisdictions: groups.length, total_urls: sources.length, selected: selectGroups(groups, { ...opts, limit: opts.limit ?? 50 }) };
}

export async function runScraper(opts: RunOptions = {}, onProgress?: (r: JurisdictionResult, done: number, total: number) => void): Promise<RunSummary> {
  const run_id = `mcp-zoning-scraper:${new Date().toISOString()}`;
  const sources = await getZoningSources();
  const groups = groupByJurisdiction(sources);
  const selected = selectGroups(groups, opts);

  const summary: RunSummary = {
    run_id,
    total_jurisdictions_in_db: groups.length,
    selected: selected.length,
    processed: 0,
    ingested_ok: 0,
    ingested_failed: 0,
    urls_scraped_ok: 0,
    urls_failed: 0,
    dry_run: Boolean(opts.dryRun),
    results: [],
  };

  for (const group of selected) {
    const started = Date.now();
    const scraped = await scrapeGroup(group);
    const polygon = opts.includePolygon === false ? null : await getJurisdictionPolygon(group.jurisdiction, group.state);

    const ingest: Base44IngestResult = opts.dryRun
      ? { ok: false, skipped: true, status: 0, summary: "dry run — not sent" }
      : await sendToBase44({
          run_id,
          jurisdiction: group.jurisdiction,
          state: group.state,
          polygon,
          skip_extraction: Boolean(opts.skipExtraction),
          sources: scraped.map((s) => ({
            url: s.url,
            authority_level: s.authority_level,
            text: s.text,
            ok: s.ok,
            method: s.method,
            error: s.error,
          })),
        });

    const result: JurisdictionResult = {
      jurisdiction: group.jurisdiction,
      state: group.state,
      sources: scraped.map(({ url, authority_level, ok, method, chars, error }) => ({ url, authority_level, ok, method, chars, error })),
      polygon_found: Boolean(polygon),
      ingest,
      seconds: Math.round((Date.now() - started) / 1000),
    };

    summary.processed += 1;
    summary.urls_scraped_ok += scraped.filter((s) => s.ok).length;
    summary.urls_failed += scraped.filter((s) => !s.ok).length;
    if (!ingest.skipped) {
      if (ingest.ok) summary.ingested_ok += 1;
      else summary.ingested_failed += 1;
    }
    summary.results.push(result);
    onProgress?.(result, summary.processed, selected.length);
  }

  return summary;
}
