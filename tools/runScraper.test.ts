import test from "node:test";
import assert from "node:assert/strict";
import {
  selectGroups,
  looksLikePlaceholder,
  scrapeMunicodeSection,
  verifyBase44IngestResponse,
  type JurisdictionGroup,
} from "./runScraper.js";

test('rejects the long Municode error shell from the Accomack live test', () => {
  const shell = 'Municode Library. Initializing application... The requested content cannot be found or you are not authorized to view it. ' + 'Download publication PDF. '.repeat(25);
  assert.equal(looksLikePlaceholder(shell), true);
  assert.equal(looksLikePlaceholder('Tower facilities shall satisfy the minimum zoning district setback requirements. '.repeat(10)), false);
});

test('Municode adapter resolves exact client, edition and section and retains full content', async () => {
  const seen: string[] = [];
  const body = 'Tower facilities shall satisfy district setbacks. '.repeat(1500);
  const fetcher = async (url: string) => {
    seen.push(url);
    if (url.includes('/Organizations/')) return { ClientID: 5211, State: { StateAbbreviation: 'VA' } };
    if (url.includes('/ClientContent/')) return { codes: [{ productName: 'Code of Ordinances', productId: 13191 }] };
    if (url.includes('/Jobs/latest/')) return { Id: 492787, ProductId: 13191 };
    return { Docs: [{ Id: 'tower-node', Title: 'Tower standards', Content: `<p>${body}</p>` }] };
  };
  const text = await scrapeMunicodeSection('https://library.municode.com/va/accomack_county/codes/code_of_ordinances?nodeId=tower-node', fetcher);
  assert.ok(text.includes(body.trim()));
  assert.ok(text.length > 60000);
  assert.ok(seen.at(-1)?.includes('jobId=492787&nodeId=tower-node&groupChunks=false'));
});

test('Municode adapter rejects content from a different state', async () => {
  await assert.rejects(scrapeMunicodeSection('https://library.municode.com/va/accomack_county/codes/code_of_ordinances?nodeId=tower-node', async () => ({ ClientID: 5211, State: { StateAbbreviation: 'FL' } })), /identity mismatch/);
});

const request = {
  jurisdiction: "Brevard County",
  state: "FL",
  sources: [{ ok: true, text: "x".repeat(201) }],
};

function validResponse() {
  return {
    ok: true,
    jurisdiction: "Brevard County",
    state: "FL",
    canonical_key: "US|FL|county|BREVARD",
    canonical_version: "2026-08-26.1",
    base44_record_ids: {
      jurisdiction_registry_id: "registry-1",
      jurisdiction_id: "jurisdiction-1",
      telecom_ordinance_id: "telecom-1",
      zoning_ordinance_id: "raw-1",
    },
    destination_verified: {
      verified: true,
      projections_linked: true,
      raw_verified: true,
      canonical_key: "US|FL|county|BREVARD",
      canonical_version: "2026-08-26.1",
      record_ids: {
        registry: "registry-1",
        jurisdiction: "jurisdiction-1",
        telecom_ordinance: "telecom-1",
        zoning_ordinance: "raw-1",
      },
    },
    extraction: { action: "done" },
  };
}

test("accepts a fully verified canonical write", () => {
  assert.equal(verifyBase44IngestResponse(validResponse(), request).ok, true);
});

test("rejects HTTP-style success bodies without proof", () => {
  const body = validResponse();
  delete (body as Record<string, any>).destination_verified;
  assert.equal(verifyBase44IngestResponse(body, request).ok, false);
});

test("rejects body ok=false even when proof is present", () => {
  const body = validResponse();
  body.ok = false;
  assert.equal(verifyBase44IngestResponse(body, request).ok, false);
});

test("requires literal booleans in proof", () => {
  const body = validResponse();
  (body.destination_verified as Record<string, any>).verified = "true";
  assert.equal(verifyBase44IngestResponse(body, request).ok, false);
});

test("rejects mismatched canonical keys", () => {
  const body = validResponse();
  body.destination_verified.canonical_key = "US|FL|county|OTHER";
  assert.equal(verifyBase44IngestResponse(body, request).ok, false);
});

test("rejects matching proof keys that belong to a different jurisdiction", () => {
  const body = validResponse();
  body.canonical_key = "US|FL|county|OTHER";
  body.destination_verified.canonical_key = "US|FL|county|OTHER";
  assert.equal(verifyBase44IngestResponse(body, request).ok, false);
});

