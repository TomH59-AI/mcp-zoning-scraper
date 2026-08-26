import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSupabaseTelecomRow,
  canonicalNotionFooter,
  canonicalNotionTitle,
  verifySupabaseReceipt,
} from "./enrichmentZoningData.js";

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
