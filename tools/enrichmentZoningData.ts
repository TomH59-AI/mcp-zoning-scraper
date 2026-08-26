import { randomUUID } from "node:crypto";
import { scrapeUrl, sendToBase44, toStateCode } from "./runScraper.js";

const NOTION_API_VERSION = "2026-03-11";
const DEFAULT_ROOT_PAGE_ID = "fef2e8a4-6958-4bbc-bd9e-a564a26f76c9";
const DEFAULT_INBOX_DATA_SOURCE_ID = "5ecc4308-9150-42c6-8b38-d4a7e28539bf";
const NOT_FOUND = "Not found — requires direct contact";

export type EnrichmentSourceInput = {
  url: string;
  authority_level?: string | null;
};

export type EnrichmentOptions = {
  jurisdiction: string;
  state: string;
  urls: Array<string | EnrichmentSourceInput>;
  queuePageIds?: string[];
  writeToNotion?: boolean;
  replaceExisting?: boolean;
};

type NotionList<T = Record<string, unknown>> = {
  results?: T[];
  has_more?: boolean;
  next_cursor?: string | null;
};

type QueueItem = {
  page_id: string;
  jurisdiction: string;
  state: string;
  url: string;
  authority_level: string | null;
};

type EnrichedScrape = EnrichmentSourceInput & {
  text: string;
  method: string | null;
  ok: boolean;
  error?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

async function notionApi<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.notion.com/v1${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requiredEnv("NOTION_KEY")}`,
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

function plainProperty(property: unknown): string | null {
  if (!property || typeof property !== "object" || !("type" in property)) return null;
  const p = property as { type: string; [key: string]: unknown };
  if (p.type === "title" || p.type === "rich_text") {
    const parts = p[p.type] as Array<{ plain_text?: string }> | undefined;
    return parts?.map((part) => part.plain_text || "").join("").trim() || null;
  }
  if (p.type === "url") return typeof p.url === "string" ? p.url.trim() || null : null;
  if (p.type === "select") return (p.select as { name?: string } | null)?.name?.trim() || null;
  return null;
}

function notionPageUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}

function inferAuthority(url: string): string {
  const value = url.toLowerCase();
  if (/gis|map|parcel|assessor/.test(value)) return "gis";
  if (/building|inspection/.test(value)) return "building";
  if (/fee|schedule/.test(value)) return "fee_schedule";
  if (/planning|development|site.?plan/.test(value)) return "planning";
  if (/tower|telecom|wireless|antenna/.test(value)) return "tower_rules";
  return "zoning_ordinance";
}

function sourcePlatform(url: string): "municode" | "ecode360" | "american_legal" | "civicplus" | "city_county_site" | "pdf" | "other" {
  const value = url.toLowerCase();
  if (value.includes("municode")) return "municode";
  if (value.includes("ecode360") || value.includes("generalcode")) return "ecode360";
  if (value.includes("amlegal") || value.includes("codelibrary")) return "american_legal";
  if (value.includes("civicplus")) return "civicplus";
  if (/\.pdf(?:$|\?)/i.test(value)) return "pdf";
  if (/\.(gov|us)(?:\/|$)/i.test(value)) return "city_county_site";
  return "other";
}

function normalizeSources(inputs: Array<string | EnrichmentSourceInput>): EnrichmentSourceInput[] {
  const seen = new Set<string>();
  const sources: EnrichmentSourceInput[] = [];
  for (const input of inputs || []) {
    const url = (typeof input === "string" ? input : input?.url || "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      url,
      authority_level: typeof input === "string" ? inferAuthority(url) : input.authority_level || inferAuthority(url),
    });
  }
  if (!sources.length) throw new Error("At least one valid http(s) source URL is required.");
  return sources;
}

function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function unwrapRecord(value: unknown): Record<string, any> | null {
  const wrapper = asRecord(value);
  return asRecord(wrapper?.record) || wrapper;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ""),
  );
}

function yesNo(value: unknown): string | null {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return null;
}

function joinContact(name: unknown, email: unknown, phone: unknown): string | null {
  const parts = [name, email, phone].map((value) => String(value || "").trim()).filter(Boolean);
  return parts.length ? parts.join(" | ") : null;
}

function formattedDistance(value: unknown, unit: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (unit === "pct") return `${number}% of tower height`;
  if (unit === "multiple") return `${number} × tower height`;
  return `${number} ft`;
}

function canonicalRecordsToProfile(
  jurisdictionRecord: Record<string, any>,
  telecomRecord: Record<string, any> | null,
  registryRecord: Record<string, any> | null,
  resourceWrappers: unknown,
  jurisdiction: string,
  state: string,
): Record<string, unknown> {
  const resources = Array.isArray(resourceWrappers)
    ? resourceWrappers.map(unwrapRecord).filter((value): value is Record<string, any> => Boolean(value))
    : [];
  const sourceFor = (types: string[], pattern?: RegExp) => {
    const hit = resources.find((resource) =>
      types.includes(String(resource.resource_type || ""))
      || Boolean(pattern?.test(`${resource.title || ""} ${resource.url || ""}`)),
    );
    return hit?.url || null;
  };
  const tower = telecomRecord || {};
  const fallZone = [
    tower.fall_zone_ft !== null && tower.fall_zone_ft !== undefined ? `${tower.fall_zone_ft} ft` : null,
    tower.fall_zone_pct_of_height !== null && tower.fall_zone_pct_of_height !== undefined
      ? `${tower.fall_zone_pct_of_height}% of tower height`
      : null,
    jurisdictionRecord.fall_zone_requirements,
  ].filter(Boolean).join(" | ") || null;
  const setbacks = [
    tower.setback_ft !== null && tower.setback_ft !== undefined ? `${tower.setback_ft} ft` : null,
    tower.setback_rule,
  ].filter(Boolean).join(" | ") || null;

  return {
    ...compactRecord({
      county: registryRecord?.county || (/\bcounty\b/i.test(jurisdiction) ? jurisdiction : null),
      state,
      last_updated: tower.last_ingested_at || jurisdictionRecord.last_researched_at || null,
    }),
    zoning_overview: compactRecord({
      jurisdiction: jurisdictionRecord.zoning_jurisdiction || jurisdictionRecord.name || jurisdiction,
      contact_information: joinContact(
        jurisdictionRecord.zoning_contact_name,
        jurisdictionRecord.zoning_contact_email,
        jurisdictionRecord.zoning_contact_phone,
      ),
      process: jurisdictionRecord.zoning_process || tower.zoning_process,
      permit_type_required: tower.permit_type,
      fees: jurisdictionRecord.zoning_fees,
      approval_timeframe: jurisdictionRecord.zoning_approval_timeframe || tower.zoning_approval_timeframe,
    }),
    tower_specifics: compactRecord({
      ldc_section_references: jurisdictionRecord.ldc_section_reference || tower.section_ref,
      maximum_tower_height: tower.height_limit_ft !== null && tower.height_limit_ft !== undefined
        ? `${tower.height_limit_ft} ft`
        : jurisdictionRecord.max_tower_height_ft !== null && jurisdictionRecord.max_tower_height_ft !== undefined
          ? `${jurisdictionRecord.max_tower_height_ft} ft`
          : null,
      setbacks,
      stealth_required: yesNo(tower.stealth_required ?? jurisdictionRecord.stealth_required),
      required_collocations: tower.required_collocations_count ?? jurisdictionRecord.required_collocations,
      residential_separation: tower.residential_separation_ft !== null && tower.residential_separation_ft !== undefined
        ? `${tower.residential_separation_ft} ft`
        : formattedDistance(jurisdictionRecord.residential_separation, jurisdictionRecord.residential_separation_unit),
      tower_separation: tower.tower_separation_ft !== null && tower.tower_separation_ft !== undefined
        ? `${tower.tower_separation_ft} ft`
        : formattedDistance(jurisdictionRecord.tower_separation, jurisdictionRecord.tower_separation_unit),
      measured_from: tower.measured_from || jurisdictionRecord.measured_from,
      fall_zone_requirements: fallZone,
      pe_letter_fall_zone_relief: yesNo(tower.pe_fall_zone_allowed),
      special_tower_landscaping: tower.landscaping_details || yesNo(tower.landscaping_required ?? jurisdictionRecord.special_tower_landscaping),
    }),
    site_plan_overview: compactRecord({
      jurisdiction: jurisdictionRecord.site_plan_jurisdiction,
      contact_information: joinContact(
        jurisdictionRecord.site_plan_contact_name,
        jurisdictionRecord.site_plan_contact_email,
        jurisdictionRecord.site_plan_contact_phone,
      ),
      fees: jurisdictionRecord.site_plan_fees,
      timeframe_for_approval: jurisdictionRecord.site_plan_timeframe,
      existing_site_plan_to_amend: yesNo(jurisdictionRecord.existing_site_plan_to_amend),
      concurrent_to_zoning_or_bp: yesNo(jurisdictionRecord.concurrent_to_zoning_or_bp),
      submittal_deadlines: jurisdictionRecord.site_plan_submittal_deadlines,
      electronic_hard_copy_or_both: jurisdictionRecord.site_plan_submission_format,
    }),
    building_permit_information: compactRecord({
      jurisdiction: jurisdictionRecord.building_permit_jurisdiction,
      building_department_contact: joinContact(
        jurisdictionRecord.building_dept_contact_name,
        jurisdictionRecord.building_dept_contact_email,
        jurisdictionRecord.building_dept_contact_phone,
      ),
      does_gc_have_to_submit: yesNo(jurisdictionRecord.gc_must_submit),
      fees: jurisdictionRecord.building_permit_fees,
      timeframe: jurisdictionRecord.building_permit_timeframe,
      bond_required: yesNo(jurisdictionRecord.bond_required),
      e911_address_assigned: yesNo(jurisdictionRecord.e911_address_assigned),
    }),
    source_urls: compactRecord({
      zoning_ordinance: sourceFor(["wireless_telecom_ordinance", "zoning_ordinance"]),
      planning_dept: sourceFor(["planning_application", "conditional_use_or_special_use"]),
      building_dept: sourceFor(["building_department", "permit_portal"]),
      gis: sourceFor(["zoning_map"], /\bgis\b|parcel|assess|zoning.?map/i),
    }),
  };
}

function citationsFromRecords(
  jurisdictionRecord: Record<string, any> | null,
  telecomRecord: Record<string, any> | null,
): Array<Record<string, any>> {
  const seen = new Set<string>();
  const citations: Array<Record<string, any>> = [];
  for (const map of [asRecord(jurisdictionRecord?.field_citations), asRecord(telecomRecord?.field_citations)]) {
    for (const [field, rawCitation] of Object.entries(map || {})) {
      const citation = asRecord(rawCitation);
      if (!citation) continue;
      const key = [citation.source_url, citation.section_ref, citation.quote]
        .map((value) => String(value || ""))
        .join("|");
      if (!key.replace(/\|/g, "") || seen.has(key)) continue;
      seen.add(key);
      citations.push({ field, ...citation });
    }
  }
  return citations;
}

async function listChildren(blockId: string): Promise<Array<Record<string, unknown>>> {
  const children: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ page_size: "100" });
    if (cursor) params.set("start_cursor", cursor);
    const response = await notionApi<NotionList>(`/blocks/${blockId}/children?${params}`);
    children.push(...(response.results || []));
    cursor = response.has_more ? response.next_cursor || undefined : undefined;
  } while (cursor);
  return children;
}

async function resolveStatePage(state: string): Promise<{ id: string; title: string; url: string }> {
  const rootId = optionalEnv("NOTION_ENRICHMENT_ROOT_ID", DEFAULT_ROOT_PAGE_ID);
  const code = toStateCode(state);
  const children = await listChildren(rootId);
  const pages = children
    .filter((block) => block.type === "child_page" && typeof block.id === "string")
    .map((block) => ({
      id: String(block.id),
      title: String((block.child_page as { title?: string } | undefined)?.title || ""),
    }));
  const exact = pages.find((page) => page.title.toUpperCase() === `${code}-ZONING`);
  const floridaLegacy = code === "FL" ? pages.find((page) => page.title.toUpperCase() === "ENRICHMENT-ZONING") : null;
  const target = exact || floridaLegacy;
  if (!target) throw new Error(`No ${code}-Zoning state page exists under Zoning-Enrichment-Folder.`);
  return { ...target, url: notionPageUrl(target.id) };
}

function textRun(content: string, bold = false, link?: string) {
  return {
    type: "text",
    text: { content: content.slice(0, 1900), ...(link ? { link: { url: link } } : {}) },
    annotations: { bold },
  };
}

function heading(content: string) {
  return { object: "block", type: "heading_2", heading_2: { rich_text: [textRun(content)] } };
}

function field(label: string, value: unknown) {
  const display = value === null || value === undefined || String(value).trim() === "" ? NOT_FOUND : String(value).trim();
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: [textRun(`${label}: `, true), textRun(display)] },
  };
}

function formatProfileBlocks(jurisdiction: string, state: string, profile: Record<string, any>, citations: Array<Record<string, any>>, stats: Record<string, any>) {
  const z = profile.zoning_overview || {};
  const t = profile.tower_specifics || {};
  const sp = profile.site_plan_overview || {};
  const bp = profile.building_permit_information || {};
  const sourceUrls = profile.source_urls || {};
  const verified = profile.last_updated || new Date().toISOString().slice(0, 10);
  const blocks: Array<Record<string, unknown>> = [
    {
      object: "block",
      type: "callout",
      callout: {
        icon: { type: "emoji", emoji: "✅" },
        color: "green_background",
        rich_text: [textRun("SiteHawk Enriched Entry. Values are sourced from the listed documents; unavailable fields are marked for direct contact.")],
      },
    },
    {
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [textRun("Jurisdiction: ", true), textRun(`${jurisdiction}, ${state} | Verified: ${verified}`)] },
    },
    heading("1. Core Identification"),
    field("County name", profile.county),
    field("State", profile.state || state),
    field("Zoning Ordinance URL", sourceUrls.zoning_ordinance),
    field("Planning Department URL", sourceUrls.planning_dept),
    field("Building Department URL", sourceUrls.building_dept),
    field("GIS URL", sourceUrls.gis),
    heading("2. Zoning Overview"),
    field("Zoning Jurisdiction", z.jurisdiction),
    field("Zoning Contact Information", z.contact_information),
    field("Overall Process", z.process),
    field("Permit Type Required", z.permit_type_required),
    field("CUP / Special Exception Path", z.cup_special_exception_path),
    field("Public Hearing Required?", z.public_hearing_required),
    field("Appeal Process", z.appeal_process),
    field("PE Self-Certification allowed?", z.pe_self_certification),
    field("Zoning Fees", z.fees),
    field("Zoning Approval Timeframe", z.approval_timeframe),
    heading("3. Tower Specifics"),
    field("LDC / Ordinance Section Reference(s)", t.ldc_section_references),
    field("Maximum Tower Height", t.maximum_tower_height),
    field("Height Restrictions", t.height_restrictions),
    field("Setbacks", t.setbacks),
    field("Stealth Required?", t.stealth_required),
    field("Required Collocations", t.required_collocations),
    field("Residential Separation", t.residential_separation),
    field("Tower Separation", t.tower_separation),
    field("Measured From", t.measured_from),
    field("Fall Zone Requirements", t.fall_zone_requirements),
    field("PE Letter for Fall Zone / Setback Relief", t.pe_letter_fall_zone_relief),
    field("Special Tower Landscaping / Screening / Fencing", t.special_tower_landscaping),
    heading("4. Site Plan Overview"),
    field("Site Plan Jurisdiction", sp.jurisdiction),
    field("Site Plan Contact Information", sp.contact_information),
    field("Site Plan Fees", sp.fees),
    field("Timeframe for approval", sp.timeframe_for_approval),
    field("Can an existing Site Plan be amended?", sp.existing_site_plan_to_amend),
    field("Concurrent with Zoning or Building Permit?", sp.concurrent_to_zoning_or_bp),
    field("Submittal deadlines", sp.submittal_deadlines),
    field("Electronic, hard copy, or both?", sp.electronic_hard_copy_or_both),
    heading("5. Building Permit Information"),
    field("Building Permit Jurisdiction", bp.jurisdiction),
    field("Building Department Contact Info", bp.building_department_contact),
    field("Does the General Contractor have to submit?", bp.does_gc_have_to_submit),
    field("Building Permit Fees", bp.fees),
    field("Building Permit Timeframe", bp.timeframe),
    field("Permit Validity Period and extension rules", bp.permit_validity_period),
    field("Bond Required?", bp.bond_required),
    field("E911 Address assigned?", bp.e911_address_assigned),
    heading("Sources"),
  ];

  const sourceSet = new Set<string>();
  for (const value of Object.values(sourceUrls)) {
    if (/^https?:\/\//i.test(String(value || ""))) sourceSet.add(String(value));
  }
  for (const citation of citations || []) {
    if (/^https?:\/\//i.test(String(citation?.source_url || ""))) sourceSet.add(String(citation.source_url));
  }
  for (const url of sourceSet) {
    blocks.push({
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: [textRun(url, false, url)] },
    });
  }
  blocks.push({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{
        ...textRun(`Researched and verified — ${verified}. ${stats?.scip_fields_filled ?? "Unknown"} fields populated; ${stats?.fields_missing ?? "unknown"} marked Not found / requires direct contact.`),
        annotations: { italic: true },
      }],
    },
  });
  return blocks;
}

async function findPageUnderParent(title: string, parentId: string): Promise<string | null> {
  const response = await notionApi<NotionList>("/search", {
    method: "POST",
    body: JSON.stringify({ query: title, filter: { property: "object", value: "page" }, page_size: 100 }),
  });
  const exact = (response.results || []).find((item) => {
    const page = item as Record<string, any>;
    const pageTitle = Object.values(page.properties || {})
      .map((property) => plainProperty(property))
      .find(Boolean);
    return pageTitle === title && page.parent?.type === "page_id" && page.parent?.page_id === parentId;
  });
  return exact && typeof exact.id === "string" ? exact.id : null;
}

async function replacePageChildren(pageId: string, children: Array<Record<string, unknown>>): Promise<void> {
  const existing = await listChildren(pageId);
  for (const block of existing) {
    if (typeof block.id === "string") await notionApi(`/blocks/${block.id}`, { method: "DELETE" });
  }
  for (let index = 0; index < children.length; index += 100) {
    await notionApi(`/blocks/${pageId}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children: children.slice(index, index + 100) }),
    });
  }
}

