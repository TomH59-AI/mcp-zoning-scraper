import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const testRoot = path.join(tmpdir(), `sitehawk-queue-test-${randomUUID()}`);
mkdirSync(testRoot, { recursive: true });
process.env.QUEUE_FILE = path.join(testRoot, "zoning-queue.json");
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
delete process.env.RAILWAY_PROJECT_ID;
delete process.env.RAILWAY_ENVIRONMENT_ID;
delete process.env.RAILWAY_SERVICE_ID;

let queue: typeof import("./queue.js");

before(async () => {
  queue = await import("./queue.js");
});

after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

test("an exact persisted claim exclusively owns the cursor until settlement", () => {
  const initial = queue.resetQueue(["FL"]);
  assert.ok(initial.started_at);
  const generation = initial.started_at as string;
  const claim = {
    generation,
    stateIndex: 0,
    offset: 0,
    job_id: "job-a",
    state: "FL",
    claimedStateIndex: 0,
    claimedOffset: 0,
    batch_size: 2,
    jurisdictions: ["Alpha County", "Beta County"],
  };

  queue.claimQueueBatch(claim);
  assert.throws(
    () => queue.claimQueueBatch({ ...claim, job_id: "job-b" }),
    /in-flight batch job-a already owns this queue/i,
  );
  assert.throws(
    () => queue.resetQueue(["GA"], { forceReset: true }),
    /live queue claim/i,
  );

  const identity = {
    job_id: claim.job_id,
    generation,
    state: claim.state,
    stateIndex: claim.claimedStateIndex,
    offset: claim.claimedOffset,
    jurisdictions: claim.jurisdictions,
  };
  queue.heartbeatQueueClaim(identity);
  assert.throws(
    () => queue.settleQueueClaim({ ...identity, job_id: "wrong-owner" }, () => undefined),
    /does not match this job/i,
  );

  const settled = queue.settleQueueClaim(identity, (state) => {
    state.offset = 2;
    state.jurisdictions_done = 2;
    state.ingested_ok = 2;
  });
  assert.equal(settled.offset, 2);
  assert.equal(settled.in_flight, null);
  assert.equal(queue.loadQueue().jurisdictions_done, 2);
});

test("a retry claim must match the exact latched jurisdiction list", () => {
  const current = queue.loadQueue();
  assert.ok(current.started_at);
  current.failure_latch = {
    kind: "base44_ingest",
    job_id: "failed-job",
    state: "FL",
    stateIndex: 0,
    offset: 2,
    batch_size: 2,
    jurisdictions: ["Gamma County", "Delta County"],
    failed_at: new Date().toISOString(),
    failures: [{ jurisdiction: "Gamma County", status: 200, error: "missing proof" }],
  };
  queue.saveQueue(current);

  const baseRetry = {
    generation: current.started_at as string,
    stateIndex: 0,
    offset: 2,
    job_id: "retry-job",
    state: "FL",
    claimedStateIndex: 0,
    claimedOffset: 2,
    batch_size: 2,
    retry_of_job_id: "failed-job",
  };
  assert.throws(
    () => queue.claimQueueBatch({ ...baseRetry, jurisdictions: ["Different County", "Delta County"] }),
    /refusing to retry a different jurisdiction set/i,
  );

  const jurisdictions = ["Gamma County", "Delta County"];
  queue.claimQueueBatch({ ...baseRetry, jurisdictions });
  const settled = queue.settleQueueClaim(
    {
      job_id: "retry-job",
      generation: current.started_at as string,
      state: "FL",
      stateIndex: 0,
      offset: 2,
      jurisdictions,
    },
    (state) => {
      state.offset = 4;
      state.failure_latch = null;
    },
  );
  assert.equal(settled.offset, 4);
  assert.equal(settled.failure_latch, null);
  assert.equal(settled.in_flight, null);
});
