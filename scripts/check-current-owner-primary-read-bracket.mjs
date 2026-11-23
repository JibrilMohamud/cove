import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";

const path = "src/storefront-strangler/current-owner-primary-read-bracket.stage.ts";
const source = readFileSync(path, "utf8");
const transformed = await transform(source, { loader: "ts", format: "esm" });
const { QA_OWNER_PRIMARY_FENCE_SQL, withCurrentQaOwnerPrimaryRead } = await import(
  "data:text/javascript;base64," + Buffer.from(transformed.code).toString("base64")
);

const primaryId = "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
const journalVersion = "a".repeat(64);
const secret = "b".repeat(64);
const observedAt = Date.parse("2026-11-21T15:00:00Z");

function fixture() {
  const state = {
    schema: "cove.qa.owner-primary-read-bracket.v1",
    ownerEpoch: 4,
    primaryEpoch: 4,
    primaryId,
    journalVersion,
    revision: "A",
    primaryRevision: "A",
    dirty: 0,
    pendingWithdrawals: 0,
    pendingWrites: 0,
    eligibilityUntil: observedAt + 150_000,
    responseStatus: 200,
    responseCacheControl: "no-store",
    responseContentType: "application/json",
    corruptReceipt: (value) => value,
    ownerCalls: 0,
    primarySessions: 0,
    primaryReads: 0,
    observedOwnerBodies: [],
  };
  const owner = {
    async fetch(request) {
      state.ownerCalls++;
      assert.equal(new URL(request.url).pathname, "/qa/current-mutation-fence");
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("authorization"), "Bearer " + secret);
      assert.equal(request.headers.get("cache-control"), "no-store");
      const body = await request.json();
      assert.deepEqual(Object.keys(body), ["challenge"]);
      assert.match(body.challenge, /^[a-f0-9]{32}$/);
      state.observedOwnerBodies.push(body.challenge);
      const receipt = state.corruptReceipt({
        schema: "cove.qa.current-owner-sql-journal.v1",
        journalVersion: state.journalVersion,
        mutationEpoch: String(state.ownerEpoch),
        authorizing: false,
        tables: 27,
        triggers: 87,
        challenge: body.challenge,
        rehearsalRevision: state.revision,
        primaryId: state.primaryId,
      });
      return new Response(JSON.stringify(receipt), {
        status: state.responseStatus,
        headers: {
          "cache-control": state.responseCacheControl,
          "content-type": state.responseContentType,
        },
      });
    },
  };
  const primary = {
    withSession(mode) {
      assert.equal(mode, "first-primary", "primary sessions must never be replica/unconstrained");
      state.primarySessions++;
      return {
        prepare(sql) {
          assert.equal(sql, QA_OWNER_PRIMARY_FENCE_SQL);
          return {
            async first() {
              state.primaryReads++;
              return {
                publication_schema: state.schema,
                primary_id: state.primaryId,
                owner_journal_version: state.journalVersion,
                owner_mutation_epoch: state.primaryEpoch,
                owner_rehearsal_revision: state.primaryRevision,
                dirty: state.dirty,
                pending_withdrawals: state.pendingWithdrawals,
                pending_writes: state.pendingWrites,
                eligibility_valid_until_ms: state.eligibilityUntil,
              };
            },
          };
        },
      };
    },
  };
  const env = {
    owner,
    secret,
    primary,
    primaryId,
    journalVersion,
    nowMs: () => observedAt,
  };
  return { state, env };
}
const read = async (x, callback = async () => ["independently-rights-checked"]) =>
  withCurrentQaOwnerPrimaryRead(x.env, callback);

const good = fixture();
assert.deepEqual(await read(good), ["independently-rights-checked"]);
assert.equal(good.state.ownerCalls, 2, "independent owner must be re-read after catalog");
assert.equal(good.state.primaryReads, 3, "primary must be re-read on fresh sessions");
assert.equal(good.state.primarySessions, 3);
assert.notEqual(
  good.state.observedOwnerBodies[0],
  good.state.observedOwnerBodies[1],
  "a replayed owner response cannot be reused across challenges",
);

for (const change of [
  (x) => {
    x.env.primaryId = "4bd657ac-8789-403e-a28c-93aba8d0a989";
  },
  (x) => {
    x.env.secret = "invalid";
  },
  (x) => {
    x.env.journalVersion = "invalid";
  },
  (x) => {
    x.env.owner = null;
  },
  (x) => {
    x.env.primary = null;
  },
]) {
  const x = fixture();
  change(x);
  await assert.rejects(read(x), /qa_owner_primary_read_not_current/);
  assert.equal(x.state.ownerCalls, 0, "configuration checks reject before owner fetch");
}