async function writeEnrichedPage(jurisdiction: string, state: string, profile: Record<string, any>, citations: Array<Record<string, any>>, stats: Record<string, any>, replaceExisting: boolean) {
  const destination = await resolveStatePage(state);
  const title = `${toStateCode(state)} - ${jurisdiction} Telecom Ordinance — SiteHawk Enriched`;
  const children = formatProfileBlocks(jurisdiction, toStateCode(state), profile, citations, stats);
  const existingId = await findPageUnderParent(title, destination.id);
  if (existingId) {
    if (!replaceExisting) {
      return { page_id: existingId, page_url: notionPageUrl(existingId), state_page_url: destination.url, action: "skipped_existing" };
    }
    await notionApi(`/pages/${existingId}`, {
      method: "PATCH",
      body: JSON.stringify({ icon: { type: "emoji", emoji: "📡" } }),
    });
    await replacePageChildren(existingId, children);
    return { page_id: existingId, page_url: notionPageUrl(existingId), state_page_url: destination.url, action: "updated" };
  }
  const created = await notionApi<Record<string, any>>("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "page_id", page_id: destination.id },
      icon: { type: "emoji", emoji: "📡" },
      properties: { title: { type: "title", title: [{ type: "text", text: { content: title } }] } },
      children,
    }),
  });
  return { page_id: created.id, page_url: created.url || notionPageUrl(created.id), state_page_url: destination.url, action: "created" };
}

