import assert from "node:assert/strict";

const sourceHost = "cove-music-supply-isolated-qa.cove-jibrilmohamud.workers.dev";
const stagingHost =
  /^cove-persistence-backend-(?:staging|qa)[a-z0-9-]*\.cove-jibrilmohamud\.workers\.dev$/;

function exactOrigin(raw, checkHost) {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    !checkHost(u.hostname) ||
    u.username ||
    u.password ||
    u.port ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw Error("Cove handoff must use a dedicated HTTPS QA/staging Worker origin");
  return u.origin;
}
export function validateMusicHandoffOperator(config) {
  const execute = config.execute === true;
  const limit = config.limit ?? 4;
  const maxBatches = config.maxBatches ?? 2;
  const after = config.after ?? "0";
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 8 ||
    !Number.isSafeInteger(maxBatches) ||
    maxBatches < 1 ||
    maxBatches > 20 ||
    !/^(0|[1-9][0-9]{0,14})$/.test(after)
  )
    throw Error("Unsafe music handoff pagination");
  if (!execute) return { execute: false, limit, maxBatches, after };
  if (config.enabled !== "1") throw Error("Music handoff writes require an explicit QA switch");
  const upstream = exactOrigin(config.supplierUrl, (host) => host === sourceHost);
  const destination = exactOrigin(config.canonicalUrl, (host) => stagingHost.test(host));
  for (const token of [config.operatorToken, config.backendToken, config.handoffToken])
    if (typeof token !== "string" || token.length < 40 || token.length > 256)
      throw Error("Missing independent scoped music handoff identity");
  assert.notEqual(config.operatorToken, config.handoffToken);
  assert.notEqual(config.backendToken, config.handoffToken);
  return { ...config, execute: true, limit, maxBatches, after, upstream, destination };
}
export async function runMusicHandoff(config, deps = {}) {
  const cfg = validateMusicHandoffOperator(config);
  if (!cfg.execute)
    return { dryRun: true, attempted: 0, applied: 0, skipped: 0, nextCursor: cfg.after };
  const send = deps.send || fetch;
  let after = cfg.after,
    attempted = 0,
    applied = 0,
    skipped = 0,
    batches = 0;
  for (let batch = 0; batch < cfg.maxBatches; batch++) {
    const u =
      cfg.upstream +
      "/v1/operator/outbox?after=" +
      encodeURIComponent(after) +
      "&limit=" +
      cfg.limit;
    const response = await send(u, {
      method: "GET",
      headers: { Authorization: "Bearer " + cfg.operatorToken },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    if (
      response.status !== 200 ||
      (response.headers.get("content-type") || "").indexOf("application/json") < 0
    )
      throw Error("Source music outbox unavailable: HTTP " + response.status);
    const feed = await response.json();
    if (
      !Array.isArray(feed.items) ||
      feed.items.length > cfg.limit ||
      !/^(0|[1-9][0-9]{0,14})$/.test(String(feed.nextCursor))
    )
      throw Error("Malformed music supply outbox");
    if (!feed.items.length) break;
    for (const event of feed.items) {
      if (
        !Number.isSafeInteger(event?.seq) ||
        event.seq <= Number(after) ||
        typeof event?.id !== "string" ||
        !["master_qualified", "master_revoked", "contract_revoked"].includes(event.action)
      )
        throw Error("Out-of-order or malformed source rights event");
      if (event.action === "master_qualified" && event.publishable !== 1) {
        skipped++;
      } else {
        const dest = await send(cfg.destination + "/__cove/ingestion/music-supply-handoff", {
          method: "POST",
          headers: {
            "x-cove-backend-token": cfg.backendToken,
            "x-cove-music-handoff-token": cfg.handoffToken,
            "content-type": "application/json",
          },
          body: JSON.stringify(event),
          redirect: "manual",
          signal: AbortSignal.timeout(20000),
        });
        if (dest.status !== 200)
          throw Error("Canonical music handoff failed closed: HTTP " + dest.status);
        const result = await dest.json();
        if (result.seq !== event.seq || !(result.recorded || result.replay))
          throw Error("Canonical music receipt missing or mismatched");
        applied++;
      }
      attempted++;
      after = String(event.seq);
    }
    if (String(feed.nextCursor) !== after)
      throw Error("Music outbox next cursor does not match delivered events");
    batches++;
    if (feed.items.length < cfg.limit) break;
  }
  return { dryRun: false, attempted, applied, skipped, batches, nextCursor: after };
}
if (process.argv[1]?.endsWith("/replay-music-supply-handoff.mjs")) {
  const args = process.argv.slice(2);
  const value = (name, fallback) =>
    args.find((x) => x.startsWith("--" + name + "="))?.slice(name.length + 3) ?? fallback;
  const result = await runMusicHandoff({
    execute: args.includes("--execute"),
    enabled: process.env.COVE_MUSIC_CANONICAL_HANDOFF_WRITES_ENABLED,
    supplierUrl: process.env.COVE_MUSIC_SUPPLIER_QA_URL,
    canonicalUrl: process.env.COVE_MUSIC_CANONICAL_QA_URL,
    operatorToken: process.env.COVE_MUSIC_SUPPLY_OPERATOR_TOKEN,
    backendToken: process.env.COVE_MUSIC_CANONICAL_BACKEND_TOKEN,
    handoffToken: process.env.COVE_MUSIC_CANONICAL_HANDOFF_TOKEN,
    after: value("after", "0"),
    limit: Number(value("limit", "4")),
    maxBatches: Number(value("max-batches", "2")),
  });
  console.log(JSON.stringify(result));
}