for (const alter of [
  (r) => ({ ...r, schema: "cove.production-owner.v1" }),
  (r) => ({ ...r, authorizing: true }),
  (r) => ({ ...r, challenge: "0".repeat(32) }),
  (r) => ({ ...r, primaryId: "4bd657ac-8789-403e-a28c-93aba8d0a989" }),
  (r) => ({ ...r, journalVersion: "c".repeat(64) }),
  (r) => ({ ...r, mutationEpoch: "0" }),
  (r) => ({ ...r, mutationEpoch: "04" }),
  (r) => ({ ...r, mutationEpoch: "9007199254740992" }),
  (r) => ({ ...r, mutationEpoch: 4 }),
  (r) => ({ ...r, tables: 26 }),
  (r) => ({ ...r, triggers: 86 }),
  (r) => ({ ...r, rehearsalRevision: "C" }),
  (r) => {
    const { rehearsalRevision: ignored, ...noRevision } = r;
    void ignored;
    return noRevision;
  },
  (r) => ({ ...r, extra: true }),
]) {
  const x = fixture();
  x.state.corruptReceipt = alter;
  await assert.rejects(read(x), /qa_owner_primary_read_not_current/);
}
for (const edit of [
  (x) => {
    x.state.responseStatus = 503;
  },
  (x) => {
    x.state.responseCacheControl = "public, max-age=60";
  },
  (x) => {
    x.state.responseContentType = "text/plain";
  },
  (x) => {
    x.state.corruptReceipt = () => ({ huge: "x".repeat(2200) });
  },
]) {
  const x = fixture();
  edit(x);
  await assert.rejects(read(x), /qa_owner_primary_read_not_current/);
}

for (const edit of [
  (s) => {
    s.schema = "cove.production.primary-fence.v1";
  },
  (s) => {
    s.primaryEpoch = 3;
  },
  (s) => {
    s.primaryEpoch = "4";
  },
  (s) => {
    s.primaryId = "wrong";
  },
  (s) => {
    s.primaryRevision = "B";
  },
  (s) => {
    s.dirty = 1;
  },
  (s) => {
    s.pendingWithdrawals = 1;
  },
  (s) => {
    s.pendingWrites = 1;
  },
  (s) => {
    s.eligibilityUntil = observedAt;
  },
  (s) => {
    s.eligibilityUntil = observedAt + 301_000;
  },
  (s) => {
    s.eligibilityUntil = "infinity";
  },
]) {
  const x = fixture();
  edit(x.state);
  await assert.rejects(read(x), /qa_owner_primary_read_not_current/);
}
const races = [
  (s) => {
    s.ownerEpoch++;
  }, // owner denial ACK before primary D1 commit
  (s) => {
    s.ownerEpoch++;
    s.primaryEpoch++;
  }, // even a fully reconciled new generation
  (s) => {
    s.pendingWithdrawals = 1;
  },
  (s) => {
    s.dirty = 1;
  },
  (s) => {
    s.revision = "B";
    s.primaryRevision = "B";
  },
];
for (const change of races) {
  const x = fixture();
  let rightsCallbackReturned = false;
  await assert.rejects(
    read(x, async () => {
      change(x.state);
      rightsCallbackReturned = true;
      return { bookIds: ["prd_private_fixture"] };
    }),
    /qa_owner_primary_read_not_current/,
  );
  assert.equal(rightsCallbackReturned, true);
  assert.ok(x.state.primaryReads >= 1);
}

const lastOwnerRace = fixture();
const originalOwner = lastOwnerRace.env.owner;
lastOwnerRace.env.owner = {
  async fetch(request) {
    if (lastOwnerRace.state.ownerCalls === 1) lastOwnerRace.state.ownerEpoch++;
    return originalOwner.fetch(request);
  },
};
await assert.rejects(read(lastOwnerRace), /qa_owner_primary_read_not_current/);

const expiryRace = fixture();
let clockReads = 0;
expiryRace.env.nowMs = () => {
  clockReads++;
  return clockReads >= 3 ? observedAt + 151_000 : observedAt;
};
await assert.rejects(read(expiryRace), /qa_owner_primary_read_not_current/);
for (const invalidClock of [NaN, Infinity, -1, 0, 1.5]) {
  const x = fixture();
  x.env.nowMs = () => invalidClock;
  await assert.rejects(read(x), /qa_owner_primary_read_not_current/);
}
const rewindingClock = fixture();
let priorClockRead = false;
rewindingClock.env.nowMs = () => {
  if (priorClockRead) return observedAt - 1;
  priorClockRead = true;
  return observedAt;
};
await assert.rejects(read(rewindingClock), /qa_owner_primary_read_not_current/);

const ownerUnavailable = fixture();
ownerUnavailable.env.owner.fetch = async () => {
  throw Error("injected owner outage");
};
await assert.rejects(read(ownerUnavailable), /injected owner outage/);

const readFailed = fixture();
await assert.rejects(
  read(readFailed, async () => {
    throw Error("current legal rights unavailable");
  }),
  /current legal rights unavailable/,
);
const guardedSource = readFileSync("src/storefront-strangler/legal-authority.worker.ts", "utf8");
assert.match(guardedSource, /route==="\/qa\/current-mutation-fence"/);
assert.match(guardedSource, /journal=readOwnerSqlMutationJournal/);
const backendSource = readFileSync("src/persistence-backend.worker.ts", "utf8");
assert.doesNotMatch(backendSource, /current-owner-primary-read-bracket\.stage/);
assert.doesNotMatch(source, /4bd657ac-8789-403e-a28c-93aba8d0a989\s*\)\s*\{/);
assert.match(source, /No flag, cache or client header/);
console.log(
  "PASS: isolated owner-primary read bracket, 3 primary checks, 2 fresh owner challenges, " +
    "negative pending/dirty/expiry/version and 5 cross-service withdrawal races; no production authorization",
);
