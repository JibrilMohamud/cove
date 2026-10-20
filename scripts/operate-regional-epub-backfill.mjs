/**
 * Conservative operator-only coordinator for previously verified regional EPUB
 * metadata repair. No calls at all unless --execute AND a scoped confirmation
 * are provided. Never auto-retries or ignores an overloaded shared D1.
 *
 * Example: COVE_REPAIR_ORIGIN=https://...workers.dev \
 * COVE_REPAIR_TOKEN=[secret] COVE_REPAIR_CONFIRM=REPAIR_VERIFIED_REGIONAL_EPUBS \
 * node scripts/operate-regional-epub-backfill.mjs --execute
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const REPAIR_CONFIRM = "REPAIR_VERIFIED_REGIONAL_EPUBS";
const safeInteger = (value, lower, upper) =>
  Number.isSafeInteger(value) && value >= lower && value <= upper;

export function validateOperatorConfig(opts) {
  if (!opts.execute) return { execute: false };
  if (opts.confirm !== REPAIR_CONFIRM) throw Error("Scoped operator approval missing");
  if (typeof opts.token !== "string" || opts.token.length < 32)
    throw Error("Authenticated backend token missing");
  const origin = new URL(opts.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !origin.hostname.endsWith(".workers.dev")
  )
    throw Error("Use a protected HTTPS Worker origin without embedded credentials");
  if (
    !safeInteger(opts.limit, 1, 4) ||
    !safeInteger(opts.maxBatches, 1, 20) ||
    !safeInteger(opts.delayMs, 10_000, 60_000) ||
    !/^[a-z0-9_]{0,90}$/.test(opts.after || "")
  )
    throw Error("Unsafe operator rate, batch size, or cursor");
  return { ...opts, origin: origin.origin, execute: true };
}

export async function runBackfill(config, dependencies = {}) {
  const opts = validateOperatorConfig(config);
  if (!opts.execute) return { skipped: "dry_run_no_network", maximumRepairs: 0 };
  const send = dependencies.send ?? fetch;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const receipt = dependencies.receipt ?? (async () => {});
  let cursor = opts.after || "";
  let scanned = 0;
  let repaired = 0;
  let missingOrMismatched = 0;
  let conflicts = 0;
  let batches = 0;
  for (let i = 0; i < opts.maxBatches; i++) {
    const requestId = randomUUID();
    // A durable pending entry precedes any mutation. A network failure or
    // process interruption never silently reports an incomplete batch as OK.
    await receipt({
      requestId,
      phase: "started",
      at: new Date().toISOString(),
      cursor,
      limit: opts.limit,
    });
    let response;
    try {
      response = await send(opts.origin + "/__cove/ingestion/repair-regional-epubs", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + opts.token,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        body: JSON.stringify({ after: cursor, limit: opts.limit }),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      await receipt({ requestId, phase: "error", reason: "transport_or_timeout" });
      throw Error("Operator repair stopped after transport failure; reconcile journal before resuming");
    }
    if (response.status !== 200) {
      await receipt({ requestId, phase: "error", status: response.status });
      throw Error("Operator repair stopped on non-200 response: " + response.status);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      await receipt({ requestId, phase: "error", reason: "malformed_result" });
      throw Error("Operator repair returned malformed JSON");
    }
    if (
      !data ||
      typeof data !== "object" ||
      !safeInteger(data.scanned, 0, opts.limit) ||
      !safeInteger(data.repaired, 0, data.scanned) ||
      !safeInteger(data.missingOrMismatched, 0, data.scanned) ||
      !safeInteger(data.conflicts, 0, data.scanned) ||
      typeof data.nextAfter !== "string" ||
      !/^[a-z0-9_]{0,90}$/.test(data.nextAfter) ||
      data.nextAfter < cursor ||
      (data.scanned > 0 && data.nextAfter <= cursor) ||
      data.repaired + data.missingOrMismatched + data.conflicts > data.scanned ||
      typeof data.maybeMore !== "boolean"
    ) {
      await receipt({ requestId, phase: "error", reason: "invalid_result" });
      throw Error("Operator repair returned inconsistent counts/cursor");
    }
    await receipt({
      requestId,
      phase: "complete",
      at: new Date().toISOString(),
      after: data.nextAfter,
      scanned: data.scanned,
      repaired: data.repaired,
      missingOrMismatched: data.missingOrMismatched,
      conflicts: data.conflicts,
    });
    batches++;
    scanned += data.scanned;
    repaired += data.repaired;
    missingOrMismatched += data.missingOrMismatched;
    conflicts += data.conflicts;
    cursor = data.nextAfter;
    if (!data.maybeMore || data.scanned === 0) break;
    if (i + 1 < opts.maxBatches) await sleep(opts.delayMs);
  }
  return { batches, scanned, repaired, missingOrMismatched, conflicts, nextAfter: cursor };
}

async function main() {
  const execute = process.argv.slice(2).includes("--execute");
  if (!execute) {
    console.log(JSON.stringify({ skipped: "dry_run_no_network", message: "Pass --execute and scoped operator approval to change verified metadata. Default makes no network calls." }));
    return;
  }
  const config = {
    execute: true,
    confirm: process.env.COVE_REPAIR_CONFIRM,
    origin: process.env.COVE_REPAIR_ORIGIN || "",
    token: process.env.COVE_REPAIR_TOKEN || "",
    limit: Number(process.env.COVE_REPAIR_BATCH_SIZE || 2),
    maxBatches: Number(process.env.COVE_REPAIR_MAX_BATCHES || 1),
    delayMs: Number(process.env.COVE_REPAIR_DELAY_MS || 15_000),
    after: process.env.COVE_REPAIR_AFTER || "",
  };
  const runId = randomUUID();
  const dir = path.join(process.cwd(), "out", "regional-repair");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const journal = path.join(dir, runId + ".jsonl");
  const answer = await runBackfill(config, {
    receipt: async (value) => {
      await appendFile(journal, JSON.stringify({ runId, ...value }) + "\n", { mode: 0o600 });
    },
  });
  console.log(JSON.stringify({ ...answer, journal }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Do not print exception URLs, authorization material or response bodies.
    console.error("Backfill stopped; inspect protected operator journal before reattempting");
    process.exitCode = 1;
  });
}
