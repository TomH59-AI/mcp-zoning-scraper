// runScraper — reads the Notion database "The United States Zoning URL"
// (Jurisdiction | Authority Level | URL | State), scrapes every URL for a
// jurisdiction, and POSTs the cleaned page text to the SiteHawk Base44 intake
// function `zoningScraperIngest`, which LLM-extracts the four SCIP sections
// (Zoning Overview, Tower Specifics, Site Plan Overview, Building Permit
// Information) and upserts Jurisdiction / TelecomOrdinance / JurisdictionRegistry
// / JurisdictionResource.
//
// Env (Railway → Variables):
//   NOTION_KEY             Notion integration token (the DB must be shared with it)
//   NOTION_ZONING_DB       database id, e.g. 356274bf71c180af8163d29dfbd263df
//   BASE44_ZONING_INGEST   https://site-hawk-pro.base44.app/functions/zoningScraperIngest
//   BASE44_WEBHOOK_SECRET  the app's WEBHOOK_SECRET  (falls back to BASE44_API_KEY)
//   SCRAPFLY_API_KEY / SCRAPFLY_KEY, OXYLABS_USERNAME, OXYLABS_PASSWORD / OXYLABS_KEY
import axios from "axios";

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

export interface JurisdictionResult {
  jurisdiction: string;
  state: string;
  sources: Array<Pick<ScrapedSource, "url" | "authority_level" | "ok" | "method" | "chars" | "error">>;
  polygon_found: boolean;
  ingest: { ok: boolean; status: number; summary?: unknown; error?: string };
  seconds: number;
}

export interface RunOptions {
  state?: string;
  jurisdiction?: string;
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

async function scrapeWithOxyLabs(url: string): Promise<string> {
  const username = optionalEnv("OXYLABS_USERNAME");
  const password = optionalEnv("OXYLABS_PASSWORD", "OXYLABS_KEY");
  if (!username || !password) throw new Error("OxyLabs credentials not configured");
  const response = await axios.post<{ results?: Array<{ content?: string }> }>(
    "https://realtime.oxylabs.io/v1/queries",
    { source: "universal", url, render: "html", geo_location: "United States", user_agent_type: "desktop" },
    { auth: { username, password }, timeout: 90000 }
  );
  const content = response.data.results?.[0]?.content;
  if (!content) throw new Error("Oxylabs returned no content");
  return content;
}

async function scrapeWithScrapfly(url: string): Promise<string> {
  const key = optionalEnv("SCRAPFLY_API_KEY", "SCRAPFLY_KEY");
  if (!key) throw new Error("Scrapfly key not configured");
  const response = await axios.get<{ result?: { content?: string } }>("https://api.scrapfly.io/scrape", {
    params: { key, url, render_js: true, asp: true, country: "us" },
    timeout: 90000,
  });
  const content = response.data.result?.content;
  if (!content) throw new Error("Scrapfly returned no content");
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

function isJsHeavyCodeSite(url: string): boolean {
  return /municode|amlegal|generalcode|ecode360|codelibrary/i.test(url);
}

function looksLikePlaceholder(text: string): boolean {
  return text.length < 400 || /loading\s*(please\s*)?wait|enable javascript|access denied|just a moment/i.test(text.slice(0, 600));
}

export async function scrapeUrl(url: string): Promise<{ text: string; method: string }> {
  const attempts: Array<[string, () => Promise<string>]> = isJsHeavyCodeSite(url)
    ? [["scrapfly", () => scrapeWithScrapfly(url)], ["oxylabs", () => scrapeWithOxyLabs(url)]]
    : [["scrapfly", () => scrapeWithScrapfly(url)], ["direct", () => scrapeDirect(url)], ["oxylabs", () => scrapeWithOxyLabs(url)]];

  const errors: string[] = [];
  for (const [method, fn] of attempts) {
    try {
      const html = await fn();
      const text = cleanHtml(html);
      if (looksLikePlaceholder(text)) {
        errors.push(`${method}: thin/placeholder page (${text.length} chars)`);
        continue;
      }
      return { text: text.slice(0, MAX_TEXT_CHARS), method };
    } catch (err) {
      errors.push(`${method}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(errors.join(" | "));
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
export async function sendToBase44(payload: unknown): Promise<{ ok: boolean; status: number; summary?: unknown; error?: string }> {
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
    const ok = response.status >= 200 && response.status < 300;
    return ok
      ? { ok, status: response.status, summary: response.data }
      : { ok, status: response.status, error: typeof response.data === "string" ? response.data.slice(0, 500) : JSON.stringify(response.data).slice(0, 500) };
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

    const ingest = opts.dryRun
      ? { ok: true, status: 0, summary: "dry run — not sent" }
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
    if (ingest.ok) summary.ingested_ok += 1; else summary.ingested_failed += 1;
    summary.results.push(result);
    onProgress?.(result, summary.processed, selected.length);
  }

  return summary;
}

