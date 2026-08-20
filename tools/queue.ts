// queue — drives a multi-state sweep of the Notion zoning library one batch at a
// time, so an unattended scheduled task can keep feeding it without holding a
// session open for hours.
//
// The cursor lives on disk rather than in memory: a Railway redeploy restarts
// the process, and an in-memory cursor would silently send the sweep back to
// the first jurisdiction. Losing the file is survivable anyway — every scrape is
// an idempotent upsert, so the worst case is a refresh, never a duplicate.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getZoningSources, groupByJurisdiction, toStateCode, type JurisdictionGroup } from "./runScraper.js";

const QUEUE_FILE = process.env.QUEUE_FILE?.trim() || "/tmp/zoning-queue.json";

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
  finished_at: null,
};

export function loadQueue(): QueueState {
  try {
    return { ...EMPTY, ...JSON.parse(readFileSync(QUEUE_FILE, "utf8")) };
  } catch {
    return { ...EMPTY };
  }
}

export function saveQueue(state: QueueState): void {
  try {
    mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    writeFileSync(QUEUE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[queue] could not persist cursor: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function resetQueue(states: string[]): QueueState {
  const state: QueueState = {
    ...EMPTY,
    states: states.map(toStateCode),
    started_at: new Date().toISOString(),
  };
  saveQueue(state);
  return state;
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
