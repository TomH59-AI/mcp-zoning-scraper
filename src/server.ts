import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import dotenv from "dotenv";
import type { Request, Response } from "express";
import { timingSafeEqual, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  listZoningSources,
  renderZoningUrl,
  runScraper,
  type JurisdictionResult,
  type RunOptions,
  type RunSummary
} from "../tools/runScraper.js";
import {
  getBrowserRuntimeStatus,
  getOxylabsHeadlessRuntimeStatus,
  warmBrowserRenderer,
} from "../tools/browserRenderer.js";
import {
  claimQueueBatch,
  finishQueueIfCurrent,
  groupsForState,
  heartbeatQueueClaim,
  isQueueClaimStale,
  loadQueue,
  planNextBatch,
  queueStorageStatus,
  resetQueue,
  settleQueueClaim,
  type QueueClaimIdentity,
  type QueueFailureLatch,
} from "../tools/queue.js";
import {
  enrichZoningData,
  listEnrichmentQueue,
  runEnrichmentQueue,
  type EnrichmentOptions
} from "../tools/enrichmentZoningData.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// ---------- background jobs (in-memory; survive for the life of the process) ----------
interface Job {
  id: string;
  status: "running" | "done" | "failed";
  started_at: string;
  finished_at?: string;
  options: RunOptions;
  done: number;
  total: number;
  last?: {
    jurisdiction: string;
    state: string;
    ok: boolean;
    skipped?: boolean;
    status: number;
    error?: string;
    canonical_key?: string;
    canonical_version?: string;
    destination_verified?: unknown;
    seconds: number;
  };
  recent: JurisdictionResult[];
  summary?: RunSummary;
  error?: string;
  queue?: {
    state: string;
    offset: number;
    stateIndex: number;
    startedAt: string | null;
    batchSize: number;
    jurisdictions: string[];
  };
}
const jobs = new Map<string, Job>();
let activeJob: Job | null = null;

interface EnrichmentJob {
  id: string;
  status: "running" | "done" | "failed";
  started_at: string;
  finished_at?: string;
  options: EnrichmentOptions;
  result?: Awaited<ReturnType<typeof enrichZoningData>>;
  error?: string;
}

const enrichmentJobs = new Map<string, EnrichmentJob>();
let activeEnrichmentJob: EnrichmentJob | null = null;
let queuePersistenceBlocked: string | null = null;
let queueLaunchInProgress = false;
const BROAD_SWEEP_BLOCK_REASON = "Broad sweep is disabled until its runner produces verified Base44, Notion, and Supabase receipts. Use Enrichment-Zoning-Data-Tool or runEnrichmentQueue for guarded delivery.";

function broadSweepBlocked(): boolean {
  return true;
}

function queueClaimIdentity(job: Job): QueueClaimIdentity {
  if (!job.queue?.startedAt) {
    throw new Error("Queue job is missing its persisted generation identifier.");
  }
  return {
    job_id: job.id,
    generation: job.queue.startedAt,
    state: job.queue.state,
    stateIndex: job.queue.stateIndex,
    offset: job.queue.offset,
    jurisdictions: job.queue.jurisdictions,
  };
}

