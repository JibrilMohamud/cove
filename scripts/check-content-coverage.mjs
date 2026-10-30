import JSZip from "jszip";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-coverage-"));
const fetchBefore = globalThis.fetch;
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: [
      "api.server",
      "catalog-assets.server",
      "audio-coverage",
      "audio-coverage.server",
      "audio.server",
      "pipeline.server",
      "stored-epub.server",
      "epub-retry-policy",
      "public-status.server",
    ].map((f) => `src/features/fore/${f}.ts`),
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const api = await import(path.join(root, "api.server.mjs"));
  const policy = await import(path.join(root, "epub-retry-policy.mjs"));
  assert.equal(policy.hasEpubDownloadWindow(Date.now() + 1000), false);
  assert.equal(policy.hasEpubDownloadWindow(Date.now() + 20_000), true);
  assert.equal(policy.hasEpubDownloadWindow(Infinity), true);
  assert.deepEqual(
    policy.mixEpubFrontier([1, 2, 3, 4, 5, 6], ["retry-1", "retry-2"], 8),
    [1, 2, 3, "retry-1", 4, 5, 6, "retry-2"],
    "Fresh uploads progress while timeouts retain retry capacity",
  );
  assert.deepEqual(policy.mixEpubFrontier([], ["retry-1", "retry-2"], 3), ["retry-1", "retry-2"]);
  assert.deepEqual(policy.mixEpubFrontier([1, 2, 3], [], 2), [1, 2]);
  assert.equal(
    policy.planEpubRetry("The operation was aborted due to timeout", 8, 0).terminal,
    false,
  );
  assert.equal(
    policy.planEpubRetry("The operation was aborted due to timeout", 12, 0).terminal,
    true,
  );
  assert.equal(policy.planEpubRetry("EPUB source returned 404", 3, 0).terminal, true);
  assert.equal(
    policy.planEpubRetry("This file is too large. The EPUB limit is 25 MB.", 1, 0).terminal,
    true,
  );
  const { runStoredAssetTick } = await import(path.join(root, "catalog-assets.server.mjs"));
  const { audioCoverage } = await import(path.join(root, "audio-coverage.mjs"));
  const env = localBindings(root);
  await api.handleCoveApi(new Request("https://cove.test/api/fore/catalog"), env);
  // Fail the release if a future migration forces a large transient sort on
  // the per-minute US queue; the backend uses these exact bound predicates.
  for (const status of ["pending", "retry"]) {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id,title FROM gutenberg_source_cache
       WHERE source_id=? AND epub_status=? AND ingest_status<>'quarantined'
         AND epub_next_attempt_at<=?
       ORDER BY epub_next_attempt_at,updated_at,id LIMIT ?`,
    )
      .bind("pg_us", status, new Date().toISOString(), 32)
      .all();
    assert.ok(
      plan.results.some((row) => String(row.detail).includes("gutenberg_asset_frontier_v2")),
      status + ": ready EPUB queue must use the composite per-source frontier",
    );
    assert.ok(
      !plan.results.some((row) => String(row.detail).includes("USE TEMP B-TREE")),
      status + ": ready EPUB queue must avoid a backlog-sized temp sort",
    );
  }
  await env.DB.prepare("UPDATE gutenberg_sources SET enabled=0 WHERE id<>'pg_us'").run();
  const seed = JSON.parse(fs.readFileSync("src/features/fore/catalog-seed.json", "utf8"))
    .results[0];
  globalThis.fetch = async () =>
    Response.json({
      results: Array.from({ length: 48 }, (_, i) => ({
        ...seed,
        id: 990001 + i,
        title: `Coverage ${i}`,
        copyright: false,
      })),
      count: 48,
      next: null,
    });
  const attemptedImport = await api.runCatalogIngestion({ ...env, BUCKET: undefined }, 0, {
    includeRegional: false,
  });
  assert.equal(
    attemptedImport.failed,
    true,
    "source import cannot authorize catalog rows without owner",
  );
  assert.match(attemptedImport.error, /Catalog normalization requires private authority/);
  env.seedAdditionalLocalCatalogBooks(
    Array.from({ length: 48 }, (_, i) => ({
      ...seed,
      id: 990001 + i,
      title: `Coverage ${i}`,
      copyright: false,
    })),
  );
  await env.DB.prepare(
    "UPDATE gutenberg_source_cache SET epub_status='unavailable' WHERE id NOT BETWEEN '990001' AND '990048'",
  ).run();
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
  );
  zip.file(
    "book.opf",
    '<package><manifest><item id="chapter" href="chapter.xhtml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
  );
  zip.file("chapter.xhtml", "<html><body>Verified archive</body></html>");
  const epub = await zip.generateAsync({ type: "uint8array" });
  const { validateStoredEpub } = await import(path.join(root, "stored-epub.server.mjs"));
  await validateStoredEpub(epub);
  zip.file("book.opf", '<package><manifest/><spine><itemref idref="missing"/></spine></package>');
  await assert.rejects(
    validateStoredEpub(await zip.generateAsync({ type: "uint8array" })),
    /missing manifest/,
  );
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(epub);
  };
  await env.DB.prepare("UPDATE gutenberg_sources SET enabled=0 WHERE id='pg_us'").run();
  assert.equal(
    (await api.runCatalogAssetMaintenance(env, 32, Date.now() + 1000)).attempted,
    0,
    "disabled source configuration is respected",
  );
  await env.DB.prepare("UPDATE gutenberg_sources SET enabled=1 WHERE id='pg_us'").run();
  const results = await Promise.all([
    runStoredAssetTick({ ...env, FORE_ASSETS_PER_MINUTE: "32" }),
    runStoredAssetTick({ ...env, FORE_ASSETS_PER_MINUTE: "32" }),
  ]);
  assert.equal(
    results.filter((r) => r.skipped === "leased").length,
    1,
    "overlapping crons have one lease owner",
  );
  assert.equal(calls, 32, "asset work exceeds the old cap, with a strict bound");
  const assetState = await env.DB.prepare(
    "SELECT id,epub_status,epub_last_error FROM gutenberg_source_cache WHERE id BETWEEN '990001' AND '990048' AND epub_status<>'completed' LIMIT 3",
  ).all();
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT count(*) count FROM gutenberg_source_cache WHERE epub_status='completed'",
      ).first()
    ).count,
    32,
    "EPUB ingestion failures: " + JSON.stringify(assetState.results),
  );
  assert.equal(
    (await runStoredAssetTick({ ...env, FORE_ASSETS_PER_MINUTE: "0" })).skipped,
    "disabled",
  );
  assert.equal(
    (await runStoredAssetTick({ ...env, FORE_ASSETS_PER_MINUTE: "bad" })).skipped,
    "disabled",
  );
  // A bad origin must back off without losing other assets, and exhausted ticks do no I/O.
  globalThis.fetch = async () => new Response("Unavailable", { status: 503 });
  const tooLate = await api.runCatalogAssetMaintenance(env, 1, Date.now() + 1000);
  assert.equal(tooLate.attempted, 0, "short remaining batch time cannot consume a retry");
  const failure = await api.runCatalogAssetMaintenance(env, 1, Date.now() + 20_000);
  assert.equal(failure.failed, 1);
  const retry = await env.DB.prepare(
    "SELECT epub_attempts,epub_next_attempt_at FROM gutenberg_source_cache WHERE epub_status='retry'",
  ).first();
  assert.equal(retry.epub_attempts, 1);
  assert.ok(Date.parse(retry.epub_next_attempt_at) > Date.now());
  assert.equal((await api.runCatalogAssetMaintenance(env, 64, Date.now() - 1)).attempted, 0);
  await env.DB.prepare("UPDATE gutenberg_source_states SET epub_retry_after='' ").run();
  globalThis.fetch = async () => new Response("PK fake archive");
  assert.equal(
    (await api.runCatalogAssetMaintenance(env, 1, Date.now() + 20_000)).downloaded,
    0,
    "a magic-byte lookalike cannot be stored",
  );
  await env.DB.prepare("UPDATE gutenberg_source_states SET epub_retry_after='' ").run();
  let limitedCalls = 0;
  globalThis.fetch = async () => {
    limitedCalls++;
    return new Response("rate limited", { status: 429, headers: { "retry-after": "3600" } });
  };
  await api.runCatalogAssetMaintenance(env, 32, Date.now() + 20_000);
  assert.equal(limitedCalls, 1, "a rate-limited source gets no more attempts in the batch");
  const cooldown = await env.DB.prepare(
    "SELECT epub_retry_after FROM gutenberg_source_states WHERE source_id='pg_us'",
  ).first();
  assert.ok(
    Date.parse(cooldown.epub_retry_after) > Date.now() + 3500_000,
    "upstream Retry-After persists across ticks",
  );
  assert.equal((await api.runCatalogAssetMaintenance(env, 32, Date.now() + 20_000)).attempted, 0);
  const hash = "a".repeat(64),
    map = { trackId: "one", sha256: hash, wordCount: 30, coverage: 0.9 };
  const edition = {
    tracks: [{ id: "one", sha256: hash, duration: 60 }, { id: "two" }],
    alignment: { version: 2, verified: true, maps: [map] },
  };
  const partial = audioCoverage(edition, ["one"]);
  assert.equal(partial.preparedTracks, 1);
  assert.equal(partial.checkedTracks, 1);
  assert.equal(partial.completeRecording, false);
  assert.equal(partial.allTracksTimed, false);
  const full = audioCoverage({ ...edition, tracks: [edition.tracks[0]] }, ["one"]);
  assert.equal(full.allTracksTimed, true);
  assert.equal(
    full.wholeBookTextVerified,
    false,
    "full track timing cannot imply whole text coverage",
  );
  assert.equal(
    audioCoverage({ ...edition, alignment: { ...edition.alignment, verified: false } })
      .checkedTracks,
    0,
  );
  const coverageServer = await import(path.join(root, "audio-coverage.server.mjs"));
  // Storage checks are independent evidence: a declared checksum alone is zero coverage.
  assert.equal(audioCoverage(edition).preparedTracks, 0);
  const audioRecord = {
    id: "pg-990001",
    gutenbergId: "990001",
    bookId: null,
    title: "Coverage recording",
    authors: [],
    language: "en",
    narration: "human",
    narrator: "QA",
    sourceUrl: "https://www.gutenberg.org/ebooks/990001",
    rights: "Public domain in the USA.",
    tracks: [
      {
        id: "one",
        sha256: hash,
        duration: 60,
        url: "https://www.gutenberg.org/files/990001/one.mp3",
        mime: "audio/mpeg",
      },
    ],
    alignment: null,
    epubSha256: null,
  };
  await env.DB.prepare(
    "INSERT INTO audio_editions(id,gutenberg_id,book_id,title,authors_json,language,narration,narrator,source_url,rights,tracks_json,alignment_json,epub_sha256,updated_at) VALUES(?,?,NULL,?,'[]','en','human','QA',?,'Public domain in the USA.',?,NULL,NULL,?)",
  )
    .bind(
      audioRecord.id,
      audioRecord.gutenbergId,
      audioRecord.title,
      audioRecord.sourceUrl,
      JSON.stringify(audioRecord.tracks),
      new Date().toISOString(),
    )
    .run();
  await coverageServer.verifyAudioStorage(env);
  assert.equal(
    (await coverageServer.storedAudioCoverage(env, audioRecord)).preparedTracks,
    0,
    "missing R2 media cannot be ready",
  );
  await env.BUCKET.put(`audio/${audioRecord.id}/one-${hash}`, new Uint8Array([1, 2, 3]));
  await env.DB.prepare("UPDATE audio_media_checks SET checked_at='2000-01-01T00:00:00Z'").run();
  await coverageServer.verifyAudioStorage(env);
  assert.equal((await coverageServer.storedAudioCoverage(env, audioRecord)).preparedTracks, 1);
  assert.equal(
    (
      await coverageServer.storedAudioCoverage(env, {
        ...audioRecord,
        tracks: [{ ...audioRecord.tracks[0], sha256: "b".repeat(64) }],
      })
    ).preparedTracks,
    0,
    "old storage check cannot verify replacement files",
  );
  const audioServer = await import(path.join(root, "audio.server.mjs"));
  const { claimAudioJob } = await import(path.join(root, "pipeline.server.mjs"));
  const at = new Date().toISOString();
  for (const [id, remaining] of [
    ["pg-990010", 1],
    ["pg-990020", 3],
  ]) {
    const tracks = Array.from({ length: remaining }, (_, i) => ({
      id: String(i),
      url: `https://www.gutenberg.org/files/990001/${i}.mp3`,
      mime: "audio/mpeg",
      title: `Track ${i}`,
    }));
    await audioServer
      .insertEdition(env, { ...audioRecord, id, gutenbergId: id.slice(3), tracks })
      .run();
    for (const track of tracks)
      await env.DB.prepare(
        "INSERT INTO audio_jobs(id,kind,payload_json,status,updated_at,next_attempt_at) VALUES(?,'track',?,'queued',?,?)",
      )
        .bind(
          `${id}-${track.id}`,
          JSON.stringify({ editionId: id, trackId: track.id, sourceUrl: track.url }),
          at,
          at,
        )
        .run();
  }
  const claimed = await claimAudioJob(env, "track");
  assert.equal(
    JSON.parse(claimed.payload_json).editionId,
    "pg-990010",
    "finish a near-complete recording before scattering preparation",
  );
  const parallel = await Promise.all([claimAudioJob(env, "track"), claimAudioJob(env, "track")]);
  assert.notEqual(parallel[0].id, parallel[1].id, "concurrent workers cannot claim the same track");
  const { refreshPublicStatus } = await import(path.join(root, "public-status.server.mjs"));
  const status = await refreshPublicStatus(env);
  assert.equal(status.components.find((c) => c.id === "biosync").status, "limited");
  assert.match(status.components.find((c) => c.id === "downloads").detail, /await storage/);
  console.log(
    "PASS: asset throughput, singleton lease, bounds/disable/deadline/retry, partial/full recording distinctions and truthful health.",
  );
} finally {
  globalThis.fetch = fetchBefore;
  fs.rmSync(root, { recursive: true, force: true });
}
