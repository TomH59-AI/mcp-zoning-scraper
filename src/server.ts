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
  runScraper,
  type JurisdictionResult,
  type RunOptions,
  type RunSummary
} from "../tools/runScraper.js";
import { loadQueue, saveQueue, resetQueue, planNextBatch } from "../tools/queue.js";
import {
  enrichZoningData,
  listEnrichmentQueue,
  runEnrichmentQueue
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
  last?: { jurisdiction: string; state: string; ok: boolean; seconds: number };
  recent: JurisdictionResult[];
  summary?: RunSummary;
  error?: string;
  queue?: { state: string; offset: number; stateIndex: number };
}
const jobs = new Map<string, Job>();
let activeJob: Job | null = null;

function startJob(options: RunOptions, queue?: { state: string; offset: number; stateIndex: number }): Job {
  const job: Job = {
    id: randomUUID().slice(0, 8),
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

  void runScraper(options, (result, done, total) => {
    job.done = done;
    job.total = total;
    job.last = { jurisdiction: result.jurisdiction, state: result.state, ok: result.ingest.ok, seconds: result.seconds };
    job.recent.unshift(result);
    if (job.recent.length > 10) job.recent.pop();
    console.log(`[job ${job.id}] ${done}/${total} ${result.jurisdiction}, ${result.state} → ingest ${result.ingest.ok ? "ok" : `FAILED ${result.ingest.status} ${result.ingest.error ?? ""}`}`);
  })
    .then((summary) => {
      job.status = "done";
      job.summary = { ...summary, results: summary.results.slice(-25) };
      job.finished_at = new Date().toISOString();
      // Only a batch that actually ran moves the cursor — a failed job must be
      // retried at the same offset, not skipped past.
      advanceQueueAfter(job, summary);
    })
    .catch((err: unknown) => {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.finished_at = new Date().toISOString();
    })
    .finally(() => {
      if (activeJob?.id === job.id) activeJob = null;
    });

  return job;
}

// Advance the shared cursor when a queue-driven batch finishes, so the next
// scheduled firing picks up where this one stopped rather than repeating it.
function advanceQueueAfter(job: Job, summary: RunSummary): void {
  if (!job.queue) return;
  const q = loadQueue();
  q.offset = job.queue.offset + (summary.processed || 0);
  q.stateIndex = job.queue.stateIndex;
  q.batches_run += 1;
  q.jurisdictions_done += summary.processed || 0;
  q.ingested_ok += summary.ingested_ok || 0;
  q.ingested_failed += summary.ingested_failed || 0;
  q.last_batch = {
    job_id: job.id,
    state: job.queue.state,
    offset: job.queue.offset,
    processed: summary.processed,
    ingested_ok: summary.ingested_ok,
    ingested_failed: summary.ingested_failed,
    finished_at: new Date().toISOString()
  };
  saveQueue(q);
  console.log(`[queue] ${job.queue.state} offset ${job.queue.offset} -> ${q.offset} (batch ${q.batches_run}, ${q.jurisdictions_done} jurisdictions done)`);
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
      ingest_error: r.ingest.error,
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

function createServer(): McpServer {
  const server = new McpServer({ name: "mcp-zoning-scraper", version: "2.2.0" });

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
    "Enrichment-Zoning-Data-Tool",
    {
      description:
        "Scrape one jurisdiction's official zoning, tower, planning, building, fee, and GIS URLs with Scrapfly first and Oxylabs as fallback. Extract the complete SiteHawk five-section zoning/permitting profile, upsert the canonical Base44 registry used by coordinate search, and create or refresh the enriched page under Zoning-Enrichment-Folder's correct state page.",
      inputSchema: {
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
      }
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
        "Process Pending URL rows from the Ordinances Inbox database, grouping multiple URLs for the same jurisdiction. Each result is written to Base44 and to the correct state page in Zoning-Enrichment-Folder, then the queue row is updated with status, provenance, field count, and destination link.",
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
        states: z.array(z.string()).min(1).describe("States in the order to sweep, e.g. ['FL','NC','GA']")
      }
    },
    async ({ states }) => {
      try {
        const q = resetQueue(states);
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
        dryRun: z.boolean().optional().describe("Scrape without writing to Base44")
      }
    },
    async ({ batch, dryRun }) => {
      try {
        if (activeJob) {
          return text({
            ok: true,
            skipped: "job_in_flight",
            message: `Batch ${activeJob.id} is still running (${activeJob.done}/${activeJob.total}) — nothing started.`,
            job_id: activeJob.id
          });
        }
        const size = batch ?? 3;
        const q = loadQueue();
        if (!q.states.length) {
          return text({ ok: false, error: "No sweep configured — call startZoningSweep with the states first." });
        }
        const { plan, state: advanced } = await planNextBatch(q, size);
        if (plan.done) {
          if (!advanced.finished_at) {
            advanced.finished_at = new Date().toISOString();
            saveQueue(advanced);
          }
          return text({ ok: true, done: true, queue: advanced, message: "Sweep complete — every state has been scraped." });
        }
        // planNextBatch may have stepped over an exhausted state; persist that
        // before the job starts so a crash cannot rewind it.
        saveQueue(advanced);
        const job = startJob(
          { state: plan.state, limit: plan.size, offset: plan.offset, dryRun },
          { state: plan.state!, offset: plan.offset!, stateIndex: advanced.stateIndex }
        );
        return text({ ok: true, started: true, batch: plan, ...jobView(job) });
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
    response.status(200).json({ ok: true, service: "mcp-zoning-scraper", version: "2.2.0", active_job: activeJob ? jobView(activeJob) : null });
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