function richTextProperty(value: string) {
  return { type: "rich_text", rich_text: [{ type: "text", text: { content: value.slice(0, 1900) } }] };
}

async function updateQueuePage(pageId: string, properties: Record<string, unknown>): Promise<void> {
  await notionApi(`/pages/${pageId}`, { method: "PATCH", body: JSON.stringify({ properties }) });
}

async function updateQueuePages(pageIds: string[], properties: Record<string, unknown>): Promise<void> {
  for (const pageId of pageIds) await updateQueuePage(pageId, properties);
}

function queueResultProperties(result: Record<string, any>, methods: string[]) {
  const profile = result.profile || {};
  const tower = profile.tower_specifics || {};
  const height = Number.parseFloat(String(tower.maximum_tower_height || "").match(/\d+(?:\.\d+)?/)?.[0] || "");
  const collocations = Number.parseFloat(String(tower.required_collocations || "").match(/\d+(?:\.\d+)?/)?.[0] || "");
  const stealthText = String(tower.stealth_required || "");
  const stealth = /^yes\b/i.test(stealthText) ? "True" : /^no\b/i.test(stealthText) ? "False" : /conditional|where|required when/i.test(stealthText) ? "Conditional" : "Not found — requires direct contact";
  const method = [...new Set(methods)].length === 1 ? methods[0] : "mixed";
  return {
    "Enrichment Status": { type: "select", select: { name: result.confidence === "high" ? "Enriched" : "Needs Review" } },
    "Enriched Page URL": { type: "url", url: result.notion?.page_url || null },
    "Destination State Page": { type: "url", url: result.notion?.state_page_url || null },
    "Last Enriched": { type: "date", date: { start: new Date().toISOString() } },
    "Last Error": richTextProperty(""),
    "Scrape Method": { type: "select", select: { name: ["scrapfly", "oxylabs", "direct"].includes(method) ? method : "mixed" } },
    "Source Confidence": { type: "select", select: { name: ["high", "medium", "low"].includes(result.confidence) ? result.confidence : "low" } },
    "Fields Populated": { type: "number", number: result.stats?.scip_fields_filled ?? null },
    "Needs Review?": { type: "checkbox", checkbox: result.confidence !== "high" },
    "Max Tower Height (ft)": { type: "number", number: Number.isFinite(height) ? height : null },
    "Tower Fall Zone / Setback": richTextProperty(String(tower.fall_zone_requirements || tower.setbacks || NOT_FOUND)),
    "Stealth Required?": { type: "select", select: { name: stealth } },
    "Required Collocations": { type: "number", number: Number.isFinite(collocations) ? collocations : null },
    "Field Provenance": richTextProperty(JSON.stringify(result.citations || []).slice(0, 1900)),
  };
}

