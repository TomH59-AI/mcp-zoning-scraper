// queue — drives a multi-state sweep of the Notion zoning library one batch at a
// time, so an unattended scheduled task can keep feeding it without holding a
// session open for hours.
//
// The cursor lives on disk rather than in memory: a Railway redeploy restarts
// the process, and an in-memory cursor would silently send the sweep back to
// the first jurisdiction. Queue reads, claims, and settlements therefore fail
// closed whenever the durable file cannot be proved safe.
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { getZoningSources, groupByJurisdiction, toStateCode, type JurisdictionGroup } from "./runScraper.js";

const explicitQueueFile = process.env.QUEUE_FILE?.trim();
const railwayVolumeMountPath = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
const railwayRuntimeDetected = Boolean(
  process.env.RAILWAY_PROJECT_ID?.trim()
  || process.env.RAILWAY_ENVIRONMENT_ID?.trim()
  || process.env.RAILWAY_SERVICE_ID?.trim(),
);
const QUEUE_FILE = explicitQueueFile
  || (railwayVolumeMountPath ? path.join(railwayVolumeMountPath, "zoning-queue.json") : path.join(tmpdir(), "zoning-queue.json"));
const QUEUE_FILE_SOURCE = explicitQueueFile
  ? "QUEUE_FILE"
  : railwayVolumeMountPath
    ? "RAILWAY_VOLUME_MOUNT_PATH"
    : "temporary_default";
const QUEUE_LOCK_FILE = `${QUEUE_FILE}.lock`;
const QUEUE_LOCK_STALE_MS = 60_000;
const parsedClaimStaleMs = Number.parseInt(process.env.QUEUE_CLAIM_STALE_MS ?? "", 10);
export const QUEUE_CLAIM_STALE_MS = Number.isFinite(parsedClaimStaleMs)
  ? Math.max(60_000, parsedClaimStaleMs)
  : 10 * 60_000;

export interface QueueInFlightClaim {
  job_id: string;
  generation: string;
  state: string;
  stateIndex: number;
  offset: number;
  batch_size: number;
  jurisdictions: string[];
  claimed_at: string;
  heartbeat_at: string;
  retry_of_job_id?: string;
}

export interface QueueFailureLatch {
  kind: "base44_ingest" | "job_error";
  job_id: string;
  state: string;
  stateIndex: number;
  offset: number;
  batch_size: number;
  jurisdictions: string[];
  failed_at: string;
  failures: Array<{
    jurisdiction: string;
    status: number;
    error?: string;
    canonical_key?: string;
  }>;
  error?: string;
}

export interface QueueState {
  states: string[];
  stateIndex: number;
  offset: number;
  started_at: string | null;
  batches_run: number;
  jurisdictions_done: number;
  ingested_ok: number;
  ingested_failed: number;
  last_batch: unknown;
  failure_latch: QueueFailureLatch | null;
  in_flight: QueueInFlightClaim | null;
  finished_at: string | null;
}

const EMPTY: QueueState = {
  states: [],
  stateIndex: 0,
  offset: 0,
  started_at: null,
  batches_run: 0,
  jurisdictions_done: 0,
  ingested_ok: 0,
  ingested_failed: 0,
  last_batch: null,
  failure_latch: null,
  in_flight: null,
  finished_at: null,
};

export interface QueueCursorIdentity {
  generation: string;
  stateIndex: number;
  offset: number;
}

export interface QueueClaimInput extends QueueCursorIdentity {
  job_id: string;
  state: string;
  claimedStateIndex: number;
  claimedOffset: number;
  batch_size: number;
  jurisdictions: string[];
  retry_of_job_id?: string;
}

export interface QueueClaimIdentity {
  job_id: string;
  generation: string;
  state: string;
  stateIndex: number;
  offset: number;
  jurisdictions: string[];
}

