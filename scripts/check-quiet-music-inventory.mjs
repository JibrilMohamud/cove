import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-quiet-readiness-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/quiet-music-inventory.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "quiet.mjs"),
    logLevel: "silent",
  });
  const { getQuietMusicInventory, quietInventoryMarket } = await import(
    path.join(root, "quiet.mjs")
  );
  assert.equal(quietInventoryMarket(null), "US");
  assert.equal(quietInventoryMarket("CA"), "CA");
  assert.throws(() => quietInventoryMarket("us"), /Invalid/);
  assert.throws(() => quietInventoryMarket("US';--"), /Invalid/);

  const env = localBindings(root);
  const date = "2026-10-20T00:00:00.000Z";
  async function recording(
    id,
    { status = "ready", quality = "passed", territories = '["US"]', triage = "" } = {},
  ) {
    await env.DB.prepare(
      "INSERT INTO soundtrack_recordings(id,source_title,source_page_url,source_file_url," +
        "source_sha1,source_size,mime,title,performer,composer,license_code,license_url," +
        "license_statement,attribution_text,evidence_json,discovered_at,updated_at," +
        "status,quality_status,quality_report_json,allowed_territories_json," +
        "storage_key,source_snapshot_key,has_vocals,automated_triage_reason)" +
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        "File:" + id + ".ogg",
        "https://commons.wikimedia.org/wiki/File:" + id,
        "https://upload.wikimedia.org/" + id,
        createHash("sha1").update(id).digest("hex"),
        1024,
        "audio/ogg",
        "Test " + id,
        "test performer",
        "test composer",
        "CC0",
        "https://creativecommons.org/publicdomain/zero/1.0/",
        "test declared",
        "test attribution",
        "{}",
        date,
        date,
        status,
        quality,
        JSON.stringify({ durationSeconds: 120 }),
        territories,
        status === "ready" ? "soundtracks/" + id : null,
        status === "ready" ? "evidence/" + id : null,
        0,
        triage,
      )
      .run();
  }
  async function profile(id, energy, distraction) {
    await env.DB.prepare(
      "INSERT INTO music_profiles(recording_id,fingerprint,policy,status,profile_json,updated_at)" +
        " VALUES(?,?,?,'analyzed',?,?)",
    )
      .bind(
        id,
        "sha_" + id,
        "v1",
        JSON.stringify({
          audioAnalysis: { durationSeconds: 120, signal: { energy }, structure: { timeline: [] } },
          readingSuitability: { distraction },
        }),
        date,
      )
      .run();
  }

  await recording("cm_1001");
  await profile("cm_1001", 0.4, 0.35); // strict and broad
  await recording("cm_1002");
  await profile("cm_1002", 0.55, 0.3); // broad only
  await recording("cm_1003", { territories: '["CA"]' });
  await profile("cm_1003", 0.2, 0.1); // never counted in US
  await recording("cm_1004", { status: "pending_review" }); // not playable
  await recording("cm_1005", {
    status: "pending_review",
    triage: "Human rights review required",
  });
  await recording("cm_1006", { quality: "failed" }); // not playable
  await profile("cm_1006", 0.2, 0.1);
  await recording("cm_1007", { territories: "not-json" }); // invalid market
  await profile("cm_1007", 0.2, 0.1);

  const us = await getQuietMusicInventory(env.DB, "US");
  assert.equal(us.reportOnly, true);
  assert.equal(us.scope, "commons_only");
  assert.equal(us.playableScope, "requested_territory");
  assert.equal(us.reviewsScope, "global_unapproved_commons");
  assert.equal(us.shortlistScope, "global_unapproved_commons");
  assert.equal(us.playable.playable, 2);
  assert.equal(us.playable.playable_minutes, 4);
  assert.equal(us.playable.strict_screen_count, 1);
  assert.equal(us.playable.strict_screen_minutes, 2);
  assert.equal(us.playable.broad_screen_count, 2);
  assert.equal(us.playable.broad_screen_minutes, 4);
  assert.equal(us.reviews.qa_passed_awaiting_rights_review, 2);
  assert.equal(us.reviews.qa_passed_untriaged, 1);
  assert.equal(us.shortlist.length, 1);
  assert.equal(us.shortlist[0].id, "cm_1004");
  assert.match(us.disclaimer, /not a human focus-suitability or legal-rights approval/);
  const ca = await getQuietMusicInventory(env.DB, "CA");
  assert.equal(ca.playable.playable, 1);
  assert.equal(ca.playable.strict_screen_count, 1);
  assert.equal(ca.playable.broad_screen_count, 1);
  assert.deepEqual(ca.reviews, us.reviews, "Global review backlog must not masquerade as local supply");
  assert.deepEqual(ca.shortlist, us.shortlist, "Territory only filters actually playable tracks");
  assert.match(ca.disclaimer, /global unapproved Commons candidates/);

  const route = fs.readFileSync("src/features/fore/soundtracks.server.ts", "utf8");
  assert.ok(
    route.indexOf('if (admin && path === "/admin/soundtracks/quiet-inventory"') >
      route.indexOf("const url = new URL(request.url);"),
    "Staff route must not be exposed outside the admin-gated handler",
  );
  assert.match(route, /requireStaffPermission\(env.DB,staffIdentity,"soundtracks.review"/);
  assert.match(route, /requireServiceScope\(env.DB,request,"soundtracks.review"/);
  console.log(
    "Quiet readiness measures actual signal features, excludes unapproved and wrong-market tracks, and never alters licenses.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