export async function enrichZoningData(options: EnrichmentOptions) {
  const jurisdiction = String(options.jurisdiction || "").replace(/\s+/g, " ").trim();
  const state = toStateCode(String(options.state || ""));
  if (!jurisdiction || !state) throw new Error("jurisdiction and state are required.");
  const sources = normalizeSources(options.urls);
  const queuePageIds = options.queuePageIds || [];
  if (queuePageIds.length) {
    await updateQueuePages(queuePageIds, {
      "Enrichment Status": { type: "select", select: { name: "Processing" } },
      "Last Error": richTextProperty(""),
    });
  }

  try {
    const scraped: EnrichedScrape[] = [];
    for (const source of sources) {
      try {
        const result = await scrapeUrl(source.url);
        scraped.push({ ...source, ...result, ok: true });
      } catch (error) {
        scraped.push({ ...source, text: "", method: null, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!scraped.some((source) => source.ok && source.text.length > 200)) {
      throw new Error(`No usable source content. ${scraped.map((source) => `${source.url}: ${source.error || "empty"}`).join(" | ")}`);
    }

    const runId = `Enrichment-Zoning-Data-Tool:${randomUUID()}`;
    const ingest = await sendToBase44({ run_id: runId, jurisdiction, state, sources: scraped });
    if (!ingest.ok) throw new Error(`Base44 ingest failed (${ingest.status}): ${ingest.error || "unknown error"}`);
    const summary = (ingest.summary || {}) as Record<string, any>;
    const jurisdictionRecord = unwrapRecord(summary.jurisdiction_record);
    const telecomRecord = unwrapRecord(summary.telecom_ordinance);
    const registryRecord = unwrapRecord(summary.registry);
    const profile = asRecord(summary.county_profile)
      || asRecord(telecomRecord?.county_profile)
      || (jurisdictionRecord
        ? canonicalRecordsToProfile(
            jurisdictionRecord,
            telecomRecord,
            registryRecord,
            summary.resources,
            jurisdiction,
            state,
          )
        : null);
    if (!profile || typeof profile !== "object") throw new Error("Base44 completed the ingest but did not return the enriched county profile.");
    const citations = Array.isArray(summary.citations)
      ? summary.citations
      : citationsFromRecords(jurisdictionRecord, telecomRecord);
    const stats = summary.extraction || {};
    const notion = options.writeToNotion === false
      ? null
      : await writeEnrichedPage(jurisdiction, state, profile, citations, stats, options.replaceExisting !== false);
    const result = {
      ok: true,
      run_id: runId,
      jurisdiction,
      state,
      profile,
      citations,
      confidence: stats.confidence || "low",
      stats,
      notion,
      base44: { status: ingest.status, telecom_ordinance: summary.telecom_ordinance },
      sources: scraped.map((source) => ({ url: source.url, authority_level: source.authority_level, ok: source.ok, method: source.method, chars: source.text.length, error: source.error })),
    };
    if (queuePageIds.length) {
      await updateQueuePages(queuePageIds, queueResultProperties(result, scraped.map((source) => source.method).filter((method): method is string => Boolean(method))));
    }
    return result;
  } catch (error) {
    if (queuePageIds.length) {
      await updateQueuePages(queuePageIds, {
        "Enrichment Status": { type: "select", select: { name: "Failed" } },
        "Needs Review?": { type: "checkbox", checkbox: true },
        "Last Error": richTextProperty(error instanceof Error ? error.message : String(error)),
      }).catch(() => undefined);
    }
    throw error;
  }
}

function parseQueueIdentity(title: string, explicitState: string | null) {
  const cleaned = title.replace(/^RAW\s*[—-]\s*/i, "").replace(/\s*[—-]\s*\d{4}-\d{2}-\d{2}\s*$/i, "").trim();
  const match = cleaned.match(/^([A-Z]{2})\s*[—-]\s*(.+)$/i);
  const state = toStateCode(explicitState || match?.[1] || "");
  const jurisdiction = (match?.[2] || cleaned).trim();
  return { state, jurisdiction };
}

export async function listEnrichmentQueue(limit = 25): Promise<QueueItem[]> {
  const dataSourceId = optionalEnv("NOTION_ENRICHMENT_INBOX_DATA_SOURCE", DEFAULT_INBOX_DATA_SOURCE_ID);
  const response = await notionApi<NotionList>(`/data_sources/${dataSourceId}/query`, {
    method: "POST",
    body: JSON.stringify({ page_size: Math.max(1, Math.min(limit * 4, 100)) }),
  });
  const items: QueueItem[] = [];
  for (const raw of response.results || []) {
    const page = raw as Record<string, any>;
    const props = page.properties || {};
    const status = plainProperty(props["Enrichment Status"]);
    if (status && !["Pending", "Failed"].includes(status)) continue;
    const title = plainProperty(props["Jurisdiction Name"]);
    const url = plainProperty(props["Ordinance URL"]);
    if (!title || !url) continue;
    const identity = parseQueueIdentity(title, plainProperty(props.State));
    if (!identity.state || !identity.jurisdiction) continue;
    items.push({
      page_id: String(page.id),
      jurisdiction: identity.jurisdiction,
      state: identity.state,
      url,
      authority_level: plainProperty(props["Authority Level"]),
    });
    if (items.length >= limit) break;
  }
  return items;
}

export async function runEnrichmentQueue(limit = 5, replaceExisting = true) {
  const items = await listEnrichmentQueue(Math.max(1, Math.min(limit * 10, 100)));
  const grouped = new Map<string, { jurisdiction: string; state: string; urls: EnrichmentSourceInput[]; pageIds: string[] }>();
  for (const item of items) {
    const key = `${item.state}::${item.jurisdiction.toLowerCase()}`;
    const group = grouped.get(key) || { jurisdiction: item.jurisdiction, state: item.state, urls: [], pageIds: [] };
    group.urls.push({ url: item.url, authority_level: item.authority_level });
    group.pageIds.push(item.page_id);
    grouped.set(key, group);
  }
  const selected = [...grouped.values()].slice(0, Math.max(1, Math.min(limit, 25)));
  const results = [];
  for (const group of selected) {
    try {
      results.push(await enrichZoningData({
        jurisdiction: group.jurisdiction,
        state: group.state,
        urls: group.urls,
        queuePageIds: group.pageIds,
        replaceExisting,
      }));
    } catch (error) {
      results.push({ ok: false, jurisdiction: group.jurisdiction, state: group.state, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: true, queued_rows: items.length, selected_jurisdictions: selected.length, results };
}