function startJob(options: RunOptions, queue?: Job["queue"], claimedJobId?: string): Job {
  const job: Job = {
    id: claimedJobId ?? randomUUID().slice(0, 8),
    status: "running",
    started_at: new Date().toISOString(),
    options,
    done: 0,
    total: 0,
    recent: [],
    queue
  };
  jobs.set(job.id, job);
  activeJob = job;

  const heartbeat = queue
    ? setInterval(() => {
        try {
          heartbeatQueueClaim(queueClaimIdentity(job));
        } catch (error) {
          console.error(`[queue] claim heartbeat failed for ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, 30_000)
    : null;
  heartbeat?.unref();

  void runScraper(options, (result, done, total) => {
    job.done = done;
    job.total = total;
    job.last = {
      jurisdiction: result.jurisdiction,
      state: result.state,
      ok: result.ingest.ok,
      skipped: result.ingest.skipped,
      status: result.ingest.status,
      error: result.ingest.error,
      canonical_key: result.ingest.canonical_key,
      canonical_version: result.ingest.canonical_version,
      destination_verified: result.ingest.destination_verified,
      seconds: result.seconds,
    };
    job.recent.unshift(result);
    if (job.recent.length > 10) job.recent.pop();
    const outcome = result.ingest.skipped
      ? "skipped (dry run)"
      : result.ingest.ok
        ? "verified"
        : `FAILED ${result.ingest.status} ${result.ingest.error ?? ""}`;
    console.log(`[job ${job.id}] ${done}/${total} ${result.jurisdiction}, ${result.state} → ingest ${outcome}`);
  })
    .then((summary) => {
      job.summary = { ...summary, results: summary.results.slice(-25) };
      job.finished_at = new Date().toISOString();
      if (job.queue) {
        const advanced = settleQueueAfter(job, summary);
        job.status = advanced ? "done" : "failed";
      } else {
        job.status = "done";
      }
    })
    .catch((err: unknown) => {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.finished_at = new Date().toISOString();
      if (job.queue) {
        try {
          latchQueueJobError(job, job.error);
        } catch (latchError) {
          queuePersistenceBlocked = latchError instanceof Error ? latchError.message : String(latchError);
          console.error(`[queue] safety latch persistence failed; queue blocked in memory: ${queuePersistenceBlocked}`);
        }
      }
    })
    .finally(() => {
      if (heartbeat) clearInterval(heartbeat);
      if (activeJob?.id === job.id) activeJob = null;
    });

  return job;
}

function failureDetails(summary: RunSummary) {
  return summary.results
    .filter((result) => !result.ingest.ok && !result.ingest.skipped)
    .map((result) => ({
      jurisdiction: result.jurisdiction,
      status: result.ingest.status,
      error: result.ingest.error,
      canonical_key: result.ingest.canonical_key,
    }));
}

// Settle a queue-driven batch. A single unverified Base44 write freezes the
// exact cursor and latches the failure; ordinary scheduled calls cannot retry
// it or move past it.
function settleQueueAfter(job: Job, summary: RunSummary): boolean {
  if (!job.queue) return true;
  const failures = failureDetails(summary);
  const actualJurisdictions = summary.results.map((result) => result.jurisdiction);
  const expectedJurisdictions = job.queue.jurisdictions;
  const exactBatchRan =
    summary.processed === expectedJurisdictions.length
    && actualJurisdictions.length === expectedJurisdictions.length
    && actualJurisdictions.every((name, index) => name === expectedJurisdictions[index])
    && summary.results.every((result) => !result.ingest.skipped);
  const executionError = !exactBatchRan
    ? `The scraper result did not exactly match the persisted jurisdiction claim. Expected [${expectedJurisdictions.join(", ")}], received [${actualJurisdictions.join(", ")}].`
    : undefined;
  const failed = failures.length > 0 || summary.dry_run || Boolean(executionError);
  let settledOffset = job.queue.offset;
  let batchesRun = 0;
  let jurisdictionsDone = 0;

  settleQueueClaim(queueClaimIdentity(job), (q) => {
    q.batches_run += 1;
    q.last_batch = {
      job_id: job.id,
      state: job.queue!.state,
      offset: job.queue!.offset,
      processed: summary.processed,
      ingested_ok: summary.ingested_ok,
      ingested_failed: summary.ingested_failed,
      failed,
      error: executionError,
      finished_at: new Date().toISOString(),
    };

    if (failed) {
      const latch: QueueFailureLatch = {
        kind: failures.length ? "base44_ingest" : "job_error",
        job_id: job.id,
        state: job.queue!.state,
        stateIndex: job.queue!.stateIndex,
        offset: job.queue!.offset,
        batch_size: job.queue!.batchSize,
        jurisdictions: [...job.queue!.jurisdictions],
        failed_at: new Date().toISOString(),
        failures,
        error: executionError ?? (summary.dry_run ? "A queue batch ran in dry-run mode; cursor was not advanced." : undefined),
      };
      q.ingested_failed += failures.length;
      q.failure_latch = latch;
      job.error = failures.length
        ? `${failures.length} Base44 ingestion(s) failed strict destination verification; queue is latched at the same cursor.`
        : latch.error;
      return;
    }

    q.offset = job.queue!.offset + expectedJurisdictions.length;
    q.stateIndex = job.queue!.stateIndex;
    q.jurisdictions_done += expectedJurisdictions.length;
    q.ingested_ok += summary.ingested_ok;
    q.failure_latch = null;
    settledOffset = q.offset;
    batchesRun = q.batches_run;
    jurisdictionsDone = q.jurisdictions_done;
  });

  if (failed) {
    console.error(`[queue] latched ${job.queue.state} offset ${job.queue.offset}: ${job.error}`);
    return false;
  }
  console.log(`[queue] ${job.queue.state} offset ${job.queue.offset} -> ${settledOffset} (batch ${batchesRun}, ${jurisdictionsDone} jurisdictions done)`);
  return true;
}

function latchQueueJobError(job: Job, error: string): void {
  if (!job.queue) return;
  settleQueueClaim(queueClaimIdentity(job), (q) => {
    q.batches_run += 1;
    q.failure_latch = {
      kind: "job_error",
      job_id: job.id,
      state: job.queue!.state,
      stateIndex: job.queue!.stateIndex,
      offset: job.queue!.offset,
      batch_size: job.queue!.batchSize,
      jurisdictions: [...job.queue!.jurisdictions],
      failed_at: new Date().toISOString(),
      failures: [],
      error,
    };
    q.last_batch = {
      job_id: job.id,
      state: job.queue!.state,
      offset: job.queue!.offset,
      processed: job.done,
      failed: true,
      error,
      finished_at: new Date().toISOString(),
    };
  });
}

function jobView(job: Job) {
  return {
    job_id: job.id,
    status: job.status,
    started_at: job.started_at,
    finished_at: job.finished_at,
    options: job.options,
    progress: `${job.done}/${job.total}`,
    last: job.last,
    recent: job.recent.map((r) => ({
      jurisdiction: r.jurisdiction,
      state: r.state,
      urls_ok: r.sources.filter((s) => s.ok).length,
      urls_failed: r.sources.filter((s) => !s.ok).length,
      ingest_ok: r.ingest.ok,
      ingest_skipped: r.ingest.skipped === true,
      ingest_status: r.ingest.status,
      ingest_error: r.ingest.error,
      canonical_key: r.ingest.canonical_key,
      canonical_version: r.ingest.canonical_version,
      base44_record_ids: r.ingest.base44_record_ids,
      destination_verified: r.ingest.destination_verified,
      seconds: r.seconds
    })),
    summary: job.summary
      ? {
          run_id: job.summary.run_id,
          total_jurisdictions_in_db: job.summary.total_jurisdictions_in_db,
          selected: job.summary.selected,
          processed: job.summary.processed,
          ingested_ok: job.summary.ingested_ok,
          ingested_failed: job.summary.ingested_failed,
          urls_scraped_ok: job.summary.urls_scraped_ok,
          urls_failed: job.summary.urls_failed,
          dry_run: job.summary.dry_run
        }
      : undefined,
    error: job.error
  };
}

function enrichmentJobKey(options: Pick<EnrichmentOptions, "jurisdiction" | "state">): string {
  return `${options.state.trim().toUpperCase()}::${options.jurisdiction.trim().toLowerCase()}`;
}

function enrichmentJobView(job: EnrichmentJob) {
  const result = job.result;
  return {
    job_id: job.id,
    status: job.status,
    started_at: job.started_at,
    finished_at: job.finished_at,
    options: {
      jurisdiction: job.options.jurisdiction,
      state: job.options.state,
      urls: job.options.urls,
      writeToNotion: job.options.writeToNotion,
      replaceExisting: job.options.replaceExisting,
    },
    result: result
      ? {
          ok: result.ok,
          run_id: result.run_id,
          jurisdiction: result.jurisdiction,
          state: result.state,
          confidence: result.confidence,
          stats: result.stats,
          notion: result.notion,
          supabase: result.supabase,
          destination_proof: result.destination_proof,
          base44: result.base44,
          sources: result.sources,
        }
      : undefined,
    error: job.error,
  };
}

function startEnrichmentJob(options: EnrichmentOptions): { job: EnrichmentJob; existing: boolean } {
  if (activeEnrichmentJob) {
    if (enrichmentJobKey(activeEnrichmentJob.options) === enrichmentJobKey(options)) {
      return { job: activeEnrichmentJob, existing: true };
    }
    throw new Error(
      `Jurisdiction enrichment job ${activeEnrichmentJob.id} is already running for ${activeEnrichmentJob.options.jurisdiction}, ${activeEnrichmentJob.options.state}.`,
    );
  }

  const job: EnrichmentJob = {
    id: randomUUID().slice(0, 8),
    status: "running",
    started_at: new Date().toISOString(),
    options,
  };
  enrichmentJobs.set(job.id, job);
  activeEnrichmentJob = job;

  void enrichZoningData(options)
    .then((result) => {
      job.result = result;
      job.status = result.destination_proof?.verified === true ? "done" : "failed";
      if (job.status === "failed") {
        job.error = "Enrichment finished without verified Base44, Notion, and Supabase receipts.";
      }
      job.finished_at = new Date().toISOString();
    })
    .catch((error: unknown) => {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.finished_at = new Date().toISOString();
    })
    .finally(() => {
      if (activeEnrichmentJob?.id === job.id) activeEnrichmentJob = null;
    });

  return { job, existing: false };
}

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }], isError: true };
}

const selectionShape = {
  state: z.string().optional().describe("Filter to one state, e.g. 'MI' or 'Michigan'"),
  jurisdiction: z.string().optional().describe("Substring match on jurisdiction name, e.g. 'Calhoun'"),
  limit: z.number().int().min(1).max(500).optional().describe("Max jurisdictions to process (default 25)"),
  offset: z.number().int().min(0).optional().describe("Skip the first N matching jurisdictions (for batching)")
};

const enrichmentShape = {
  jurisdiction: z.string().min(1).describe("County, city, township, village, or other zoning jurisdiction name"),
  state: z.string().min(2).describe("Two-letter state code or full state name"),
  urls: z.array(z.union([
    z.string().url(),
    z.object({
      url: z.string().url(),
      authority_level: z.string().optional().describe("zoning_ordinance, tower_rules, planning, building, fee_schedule, gis, or other")
    })
  ])).min(1).max(20),
  writeToNotion: z.boolean().optional().describe("Write the formatted enriched page to Notion (default true)"),
  replaceExisting: z.boolean().optional().describe("Refresh an existing exact-match enriched page instead of making a duplicate (default true)")
};

function createServer(): McpServer {
  const server = new McpServer({ name: "mcp-zoning-scraper", version: "2.8.0" });

  server.registerTool(
    "listZoningSources",
    {
      description:
        "Preview what would be scraped: reads the Notion database 'The United States Zoning URL' and returns jurisdictions (grouped) with their Authority Level + URL rows. Use before runScraper to pick a state/batch.",
      inputSchema: selectionShape
    },
    async (args) => {
      try {
        return text(await listZoningSources(args));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "renderZoningUrl",
    {
      description:
        "Read one public zoning or ordinance URL and return bounded, cleaned source text without writing to Base44, Notion, Supabase, or the sweep queue. Use oxylabs_headless when a live remote browser session is required.",
      inputSchema: {
        url: z.string().url().max(2_048).describe("One public http(s) zoning or ordinance page"),
        engine: z.enum(["auto", "oxylabs_headless"]).optional().describe("Rendering engine; default auto"),
      },
    },
    async ({ url, engine }) => {
      try {
        return text({ ok: true, ...(await renderZoningUrl(url, engine ?? "auto")) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "Enrichment-Zoning-Data-Tool",
    {
      description:
        "Scrape one jurisdiction's official zoning, tower, planning, building, fee, and GIS URLs. Extract the complete five-section profile, prove the canonical Base44 records and raw archive, create or refresh the exact Hacker Stackers Notion page, and upsert a returned Supabase telecom_ordinances row. Failure of any destination proof fails the tool.",
      inputSchema: enrichmentShape
    },
    async (args) => {
      try {
        return text(await enrichZoningData(args));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "startJurisdictionEnrichment",
    {
      description:
        "Start one guarded jurisdiction enrichment job and return immediately. Repeated starts for the same active jurisdiction return the existing job. A job is done only after verified Base44, Notion, and Supabase receipts; poll getJurisdictionEnrichmentStatus.",
      inputSchema: enrichmentShape,
    },
    async (args) => {
      try {
        const { job, existing } = startEnrichmentJob({
          ...args,
          writeToNotion: args.writeToNotion !== false,
          replaceExisting: args.replaceExisting !== false,
        });
        return text({
          ok: true,
          started: !existing,
          existing,
          ...enrichmentJobView(job),
          hint: "Poll getJurisdictionEnrichmentStatus with this job_id. status=done guarantees triple-destination proof.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "getJurisdictionEnrichmentStatus",
    {
      description: "Return one guarded jurisdiction enrichment job. status=done is emitted only when Base44, Notion, and Supabase receipts are all verified.",
      inputSchema: { job_id: z.string().min(1) },
    },
    async ({ job_id }) => {
      try {
        const job = enrichmentJobs.get(job_id);
        if (!job) {
          return text({ ok: false, error: `No jurisdiction enrichment job ${job_id} (jobs are in-memory and reset on redeploy).` });
        }
        return text({ ok: true, ...enrichmentJobView(job) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "previewEnrichmentQueue",
    {
      description:
        "Preview Pending or Failed URL rows in the Ordinances Inbox database inside Zoning-Enrichment-Folder. Rows require Jurisdiction Name, State, Ordinance URL, and optionally Authority Level.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() }
    },
    async ({ limit }) => {
      try {
        const rows = await listEnrichmentQueue(limit ?? 25);
        return text({ ok: true, rows: rows.length, queue: rows });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "runEnrichmentQueue",
    {
      description:
        "Process Pending or Failed Ordinances Inbox rows in guarded batches. Each jurisdiction must return verified Base44, Notion, and Supabase receipts before its row can advance. The batch freezes immediately on the first failed destination proof and retries Failed rows first.",
      inputSchema: {
        limit: z.number().int().min(1).max(25).optional().describe("Maximum jurisdictions to process (default 5)"),
        replaceExisting: z.boolean().optional().describe("Refresh exact-match enriched pages (default true)")
      }
    },
    async ({ limit, replaceExisting }) => {
      try {
        return text(await runEnrichmentQueue(limit ?? 5, replaceExisting !== false));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "runScraper",
    {
      description:
        "Scrape every Notion URL for the selected jurisdictions and push the page text to SiteHawk (Base44) zoningScraperIngest, which fills the SCIP template (Zoning Overview, Tower Specifics, Site Plan Overview, Building Permit Information) into Jurisdiction + TelecomOrdinance and records each URL in JurisdictionResource. Runs in the background by default — poll getScraperStatus with the returned job_id. Use dryRun to scrape without writing to Base44.",
      inputSchema: {
        ...selectionShape,
        dryRun: z.boolean().optional().describe("Scrape only; do not send anything to Base44"),
        skipExtraction: z.boolean().optional().describe("Record URLs in Base44 but skip the LLM extraction step"),
        includePolygon: z.boolean().optional().describe("Look up the jurisdiction boundary on Nominatim (default true)"),
        background: z.boolean().optional().describe("Return immediately with a job_id (default true). Set false for small batches (<=3) to wait for the result.")
      }
    },
    async (args) => {
      try {
        if (args.dryRun !== true) {
          return text({ ok: false, blocked: true, error: BROAD_SWEEP_BLOCK_REASON });
        }
        const { background, ...options } = args;
        const wait = background === false;
        if (!wait) {
          if (activeJob) {
            return text({ ok: false, error: `A job is already running (job_id ${activeJob.id}, ${activeJob.done}/${activeJob.total}). Poll getScraperStatus or wait for it to finish.` });
          }
          const job = startJob(options);
          return text({ ok: true, started: true, ...jobView(job), hint: "Call getScraperStatus with this job_id to follow progress." });
        }
        const summary = await runScraper({ ...options, limit: Math.min(options.limit ?? 1, 3) });
        return text({ ok: true, ...summary });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "startZoningSweep",
    {
      description:
        "Begin (or restart) a multi-state sweep of the Notion zoning library. Sets the durable cursor; does not scrape anything by itself — call runNextBatch to do the work. Use this once, then let a scheduled task call runNextBatch repeatedly.",
      inputSchema: {
        states: z.array(z.string()).min(1).describe("States in the order to sweep, e.g. ['FL','NC','GA']"),
        forceReset: z.literal(true).optional().describe("Required to abandon a latched failed sweep and create a new queue generation."),
      }
    },
    async ({ states, forceReset }) => {
      try {
        if (broadSweepBlocked()) {
          return text({ ok: false, blocked: true, error: BROAD_SWEEP_BLOCK_REASON, requested_states: states, force_reset_requested: forceReset === true });
        }
        const storage = queueStorageStatus();
        if (storage.temporary_default) {
          return text({
            ok: false,
            blocked: true,
            error: "Attach a Railway persistent volume (RAILWAY_VOLUME_MOUNT_PATH) or set QUEUE_FILE to durable storage before creating a sweep.",
            queue_storage: storage,
          });
        }
        if (activeJob || queueLaunchInProgress) {
          return text({
            ok: false,
            error: activeJob
              ? `Cannot reset while job ${activeJob.id} is running.`
              : "Cannot reset while a queue batch is being claimed.",
          });
        }
        const current = loadQueue();
        if (current.in_flight) {
          const stale = isQueueClaimStale(current.in_flight);
          if (!stale || forceReset !== true) {
            return text({
              ok: false,
              blocked: true,
              error: stale
                ? "A stale in-flight batch owns this queue. Pass forceReset=true only if you intend to abandon it."
                : "Another Railway process still has a live in-flight batch; reset was refused.",
              in_flight: current.in_flight,
              stale,
            });
          }
        }
        if (current.failure_latch && forceReset !== true) {
          return text({
            ok: false,
            blocked: true,
            error: "The current sweep has a failure latch. Pass forceReset=true only if you intend to abandon that failed cursor.",
            failure_latch: current.failure_latch,
          });
        }
        const q = resetQueue(states, { forceReset: forceReset === true });
        queuePersistenceBlocked = null;
        const { plan } = await planNextBatch(q, 1);
        return text({ ok: true, queue: q, up_next: plan });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "runNextBatch",
    {
      description:
        "Scrape the next N jurisdictions in the sweep and push them to SiteHawk (Base44), then advance the durable cursor. Safe to call on a schedule: it returns immediately with a job_id, refuses to double-run while a job is in flight, and resumes at the right place after a redeploy. Returns done:true when every state in the sweep is finished.",
      inputSchema: {
        batch: z.number().int().min(1).max(25).optional().describe("Jurisdictions this batch (default 3)"),
        retryFailed: z.literal(true).optional().describe("Operator-only explicit retry of the currently latched batch at the unchanged cursor."),
        dryRun: z.boolean().optional().describe("Deprecated compatibility flag. true is blocked; use runScraper for a non-writing preview."),
      }
    },
    async ({ batch, retryFailed, dryRun }) => {
      try {
        if (broadSweepBlocked()) {
          return text({ ok: false, blocked: true, started: false, error: BROAD_SWEEP_BLOCK_REASON, requested_batch: batch, retry_failed_requested: retryFailed === true });
        }
        if (dryRun === true) {
          return text({
            ok: false,
            blocked: true,
            started: false,
            error: "runNextBatch dryRun compatibility request was blocked; no job started and no Base44 writes were made. Use runScraper with dryRun=true for a non-writing preview.",
          });
        }
        const storage = queueStorageStatus();
        if (storage.temporary_default) {
          return text({
            ok: false,
            blocked: true,
            error: "Attach a Railway persistent volume (RAILWAY_VOLUME_MOUNT_PATH) or set QUEUE_FILE to durable storage before running a sweep.",
            queue_storage: storage,
          });
        }
        if (queuePersistenceBlocked) {
          return text({ ok: false, blocked: true, error: `Queue persistence safety block: ${queuePersistenceBlocked}` });
        }
        if (activeJob) {
          return text({
            ok: true,
            skipped: "job_in_flight",
            message: `Batch ${activeJob.id} is still running (${activeJob.done}/${activeJob.total}) — nothing started.`,
            job_id: activeJob.id
          });
        }
        if (queueLaunchInProgress) {
          return text({
            ok: true,
            started: false,
            skipped: "claim_in_progress",
            message: "Another request in this Railway process is already claiming the next batch.",
          });
        }

        // Set this before the first await. activeJob is not populated until
        // after Notion planning, so it cannot by itself close this launch race.
        queueLaunchInProgress = true;
        try {
          const requestedSize = batch ?? 3;
          const q = loadQueue();
          if (!q.states.length) {
            return text({ ok: false, error: "No sweep configured — call startZoningSweep with the states first." });
          }
          if (!q.started_at) {
            return text({ ok: false, blocked: true, error: "The configured queue has no generation identifier; reset it before running." });
          }
          if (q.in_flight) {
            const stale = isQueueClaimStale(q.in_flight);
            return text({
              ok: true,
              started: false,
              blocked: true,
              skipped: stale ? "stale_job_in_flight" : "job_in_flight_other_process",
              message: stale
                ? "A stale persisted batch claim was found. It will not be reused or bypassed; an operator must explicitly reset the sweep."
                : "Another Railway process owns the current batch — nothing started.",
              in_flight: q.in_flight,
              stale,
            });
          }
          if (q.failure_latch && retryFailed !== true) {
            return text({
              ok: true,
              started: false,
              blocked: true,
              message: "Sweep is frozen at a failed Base44 destination-verification batch. An operator must retry or reset it.",
              failure_latch: q.failure_latch,
            });
          }
          if (!q.failure_latch && retryFailed === true) {
            return text({ ok: false, error: "No failed batch is latched; retryFailed cannot be used as a general bypass." });
          }

          const originalCursor = {
            generation: q.started_at,
            stateIndex: q.stateIndex,
            offset: q.offset,
          };
          const size = q.failure_latch?.batch_size || requestedSize;
          const planned = await planNextBatch(q, size);
          let plan = planned.plan;
          let advanced = planned.state;
          let retryOfJobId: string | undefined;

          if (q.failure_latch) {
            const latch = q.failure_latch;
            if (!Array.isArray(latch.jurisdictions) || latch.jurisdictions.length === 0) {
              return text({
                ok: false,
                blocked: true,
                error: "The failed batch does not contain an exact persisted jurisdiction list; it cannot be retried safely and must be reset.",
                failure_latch: latch,
              });
            }
            if (q.stateIndex !== latch.stateIndex || q.offset !== latch.offset) {
              return text({
                ok: false,
                blocked: true,
                error: "The queue cursor no longer matches the failed batch; retry was refused.",
                failure_latch: latch,
              });
            }

            // The latch, not a newly calculated slice, defines a retry. We only
            // use the fresh source list to prove those exact names still occupy
            // the claimed cursor before allowing runScraper's offset selector.
            const currentNames = groupsForState(planned.all, latch.state)
              .slice(latch.offset, latch.offset + latch.jurisdictions.length)
              .map((group) => group.jurisdiction);
            const exactNamesStillAtCursor =
              currentNames.length === latch.jurisdictions.length
              && currentNames.every((name, index) => name === latch.jurisdictions[index]);
            if (!exactNamesStillAtCursor) {
              return text({
                ok: false,
                blocked: true,
                error: "The Notion jurisdiction order changed after this batch failed. The exact latched names will not be replaced with a fresh offset slice.",
                expected_jurisdictions: latch.jurisdictions,
                current_jurisdictions_at_cursor: currentNames,
              });
            }
            plan = {
              ...plan,
              done: false,
              state: latch.state,
              offset: latch.offset,
              size: latch.jurisdictions.length,
              jurisdictions: [...latch.jurisdictions],
            };
            advanced = { ...q, stateIndex: latch.stateIndex, offset: latch.offset };
            retryOfJobId = latch.job_id;
          }

          if (plan.done) {
            const finished = finishQueueIfCurrent(originalCursor, advanced);
            return text({ ok: true, done: true, queue: finished, message: "Sweep complete — every state has been scraped." });
          }

          const jurisdictions = plan.jurisdictions ?? [];
          if (!plan.state || plan.offset === undefined || jurisdictions.length === 0) {
            return text({ ok: false, blocked: true, error: "The next batch plan was incomplete; nothing was claimed." });
          }
          const jobId = randomUUID().slice(0, 8);
          claimQueueBatch({
            ...originalCursor,
            job_id: jobId,
            state: plan.state,
            claimedStateIndex: advanced.stateIndex,
            claimedOffset: plan.offset,
            batch_size: jurisdictions.length,
            jurisdictions,
            retry_of_job_id: retryOfJobId,
          });
          const job = startJob(
            {
              state: plan.state,
              expectedJurisdictions: [...jurisdictions],
              limit: jurisdictions.length,
            },
            {
              state: plan.state,
              offset: plan.offset,
              stateIndex: advanced.stateIndex,
              startedAt: q.started_at,
              batchSize: jurisdictions.length,
              jurisdictions,
            },
            jobId,
          );
          return text({ ok: true, started: true, retrying_failed_batch: retryFailed === true, batch: plan, ...jobView(job) });
        } finally {
          queueLaunchInProgress = false;
        }
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "getSweepStatus",
    {
      description: "Where the multi-state sweep has got to: current state, cursor, totals ingested, and what the next batch would be.",
      inputSchema: {}
    },
    async () => {
      try {
        const q = loadQueue();
        if (!q.states.length) return text({ ok: true, configured: false, message: "No sweep configured." });
        const { plan } = await planNextBatch(q, 3);
        return text({
          ok: true,
          configured: true,
          queue: q,
          queue_storage: queueStorageStatus(),
          persistence_blocked: queuePersistenceBlocked,
          up_next: plan,
          active_job: activeJob ? { job_id: activeJob.id, progress: `${activeJob.done}/${activeJob.total}` } : null
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "getScraperStatus",
    {
      description: "Progress and results of a runScraper background job. Omit job_id for the most recent job; pass 'all' to list every job this process has run.",
      inputSchema: { job_id: z.string().optional() }
    },
    async ({ job_id }) => {
      try {
        if (job_id === "all") return text({ jobs: [...jobs.values()].map(jobView) });
        const job = job_id ? jobs.get(job_id) : [...jobs.values()].at(-1);
        if (!job) return text({ ok: false, error: job_id ? `No job ${job_id} (jobs are in-memory and reset on redeploy)` : "No jobs have run yet" });
        return text({ ok: true, ...jobView(job) });
      } catch (err) {
        return fail(err);
      }
    }
  );

  return server;
}

async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Zoning Scraper running on stdio");
}

function isAuthorized(request: Request, token: string): boolean {
  const provided = request.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

function startHttpServer(port: number, authToken: string): void {
  const railwayPublicDomain =
    process.env.RAILWAY_PUBLIC_DOMAIN?.trim() || "mcp-zoning-scraper-production.up.railway.app";
  const app = createMcpExpressApp({
    host: "0.0.0.0",
    allowedHosts: ["127.0.0.1", "localhost", railwayPublicDomain]
  });

  app.get("/health", (_request: Request, response: Response) => {
    const destinationConfiguration = {
      base44: Boolean(
        process.env.BASE44_ZONING_INGEST?.trim()
        && (process.env.BASE44_WEBHOOK_SECRET?.trim() || process.env.BASE44_API_KEY?.trim()),
      ),
      notion: Boolean(process.env.NOTION_KEY?.trim()),
      supabase: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SECRET_KEY?.trim()),
    };
    response.status(200).json({
      ok: true,
      service: "mcp-zoning-scraper",
      version: "2.8.0",
      browser_renderer: getBrowserRuntimeStatus(),
      oxylabs_headless: getOxylabsHeadlessRuntimeStatus(),
      queue_storage: queueStorageStatus(),
      queue_persistence_blocked: queuePersistenceBlocked,
      triple_destination: {
        configured: Object.values(destinationConfiguration).every(Boolean),
        destinations: destinationConfiguration,
        broad_sweep_blocked: broadSweepBlocked(),
      },
      active_job: activeJob ? jobView(activeJob) : null,
      active_enrichment_job: activeEnrichmentJob ? enrichmentJobView(activeEnrichmentJob) : null,
    });
  });

  // Same bearer token as /mcp — handy for watching a long run from a browser/curl.
  app.get("/jobs/:id", (request: Request, response: Response) => {
    if (!isAuthorized(request, authToken)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = String(request.params.id);
    const job = id === "latest" ? [...jobs.values()].at(-1) : jobs.get(id);
    if (!job) {
      response.status(404).json({ error: "No such job" });
      return;
    }
    response.status(200).json(jobView(job));
  });

  app.get("/enrichment-jobs/:id", (request: Request, response: Response) => {
    if (!isAuthorized(request, authToken)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = String(request.params.id);
    const job = id === "latest" ? [...enrichmentJobs.values()].at(-1) : enrichmentJobs.get(id);
    if (!job) {
      response.status(404).json({ error: "No such jurisdiction enrichment job" });
      return;
    }
    response.status(200).json(enrichmentJobView(job));
  });

  app.post("/mcp", async (request: Request, response: Response) => {
    if (!isAuthorized(request, authToken)) {
      response.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    response.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!response.headersSent) {
        response.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_request: Request, response: Response) => {
    response.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.listen(port, "0.0.0.0", () => {
    console.log(`MCP Zoning Scraper listening on port ${port}`);
    void warmBrowserRenderer().catch((error: unknown) => {
      console.error("Playwright browser warmup failed:", error);
    });
  });
}

async function main(): Promise<void> {
  const railwayPort = process.env.PORT;
  if (railwayPort) {
    const port = Number.parseInt(railwayPort, 10);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid PORT value: ${railwayPort}`);
    const authToken = process.env.MCP_AUTH_TOKEN?.trim();
    if (!authToken) throw new Error("Missing required environment variable: MCP_AUTH_TOKEN");
    startHttpServer(port, authToken);
    return;
  }
  await startStdioServer();
}

main().catch((error: unknown) => {
  console.error("MCP server failed to start:", error);
  process.exit(1);
});
