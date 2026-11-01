import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cove-community-tournaments-"));
try {
  fs.cpSync("drizzle", path.join(scratch, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/community-tournaments.server.ts"],
    bundle: true, platform: "node", format: "esm", outdir: scratch,
    outExtension: { ".js": ".mjs" }, logLevel: "silent",
  });
  const service = await import(path.join(scratch, "community-tournaments.server.mjs"));
  const env = localBindings(scratch);
  const db = env.DB;
  const stamp = new Date().toISOString();
  for (const user of ["host", "reader", "another"]) {
    await db.prepare(
      "INSERT INTO auth_accounts(provider_id,app_id,email,username,created_at) VALUES(?,?,?,?,?)"
    ).bind(user, user, user + "@example.test", user, stamp).run();
    await db.prepare(
      "INSERT INTO social_profiles(user_id,profile_visibility,activity_visibility,created_at,updated_at) VALUES(?,'public','public',?,?)"
    ).bind(user, stamp, stamp).run();
  }
  const call = async (route, method = "GET", body, userId = null) => {
    const request = new Request("https://fore.test/api/fore" + route, {
      method,
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    const response = await service.handleCommunityTournaments(request, env, route, userId);
    assert.ok(response, "Tournament endpoint must be handled.");
    return { status: response.status, body: await response.json() };
  };
  const payload = {
    title: "Readers' Choice: Classics",
    productIds: ["1342", "1260", "84", "2701"],
    roundDurationMinutes: 60,
  };
  await assert.rejects(
    () => call("/social/tournaments", "POST", payload, null),
    /Sign in/,
    "Guests cannot create a bracket.",
  );
  await assert.rejects(
    () => call("/social/tournaments", "POST",
      { ...payload, productIds: ["1342", "1342", "84", "2701"] }, "host"),
    /different/,
    "Same book cannot enter twice.",
  );
  const made = await call("/social/tournaments", "POST", payload, "host");
  assert.equal(made.status, 201);
  const bracket = made.body;
  assert.match(bracket.id, /^ct_[0-9a-f-]{36}$/);
  assert.equal(bracket.entries.length, 4);
  assert.equal(bracket.matches.length, 2);
  assert.equal(bracket.currentRound, 1);
  assert.equal(bracket.status, "live");
  assert.equal((await call("/social/tournaments")).body.items.length, 1);
  const [first, second] = bracket.matches;
  await assert.rejects(
    () => call("/social/tournaments/" + bracket.id + "/vote", "POST",
      { matchId: first.id, entryId: bracket.entries[2].id }, "reader"),
    /Choose a contender/,
    "Cross-match ballots must fail.",
  );
  const cast = (matchId, entryId, user = "reader") =>
    call("/social/tournaments/" + bracket.id + "/vote", "POST",
      { matchId, entryId }, user);
  const firstVote = await cast(first.id, first.entryAId);
  assert.equal(firstVote.body.matches[0].aVotes, 1);
  await cast(first.id, first.entryBId);
  const swapped = await call("/social/tournaments/" + bracket.id);
  assert.equal(swapped.body.matches[0].aVotes, 0);
  assert.equal(swapped.body.matches[0].bVotes, 1, "One reader has one live ballot.");
  await cast(first.id, first.entryBId, "another");
  await cast(second.id, second.entryAId);
  const early = await call("/social/tournaments/" + bracket.id + "/advance", "POST", {});
  assert.equal(early.body.advanced, false, "Cannot finalize before deadline.");

  const yesterday = new Date(Date.now() - 100_000).toISOString();
  await db.prepare("UPDATE community_tournaments SET round_deadline=? WHERE id=?")
    .bind(yesterday, bracket.id).run();
  await db.prepare("UPDATE community_tournament_matches SET closes_at=? WHERE tournament_id=?")
    .bind(yesterday, bracket.id).run();
  const advanced = await service.advanceDueTournaments(db, 5);
  assert.equal(advanced, 1);
  const semifinal = (await call("/social/tournaments/" + bracket.id)).body;
  assert.equal(semifinal.currentRound, 2);
  assert.equal(semifinal.status, "live");
  assert.equal(semifinal.matches.length, 3);
  assert.deepEqual(
    semifinal.matches.slice(0, 2).map((match) => match.winnerEntryId),
    [first.entryBId, second.entryAId],
    "Authoritative winners must come from frozen votes.",
  );
  assert.deepEqual(
    [semifinal.matches[2].entryAId, semifinal.matches[2].entryBId],
    [first.entryBId, second.entryAId],
    "The new final must contain exactly the two verified winners.",
  );
  assert.equal(await service.advanceDueTournaments(db, 5), 0, "Retry must be idempotent.");
  await assert.rejects(
    () => cast(first.id, first.entryAId), /Choose a contender|closed/,
    "Closed rounds reject replayed votes.",
  );
  const final = semifinal.matches[2];
  const votedFinal = await cast(final.id, final.entryBId);
  assert.equal(votedFinal.body.matches[2].bVotes, 1);
  await db.prepare("UPDATE community_tournaments SET round_deadline=? WHERE id=?")
    .bind(yesterday, bracket.id).run();
  await db.prepare("UPDATE community_tournament_matches SET closes_at=? WHERE id=?")
    .bind(yesterday, final.id).run();
  assert.equal(await service.advanceDueTournaments(db, 5), 1);
  const completed = (await call("/social/tournaments/" + bracket.id)).body;
  assert.equal(completed.status, "completed");
  assert.equal(completed.championEntryId, final.entryBId);
  assert.equal(completed.matches[2].winnerEntryId, final.entryBId);
  assert.equal(completed.matches.length, 3);
  assert.equal(await service.advanceDueTournaments(db, 5), 0);
  await assert.rejects(() => cast(final.id, final.entryAId), /closed/,
    "Completed tournament ballot cannot change.");
  await db.prepare(
    "UPDATE social_profiles SET activity_visibility='private' WHERE user_id='host'"
  ).run();
  await assert.rejects(
    () => call("/social/tournaments/" + bracket.id),
    /not found/,
    "Revoking host activity visibility hides the tournament.",
  );
  assert.equal((await call("/social/tournaments")).body.items.length, 0);
  const newWriter = fs.readFileSync(
    "src/features/fore/community-tournaments.server.ts", "utf8",
  );
  assert.doesNotMatch(
    newWriter,
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:products|rights_grants|entitlements|commerce_orders|publishing_contracts)\b/i,
    "Tournament endpoints must not mutate legal, rights, or financial tables.",
  );
  console.log("PASS: real four-book bracket, vote exclusivity, final snapshots, " +
    "timed advancement, idempotent replay, completed champion, privacy and social-only mutations");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