test("rejects non-string canonical keys and versions instead of coercing them", () => {
  const mutations: Array<(body: ReturnType<typeof validResponse>) => void> = [
    (body) => {
      (body as Record<string, any>).canonical_key = 123;
      (body.destination_verified as Record<string, any>).canonical_key = 123;
    },
    (body) => {
      (body as Record<string, any>).canonical_key = { value: "US|FL|county|BREVARD" };
      (body.destination_verified as Record<string, any>).canonical_key = { value: "US|FL|county|BREVARD" };
    },
    (body) => {
      (body as Record<string, any>).canonical_key = true;
      (body.destination_verified as Record<string, any>).canonical_key = true;
    },
    (body) => {
      (body as Record<string, any>).canonical_version = 20260826.1;
      (body.destination_verified as Record<string, any>).canonical_version = 20260826.1;
    },
    (body) => {
      (body as Record<string, any>).canonical_version = { value: "2026-08-26.1" };
      (body.destination_verified as Record<string, any>).canonical_version = { value: "2026-08-26.1" };
    },
    (body) => {
      (body as Record<string, any>).canonical_version = false;
      (body.destination_verified as Record<string, any>).canonical_version = false;
    },
  ];

  for (const mutate of mutations) {
    const body = validResponse();
    mutate(body);
    assert.equal(verifyBase44IngestResponse(body, request).ok, false);
  }
});

test("rejects mismatched destination IDs", () => {
  const body = validResponse();
  body.base44_record_ids.telecom_ordinance_id = "wrong";
  assert.equal(verifyBase44IngestResponse(body, request).ok, false);
});

test("rejects non-string destination IDs instead of coercing them", () => {
  const mutations: Array<(body: ReturnType<typeof validResponse>) => void> = [
    (body) => {
      (body.destination_verified.record_ids as Record<string, any>).registry = 1;
      (body.base44_record_ids as Record<string, any>).jurisdiction_registry_id = 1;
    },
    (body) => {
      (body.destination_verified.record_ids as Record<string, any>).jurisdiction = true;
      (body.base44_record_ids as Record<string, any>).jurisdiction_id = true;
    },
    (body) => {
      (body.destination_verified.record_ids as Record<string, any>).telecom_ordinance = { id: "telecom-1" };
      (body.base44_record_ids as Record<string, any>).telecom_ordinance_id = { id: "telecom-1" };
    },
    (body) => {
      (body.destination_verified.record_ids as Record<string, any>).zoning_ordinance = 1;
      (body.base44_record_ids as Record<string, any>).zoning_ordinance_id = 1;
    },
  ];

  for (const mutate of mutations) {
    const body = validResponse();
    mutate(body);
    assert.equal(verifyBase44IngestResponse(body, request).ok, false);
  }
});

test("rejects non-string state and jurisdiction values in response or request", () => {
  const cases: Array<[unknown, unknown, unknown, unknown]> = [
    [123, 123, validResponse().jurisdiction, request.jurisdiction],
    [{ code: "FL" }, { code: "FL" }, validResponse().jurisdiction, request.jurisdiction],
    [true, true, validResponse().jurisdiction, request.jurisdiction],
    [validResponse().state, request.state, 123, 123],
    [validResponse().state, request.state, { name: "Brevard County" }, { name: "Brevard County" }],
    [validResponse().state, request.state, true, true],
  ];

  for (const [responseState, requestState, responseJurisdiction, requestJurisdiction] of cases) {
    const body = validResponse() as Record<string, any>;
    body.state = responseState;
    body.jurisdiction = responseJurisdiction;
    const malformedRequest = {
      ...request,
      state: requestState,
      jurisdiction: requestJurisdiction,
    };
    assert.equal(verifyBase44IngestResponse(body, malformedRequest).ok, false);
  }
});

test("requires a verified raw archive after completed extraction", () => {
  const body = validResponse();
  body.destination_verified.raw_verified = false;
  assert.equal(verifyBase44IngestResponse(body, request).ok, false);
});

test("accepts an intentional extraction skip without a raw archive", () => {
  const body = validResponse();
  const skippedRequest = { ...request, skip_extraction: true };
  body.extraction.action = "skipped";
  body.destination_verified.raw_verified = false;
  body.destination_verified.record_ids.zoning_ordinance = null as unknown as string;
  body.base44_record_ids.zoning_ordinance_id = null as unknown as string;
  assert.equal(verifyBase44IngestResponse(body, skippedRequest).ok, true);
});

test("rejects non-object bodies", () => {
  assert.equal(verifyBase44IngestResponse("ok", request).ok, false);
  assert.equal(verifyBase44IngestResponse([], request).ok, false);
});

test("an internal queue claim selects only the exact names in the claimed order", () => {
  const groups: JurisdictionGroup[] = [
    { jurisdiction: "Alpha County", state: "FL", sources: [] },
    { jurisdiction: "Beta County", state: "FL", sources: [] },
    { jurisdiction: "Gamma County", state: "FL", sources: [] },
  ];
  const selected = selectGroups(groups, {
    state: "FL",
    expectedJurisdictions: ["Gamma County", "Alpha County"],
    offset: 99,
    limit: 1,
  });
  assert.deepEqual(selected.map((group) => group.jurisdiction), ["Gamma County", "Alpha County"]);
});

test("an internal queue claim fails before scraping when an exact name disappeared", () => {
  const groups: JurisdictionGroup[] = [
    { jurisdiction: "Alpha County", state: "FL", sources: [] },
  ];
  assert.throws(
    () => selectGroups(groups, {
      state: "FL",
      expectedJurisdictions: ["Alpha County", "Missing County"],
    }),
    /no longer exists in Notion: Missing County/i,
  );
});
