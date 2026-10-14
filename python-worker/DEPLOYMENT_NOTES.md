# SiteHawk Playwright worker and master zoning intake

Prepared October 13, 2026. Canonical Base44 app: `69dd277f9504047a559d5834`.

## Actual deployment state

Railway rejected creation of `sitehawk-playwright-worker` in the existing
`determined-wonder` project with this response:

> Your trial has expired. Please select a plan to continue using Railway.

No new Railway service, deployment, public domain, or shared secret was created.
The older `mcp-zoning-scraper` service was not modified. Its latest observed
deployment was failed; its public endpoint must not be treated as this worker.

The worker source is saved on the separate GitHub branch
`sitehawk-playwright-worker-20261013` in `TomH59-AI/mcp-zoning-scraper`, under
`python-worker/`. The original service follows `main` and was not redeployed.
Customer zoning data, the supplied ZIP, live master snapshots, and credentials
are not included in the public repository.

## Worker contract and checks

The Dockerfile uses `mcr.microsoft.com/playwright/python:v1.63.0-noble`, with
`playwright==1.63.0`. The Microsoft registry lists that image tag. The worker
binds `0.0.0.0` and Railway's `PORT` (8080 if absent). `railway.toml` selects the
Dockerfile builder and `/health` readiness endpoint.

`POST /scrape-municipality` accepts:

```json
{
  "municipality": "Alachua",
  "state": "FL",
  "target_url": "https://library.municode.com/fl/alachua/codes/code_of_ordinances"
}
```

The worker requires `x-api-key`. Configure Railway `SITEHAWK_API_KEY` with a fresh
random secret of at least 32 characters. There is no default password. The worker
does not need a Base44 service key and never writes any registry.

It shares a warm Chromium instance with isolated request contexts, concurrency
limits, a short-lived raw-text cache, and an in-flight request guard. Only public
HTTPS destinations are allowed. Main-document redirects stay on the original
host. Failed pages and empty SPA containers are refused. Returned text includes
source URL, retrieval time, SHA-256, and an explicit partial-content flag.

Validation completed:

- Six Python checks passed: authentication, required state, URL restrictions,
  private DNS refusal, shared retrieval/cache, and failure handling.
- A real local Chromium run returned `/health` HTTP 200 and retrieved 22,252
  characters from Alachua's official Municode source. The response correctly
  stated `truncated: true` and `complete_code: false`.
- This local test is not a Railway deployment or a Base44 end-to-end canary.

## Base44 integration files

The `base44/` directory contains proposed functions and shared helpers to copy
into the existing canonical app, plus an additive schema patch. They reuse its
existing promotion/evidence gate and do not replace the 19-header master model.
They have not been installed in the production app while Railway is unavailable.

The enrichment adapter uses server-only variables:

- `RAILWAY_SCRAPER_URL`: the actual new service's HTTPS Railway domain.
- `RAILWAY_SCRAPER_API_KEY`: the same secret stored as Railway `SITEHAWK_API_KEY`.
  This separate Base44 variable name avoids overwriting an existing unrelated key.
- `RAILWAY_ZONING_ENABLED`: remains unset/off until the live canary succeeds.

The first rollout is admin-only. Before subscriber activation, connect it to the
existing quota-controlled Generate Zoning action, verify a real write/readback,
and then re-read `generateZoningPermitReport`. Do not add scraping to SARF
generation, page opening, target changes, or printing.

Extraction fills only blank master cells and records exact source quotes and
section references. Existing values and the owner's acceptance policy are
preserved. New values remain pending review. A failed scrape cannot mark an
entire jurisdiction complete. A row version and a bounded lease protect against
stale concurrent writes.

The URL intake defaults to dry-run. It accepts both the original `platforms`
wrapper and the supplied package's top-level `municipalities` array. In the
package format, `ordinance_source_url` is considered before the mixed `url`
landing page. Unmatched identities and unclassified sources are held; no master
records are created from names alone. Populated URLs are preserved.

Twenty-three checks against the canonical app's real shared evidence modules
passed. A full Deno strict check also reports pre-existing type errors in
`masterPromotion.ts`, `zoningCanonical.ts`, and `zoningScipProfile.ts`; no full
production type-check success is claimed. The review tests ran outside the app
runtime. No inactive function was wired into the subscriber flow.

## Release steps after Railway is available

1. Create the separate worker service in `determined-wonder`, production.
2. Connect the reviewed branch and configure the root as `python-worker/`.
   Build with its Dockerfile, not Railpack/Nixpacks autodetection.
3. Set a new server-only secret and verify the build/start logs and `/health`.
4. Generate the service domain targeting port 8080, then set the matching
   Base44 URL and key. Do not invent a `.up.railway.app` hostname.
5. Apply the additive Base44 integration after resolving the recorded type
   diagnostics, then run one official-source extraction, conditional master
   write, master readback, and subscriber zoning refresh canary.
6. Activate subscriber access only after that proof. Runtime zoning continues
   to come exclusively from `ZoningWorkbookReference`.

The tower import and propagation release hold are separate and remain untouched.
