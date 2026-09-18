import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSupabaseTelecomRow,
  canonicalNotionFooter,
  canonicalNotionTitle,
  verifySupabaseReceipt,
  assertNoRejectedEvidence,
  formatProfileBlocks,
} from "./enrichmentZoningData.js";

test('blocks the live Accomack rejected residential-to-setback mapping before export', () => {
  const rejected = { setback_ft: 400, field_citations: { setback_ft: {
    quote: 'The tower must be set back from any off-site residential structure no less than 400 feet.',
    qc_verdict: 'rejected:semantic_mismatch', value_match: false,
  } } };
  assert.throws(() => assertNoRejectedEvidence(rejected), /requires review.*setback_ft/);
  assert.throws(() => buildSupabaseTelecomRow({ jurisdiction: 'Accomack County', state: 'VA', telecomRecord: rejected }), /requires review.*setback_ft/);
});

test('a rejection in either Base44 projection prevents destination delivery', () => {
  assert.throws(() => assertNoRejectedEvidence({ field_citations: { measured_from: { review_status: 'conflict' } } }, {}), /measured_from/);
  assert.throws(() => assertNoRejectedEvidence({}, { field_citations: { height_limit_ft: { value_match: false } } }), /height_limit_ft/);
  assert.doesNotThrow(() => assertNoRejectedEvidence({ field_citations: { residential_separation_ft: { qc_verdict: 'confirmed', value_match: true } } }));
});

test('high extraction confidence never labels a pending Notion page verified', () => {
  const blocks = formatProfileBlocks('Accomack County', 'VA', { last_updated: '2026-09-18T15:04:00Z' }, [], { confidence: 'high', verification_status: 'needs_review', review_required: true });
  const text = JSON.stringify(blocks);
  assert.match(text, /REVIEW REQUIRED/);
  assert.match(text, /Extracted: 2026-09-18/);
  assert.doesNotMatch(text, /Verified:|APPROVED PROVISIONS/);
});

test('only an explicitly reviewed record gets an approved Notion heading', () => {
  const blocks = formatProfileBlocks('Brevard County', 'FL', {}, [], { verification_status: 'verified', review_required: false });
  assert.match(JSON.stringify(blocks), /APPROVED PROVISIONS/);
});

test("uses the exact Hacker Stackers title and footer standards", () => {
  assert.equal(canonicalNotionTitle("  Brevard   County ", "Florida"), "FL - Brevard County Telecom Ordinance");
  assert.equal(canonicalNotionFooter("2026-08-26"), "Scraped and parsed by SkyWave AI — 2026-08-26");
});

test("builds the canonical Supabase upsert row from verified Base44 records", () => {
  const row = buildSupabaseTelecomRow({
    jurisdiction: "Brevard County",
    state: "FL",
    jurisdictionRecord: {
      zoning_process: "Level III conditional use",
      ldc_section_reference: "Sec. 62-2420",
      required_collocations: 2,
    },
    telecomRecord: {
      height_limit_ft: 199,
      setback_ft: 100,
      fall_zone_ft: 150,
      collocation_required: true,
      stealth_required: false,
      tower_separation_ft: 1000,
      source_url: "https://example.gov/ordinance.pdf",
    },
    profile: {},
    citations: [],
    now: "2026-08-26T20:00:00.000Z",
  });

  assert.deepEqual(row, {
    state: "FL",
    jurisdiction: "Brevard County",
    record_name: "FL - Brevard County Telecom Ordinance",
    permit_type: "Level III conditional use",
    height_limit_ft: 199,
    setback_ft: 100,
    fall_zone_ft: 150,
    collocation_required: true,
    stealth_required: false,
    tower_separation_ft: 1000,
    section_ref: "Sec. 62-2420",
    source_url: "https://example.gov/ordinance.pdf",
    scraped_at: "2026-08-26T20:00:00.000Z",
    updated_at: "2026-08-26T20:00:00.000Z",
    extracted_at: "2026-08-26T20:00:00.000Z",
  });
});

test("accepts only an exact returned Supabase jurisdiction row", () => {
  const expected = {
    state: "FL",
    jurisdiction: "Brevard County",
    record_name: "FL - Brevard County Telecom Ordinance",
  };
  const receipt = verifySupabaseReceipt([{
    id: "row-1",
    ...expected,
  }], expected);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.row_id, "row-1");

  assert.throws(
    () => verifySupabaseReceipt([{ id: "row-1", ...expected, state: "GA" }], expected),
    /state does not match/i,
  );
  assert.throws(
    () => verifySupabaseReceipt([{ id: "row-1", ...expected, record_name: "IN-Brevard County-Telecom Ord" }], expected),
    /title standard/i,
  );
  assert.throws(
    () => verifySupabaseReceipt([], expected),
    /exactly one/i,
  );
});
