import axios from "axios";
import { Client, isFullPage } from "@notionhq/client";

interface ZoningSource {
  jurisdiction: string;
  state: string;
  url: string;
}

interface TelecomRules {
  max_height_ft: string | null;
  stealth_required: boolean;
  collocations_required: string | null;
  residential_separation_ft: string | null;
  tower_separation_ft: string | null;
  fall_zone: string | null;
  pe_letter_required: boolean;
  landscaping: string | null;
  permit_type: string | null;
  fees: string | null;
  approval_timeframe_days: string | null;
}

interface ScraperResult extends ZoningSource {
  polygon: unknown;
  telecom: TelecomRules;
}

interface OxyLabsResponse {
  results?: Array<{ content?: string }>;
}

interface ScrapflyResponse {
  result?: { content?: string };
}

interface GeoJsonResponse {
  features?: Array<{ geometry?: unknown }>;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readTitle(property: unknown): string | null {
  if (
    typeof property !== "object" ||
    property === null ||
    !("type" in property) ||
    property.type !== "title" ||
    !("title" in property) ||
    !Array.isArray(property.title)
  ) {
    return null;
  }

  const first = property.title[0];
  return typeof first?.plain_text === "string" ? first.plain_text.trim() : null;
}

function readRichText(property: unknown): string | null {
  if (
    typeof property !== "object" ||
    property === null ||
    !("type" in property) ||
    property.type !== "rich_text" ||
    !("rich_text" in property) ||
    !Array.isArray(property.rich_text)
  ) {
    return null;
  }

  const first = property.rich_text[0];
  return typeof first?.plain_text === "string" ? first.plain_text.trim() : null;
}

function readUrl(property: unknown): string | null {
  if (
    typeof property !== "object" ||
    property === null ||
    !("type" in property) ||
    property.type !== "url" ||
    !("url" in property)
  ) {
    return null;
  }

  return typeof property.url === "string" ? property.url.trim() : null;
}

async function getZoningUrls(): Promise<ZoningSource[]> {
  const notion = new Client({ auth: requiredEnv("NOTION_KEY") });
  const response = await notion.databases.query({
    database_id: requiredEnv("NOTION_ZONING_DB")
  });

  const sources: ZoningSource[] = [];

  for (const page of response.results) {
    if (!isFullPage(page)) continue;

    const jurisdiction = readTitle(page.properties.Jurisdiction);
    const state = readRichText(page.properties.State);
    const url = readUrl(page.properties.URL);

    if (jurisdiction && state && url) {
      sources.push({ jurisdiction, state, url });
    }
  }

  return sources;
}

async function scrape(url: string): Promise<string> {
  if (url.includes("municode") || url.includes("amlegal") || url.includes("generalcode")) {
    return scrapeWithOxyLabs(url);
  }
  return scrapeWithScrapfly(url);
}

async function scrapeWithOxyLabs(url: string): Promise<string> {
  const password = process.env.OXYLABS_PASSWORD?.trim() || requiredEnv("OXYLABS_KEY");
  const response = await axios.post<OxyLabsResponse>(
    "https://realtime.oxylabs.io/v1/queries",
    {
      source: "universal",
      url,
      render: "html"
    },
    {
      auth: {
        username: requiredEnv("OXYLABS_USERNAME"),
        password
      }
    }
  );

  const content = response.data.results?.[0]?.content;
  if (!content) throw new Error(`Oxylabs returned no content for ${url}`);
  return content;
}

async function scrapeWithScrapfly(url: string): Promise<string> {
  const key = process.env.SCRAPFLY_API_KEY?.trim() || requiredEnv("SCRAPFLY_KEY");
  const response = await axios.get<ScrapflyResponse>("https://api.scrapfly.io/scrape", {
    params: {
      key,
      url,
      render_js: true
    }
  });

  const content = response.data.result?.content;
  if (!content) throw new Error(`Scrapfly returned no content for ${url}`);
  return content;
}

function extractTelecom(html: string): TelecomRules {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  function find(pattern: RegExp): string | null {
    const match = text.match(pattern);
    return match?.[1]?.trim() || null;
  }

  return {
    max_height_ft: find(/maximum\s+tower\s+height[^0-9]+([0-9]+)/i),
    stealth_required: /stealth/i.test(text),
    collocations_required: find(/collocation[^0-9]+([0-9]+)/i),
    residential_separation_ft: find(/residential[^0-9]+([0-9]+)/i),
    tower_separation_ft: find(/separation[^0-9]+([0-9]+)/i),
    fall_zone: find(/fall\s+zone[^:]+:\s*([^\.]+)/i),
    pe_letter_required: /engineer|\bPE\b/i.test(text),
    landscaping: find(/landscaping[^:]+:\s*([^\.]+)/i),
    permit_type: find(/permit[^:]+:\s*([^\.]+)/i),
    fees: find(/fee[^:]+:\s*([^\.]+)/i),
    approval_timeframe_days: find(/timeframe[^0-9]+([0-9]+)/i)
  };
}

async function getJurisdictionPolygon(jurisdiction: string, state: string): Promise<unknown> {
  const response = await axios.get<GeoJsonResponse>(
    "https://nominatim.openstreetmap.org/search",
    {
      params: {
        city: jurisdiction,
        state,
        country: "USA",
        format: "geojson",
        polygon_geojson: 1
      },
      headers: {
        "User-Agent": "mcp-zoning-scraper/1.0"
      }
    }
  );

  const geometry = response.data.features?.[0]?.geometry;
  if (!geometry) throw new Error(`No jurisdiction polygon found for ${jurisdiction}, ${state}`);
  return geometry;
}

async function sendToBase44(payload: ScraperResult): Promise<void> {
  const apiKey = requiredEnv("BASE44_API_KEY");
  await axios.post(requiredEnv("BASE44_ZONING_INGEST"), payload, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });
}

export async function runScraper(): Promise<ScraperResult[]> {
  const urls = await getZoningUrls();
  const results: ScraperResult[] = [];

  for (const item of urls) {
    const html = await scrape(item.url);
    const telecom = extractTelecom(html);
    const polygon = await getJurisdictionPolygon(item.jurisdiction, item.state);
    const payload: ScraperResult = { ...item, polygon, telecom };

    await sendToBase44(payload);
    results.push(payload);
  }

  return results;
}