function normalizeQueue(value: unknown): QueueState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Queue state must be a JSON object.");
  }
  const parsed = value as Partial<QueueState>;
  return {
    ...EMPTY,
    ...parsed,
    states: Array.isArray(parsed.states) ? parsed.states.map(toStateCode) : [],
    failure_latch: parsed.failure_latch ?? null,
    in_flight: parsed.in_flight ?? null,
  };
}

function loadQueueUnlocked(): QueueState {
  try {
    return normalizeQueue(JSON.parse(readFileSync(QUEUE_FILE, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { ...EMPTY };
    throw new Error(`Queue state is unreadable; refusing to reset the cursor: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveQueueUnlocked(state: QueueState): void {
  mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
  const temporary = `${QUEUE_FILE}.next`;
  writeFileSync(temporary, JSON.stringify(state, null, 2));
  renameSync(temporary, QUEUE_FILE);
}

function acquireQueueLock(): string {
  mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = `${process.pid}:${randomUUID()}`;
    try {
      const descriptor = openSync(QUEUE_LOCK_FILE, "wx");
      try {
        writeFileSync(descriptor, `${token}\n${new Date().toISOString()}\n`);
      } finally {
        closeSync(descriptor);
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(QUEUE_LOCK_FILE).mtimeMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        throw statError;
      }
      if (ageMs <= QUEUE_LOCK_STALE_MS || attempt > 0) {
        throw new Error("Queue state is being updated by another Railway process; no batch was claimed.");
      }

      // A queue mutation is synchronous and normally holds this lock for only
      // milliseconds. Move an abandoned lock out of the way atomically. The
      // durable in_flight claim remains the authority for any long-running job.
      const abandoned = `${QUEUE_LOCK_FILE}.abandoned-${randomUUID()}`;
      try {
        renameSync(QUEUE_LOCK_FILE, abandoned);
        unlinkSync(abandoned);
      } catch (moveError) {
        if ((moveError as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        throw new Error(`A stale queue lock could not be recovered safely: ${moveError instanceof Error ? moveError.message : String(moveError)}`);
      }
    }
  }
  throw new Error("Queue state lock could not be acquired.");
}

function releaseQueueLock(token: string): void {
  try {
    if (readFileSync(QUEUE_LOCK_FILE, "utf8").startsWith(`${token}\n`)) {
      unlinkSync(QUEUE_LOCK_FILE);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

function withQueueLock<T>(operation: () => T): T {
  const token = acquireQueueLock();
  try {
    return operation();
  } finally {
    releaseQueueLock(token);
  }
}

function sameJurisdictions(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function assertCursor(state: QueueState, expected: QueueCursorIdentity): void {
  if (
    state.started_at !== expected.generation
    || state.stateIndex !== expected.stateIndex
    || state.offset !== expected.offset
  ) {
    throw new Error("Queue generation or cursor changed before this operation could be committed; refusing the stale operation.");
  }
}

function assertClaim(state: QueueState, expected: QueueClaimIdentity): QueueInFlightClaim {
  const claim = state.in_flight;
  if (
    !claim
    || claim.job_id !== expected.job_id
    || claim.generation !== expected.generation
    || claim.state !== expected.state
    || claim.stateIndex !== expected.stateIndex
    || claim.offset !== expected.offset
    || !sameJurisdictions(claim.jurisdictions, expected.jurisdictions)
  ) {
    throw new Error("The persisted in-flight claim does not match this job; stale job settlement was refused.");
  }
  if (state.started_at !== expected.generation) {
    throw new Error("Queue generation changed while this job was running; stale job settlement was refused.");
  }
  if (state.stateIndex !== claim.stateIndex || state.offset !== claim.offset) {
    throw new Error("Queue cursor changed while this job was running; stale job settlement was refused.");
  }
  return claim;
}

export function loadQueue(): QueueState {
  return loadQueueUnlocked();
}

export function saveQueue(state: QueueState): void {
  withQueueLock(() => saveQueueUnlocked(state));
}

export function queueStorageStatus() {
  const resolvedQueueFile = path.resolve(QUEUE_FILE);
  const resolvedTempDirectory = path.resolve(tmpdir());
  const inOperatingSystemTemp =
    resolvedQueueFile === resolvedTempDirectory
    || resolvedQueueFile.startsWith(`${resolvedTempDirectory}${path.sep}`);
  const resolvedVolumeMount = railwayVolumeMountPath ? path.resolve(railwayVolumeMountPath) : null;
  const insideRailwayVolume = Boolean(
    resolvedVolumeMount
    && (
      resolvedQueueFile === resolvedVolumeMount
      || resolvedQueueFile.startsWith(`${resolvedVolumeMount}${path.sep}`)
    ),
  );
  // On Railway, a path outside the attached volume is container-local even if
  // it is not under /tmp. Do not let an explicit-looking /data path masquerade
  // as durable when Railway has not actually mounted a volume there.
  const durable = railwayRuntimeDetected ? insideRailwayVolume : !inOperatingSystemTemp;
  return {
    explicitly_configured: Boolean(explicitQueueFile),
    railway_runtime_detected: railwayRuntimeDetected,
    railway_volume_detected: Boolean(railwayVolumeMountPath),
    inside_railway_volume: insideRailwayVolume,
    source: QUEUE_FILE_SOURCE,
    durable,
    temporary: inOperatingSystemTemp,
    // Kept for existing callers; true means the configured destination is
    // unsafe for a durable sweep, even if QUEUE_FILE explicitly points there.
    temporary_default: !durable,
    queue_file: QUEUE_FILE,
    claim_stale_after_seconds: Math.round(QUEUE_CLAIM_STALE_MS / 1000),
  };
}

export function isQueueClaimStale(claim: QueueInFlightClaim, now = Date.now()): boolean {
  const heartbeat = Date.parse(claim.heartbeat_at || claim.claimed_at);
  return !Number.isFinite(heartbeat) || now - heartbeat > QUEUE_CLAIM_STALE_MS;
}

export function resetQueue(states: string[], options: { forceReset?: boolean } = {}): QueueState {
  return withQueueLock(() => {
    const current = loadQueueUnlocked();
    if (current.in_flight) {
      const stale = isQueueClaimStale(current.in_flight);
      if (!stale || options.forceReset !== true) {
        throw new Error(
          stale
            ? `A stale in-flight batch (${current.in_flight.job_id}) still owns the queue. An explicit force reset is required to abandon it.`
            : `Batch ${current.in_flight.job_id} still has a live queue claim; reset was refused.`,
        );
      }
    }
    if (current.failure_latch && options.forceReset !== true) {
      throw new Error("The current sweep has a failure latch. An explicit force reset is required to abandon it.");
    }
    const state: QueueState = {
      ...EMPTY,
      states: states.map(toStateCode),
      started_at: new Date().toISOString(),
    };
    saveQueueUnlocked(state);
    return state;
  });
}

/**
 * Atomically claim a planned batch. The caller may spend time reading Notion
 * before this call, so the generation and original cursor are compared again
 * under the shared-volume lock before anything is persisted.
 */
export function claimQueueBatch(input: QueueClaimInput): QueueState {
  return withQueueLock(() => {
    const state = loadQueueUnlocked();
    assertCursor(state, input);
    if (state.in_flight) {
      const stale = isQueueClaimStale(state.in_flight);
      throw new Error(
        `${stale ? "Stale" : "Active"} in-flight batch ${state.in_flight.job_id} already owns this queue; no new batch was launched.`,
      );
    }

    if (input.retry_of_job_id) {
      const latch = state.failure_latch;
      if (
        !latch
        || latch.job_id !== input.retry_of_job_id
        || latch.state !== input.state
        || latch.stateIndex !== input.claimedStateIndex
        || latch.offset !== input.claimedOffset
        || !sameJurisdictions(latch.jurisdictions, input.jurisdictions)
      ) {
        throw new Error("The failed batch changed before the retry could be claimed; refusing to retry a different jurisdiction set.");
      }
    } else if (state.failure_latch) {
      throw new Error("The queue has a failure latch; an ordinary batch cannot claim it.");
    }

    const now = new Date().toISOString();
    state.stateIndex = input.claimedStateIndex;
    state.offset = input.claimedOffset;
    state.in_flight = {
      job_id: input.job_id,
      generation: input.generation,
      state: input.state,
      stateIndex: input.claimedStateIndex,
      offset: input.claimedOffset,
      batch_size: input.batch_size,
      jurisdictions: [...input.jurisdictions],
      claimed_at: now,
      heartbeat_at: now,
      retry_of_job_id: input.retry_of_job_id,
    };
    saveQueueUnlocked(state);
    return state;
  });
}

export function heartbeatQueueClaim(expected: QueueClaimIdentity): void {
  withQueueLock(() => {
    const state = loadQueueUnlocked();
    const claim = assertClaim(state, expected);
    claim.heartbeat_at = new Date().toISOString();
    saveQueueUnlocked(state);
  });
}

/** Apply a settlement while still proving ownership of the exact persisted claim. */
export function settleQueueClaim(
  expected: QueueClaimIdentity,
  settlement: (state: QueueState) => void,
): QueueState {
  return withQueueLock(() => {
    const state = loadQueueUnlocked();
    assertClaim(state, expected);
    settlement(state);
    state.in_flight = null;
    saveQueueUnlocked(state);
    return state;
  });
}

/** Mark a planned generation complete without overwriting a concurrent claim. */
export function finishQueueIfCurrent(expected: QueueCursorIdentity, advanced: QueueState): QueueState {
  return withQueueLock(() => {
    const state = loadQueueUnlocked();
    assertCursor(state, expected);
    if (state.in_flight) {
      throw new Error(`Batch ${state.in_flight.job_id} owns the queue; completion was not recorded.`);
    }
    state.stateIndex = advanced.stateIndex;
    state.offset = advanced.offset;
    state.finished_at = state.finished_at ?? new Date().toISOString();
    saveQueueUnlocked(state);
    return state;
  });
}

/** Jurisdictions for one state, in the same stable order the cursor walks. */
export function groupsForState(all: JurisdictionGroup[], state: string): JurisdictionGroup[] {
  const st = toStateCode(state);
  return all.filter((g) => g.state === st);
}

export interface NextBatch {
  done: boolean;
  state?: string;
  offset?: number;
  size?: number;
  jurisdictions?: string[];
  state_total?: number;
  remaining_in_state?: number;
  remaining_total?: number;
}

/**
 * What the next batch WOULD be, without running it. Advances past any state
 * that is already finished. Returns done:true when every state is exhausted.
 */
export async function planNextBatch(state: QueueState, batchSize: number): Promise<{ plan: NextBatch; state: QueueState; all: JurisdictionGroup[] }> {
  const sources = await getZoningSources();
  const all = groupByJurisdiction(sources);
  const next = { ...state };

  while (next.stateIndex < next.states.length) {
    const groups = groupsForState(all, next.states[next.stateIndex]);
    if (next.offset < groups.length) {
      const slice = groups.slice(next.offset, next.offset + batchSize);
      let remainingTotal = groups.length - next.offset;
      for (let i = next.stateIndex + 1; i < next.states.length; i++) {
        remainingTotal += groupsForState(all, next.states[i]).length;
      }
      return {
        plan: {
          done: false,
          state: next.states[next.stateIndex],
          offset: next.offset,
          size: slice.length,
          jurisdictions: slice.map((g) => g.jurisdiction),
          state_total: groups.length,
          remaining_in_state: groups.length - next.offset,
          remaining_total: remainingTotal,
        },
        state: next,
        all,
      };
    }
    next.stateIndex += 1;
    next.offset = 0;
  }

  return { plan: { done: true, remaining_total: 0 }, state: next, all };
}
