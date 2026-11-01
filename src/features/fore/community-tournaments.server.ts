import { z } from "zod/v3";
import type { CoveEnv } from "./api.server";
import { ApiError, json, now, rateLimit, readBody, requireIdentity } from "./service";

// A separate social-game aggregate. These writes never modify licensed-book
// authority, entitlements, rights, financial state, or catalog records.
type DB = CoveEnv["DB"];
const newId = (kind: string) => kind + "_" + crypto.randomUUID();
const tournamentPath = /^\/social\/tournaments\/(ct_[0-9a-f-]{36})(?:\/(vote|advance))?$/;
const createSchema = z.object({
  title: z.string().trim().min(4).max(100),
  productIds: z.array(z.string().trim().min(1).max(160)).length(4)
    .refine((ids) => new Set(ids).size === ids.length, "Choose four different books."),
  roundDurationMinutes: z.union([z.literal(60), z.literal(1440), z.literal(10080)]).default(1440),
}).strict();
const voteSchema = z.object({
  matchId: z.string().regex(/^ctm_[0-9a-f-]{36}$/),
  entryId: z.string().regex(/^cte_[0-9a-f-]{36}$/),
}).strict();

type TournamentRow = {
  id: string;
  host_user_id: string;
  title: string;
  entrants_count: number;
  rounds_total: number;
  current_round: number;
  round_duration_minutes: number;
  round_deadline: string;
  status: "live" | "completed" | "cancelled";
  champion_entry_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};
type EntryRow = {
  id: string;
  tournament_id: string;
  seed: number;
  product_id: string;
  public_product_id: string;
  title_snapshot: string;
  source_external_id: string;
};
type MatchRow = {
  id: string;
  tournament_id: string;
  round_number: number;
  slot: number;
  entry_a_id: string;
  entry_b_id: string;
  status: "open" | "closed";
  winner_entry_id: string | null;
  final_a: number | null;
  final_b: number | null;
  opened_at: string;
  closes_at: string;
  closed_at: string | null;
  a_votes: number;
  b_votes: number;
};
function dbTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}
function safeTime(iso: string): number {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) throw new ApiError(409, "Tournament deadline is invalid.");
  return value;
}
function isOpen(t: TournamentRow): boolean {
  return t.status === "live" && safeTime(t.round_deadline) > Date.now();
}
async function publicTournament(db: DB, id: string): Promise<TournamentRow> {
  const row = await db.prepare(
    \`SELECT t.* FROM community_tournaments t
     JOIN social_profiles sp ON sp.user_id=t.host_user_id
     JOIN auth_accounts a ON a.app_id=t.host_user_id AND a.disabled_at IS NULL
     WHERE t.id=? AND t.status<>'cancelled'
       AND sp.profile_visibility='public' AND sp.activity_visibility='public'\`
  ).bind(id).first<TournamentRow>();
  if (!row) throw new ApiError(404, "Tournament not found.");
  return row;
}
async function tournamentDetail(db: DB, id: string, viewer: string | null) {
  const tournament = await publicTournament(db, id);
  const [entryResult, matchResult] = await Promise.all([
    db.prepare(
      "SELECT * FROM community_tournament_entries WHERE tournament_id=? ORDER BY seed"
    ).bind(id).all<EntryRow>(),
    db.prepare(
      \`SELECT m.*,
        (SELECT COUNT(*) FROM community_tournament_votes v
          WHERE v.match_id=m.id AND v.entry_id=m.entry_a_id) AS a_votes,
        (SELECT COUNT(*) FROM community_tournament_votes v
          WHERE v.match_id=m.id AND v.entry_id=m.entry_b_id) AS b_votes
       FROM community_tournament_matches m
       WHERE m.tournament_id=? ORDER BY m.round_number,m.slot\`
    ).bind(id).all<MatchRow>(),
  ]);
  const entries = entryResult.results;
  const matches = matchResult.results;
  const mine = viewer && matches.length
    ? (await db.prepare(
      \`SELECT v.match_id,v.entry_id FROM community_tournament_votes v
       JOIN community_tournament_matches m ON m.id=v.match_id
       WHERE m.tournament_id=? AND v.user_id=?\`
    ).bind(id, viewer).all<{ match_id: string; entry_id: string }>()).results
    : [];
  const selections = new Map(mine.map((vote) => [vote.match_id, vote.entry_id]));
  return {
    id: tournament.id,
    title: tournament.title,
    status: tournament.status,
    currentRound: Number(tournament.current_round),
    roundsTotal: Number(tournament.rounds_total),
    roundDeadline: tournament.round_deadline,
    roundDurationMinutes: Number(tournament.round_duration_minutes),
    championEntryId: tournament.champion_entry_id,
    version: Number(tournament.version),
    createdAt: tournament.created_at,
    entries: entries.map((entry) => ({
      id: entry.id,
      seed: Number(entry.seed),
      productId: entry.public_product_id,
      title: entry.title_snapshot,
      sourceExternalId: entry.source_external_id,
    })),
    matches: matches.map((match) => ({
      id: match.id,
      round: Number(match.round_number),
      slot: Number(match.slot),
      entryAId: match.entry_a_id,
      entryBId: match.entry_b_id,
      status: match.status,
      winnerEntryId: match.winner_entry_id,
      aVotes: match.status === "closed" ? Number(match.final_a) : Number(match.a_votes),
      bVotes: match.status === "closed" ? Number(match.final_b) : Number(match.b_votes),
      myEntryId: selections.get(match.id) || null,
      closesAt: match.closes_at,
      closedAt: match.closed_at,
    })),
  };
}
async function validatedBooks(db: DB, ids: string[]) {
  const books: { id: string; publicId: string; title: string; externalId: string }[] = [];
  for (const ref of ids) {
    const book = await db.prepare(
      \`SELECT p.id,p.public_id,e.title,p.source_external_id
       FROM products p JOIN editions e ON e.id=p.edition_id
       WHERE p.id=? OR p.public_id=? LIMIT 1\`
    ).bind(ref, ref).first<{
      id: string; public_id: string | null; title: string;
      source_external_id: string | null;
    }>();
    if (!book) throw new ApiError(400, "Every bracket entrant must be an existing Cove book.");
    books.push({
      id: String(book.id),
      publicId: String(book.public_id || book.id),
      title: String(book.title || "Untitled").slice(0, 240),
      externalId: String(book.source_external_id || ""),
    });
  }
  if (new Set(books.map((b) => b.id)).size !== books.length)
    throw new ApiError(400, "Tournament entrants must be four distinct books.");
  return books;
}
async function createTournament(db: DB, actor: string, payload: z.infer<typeof createSchema>) {
  const profile = await db.prepare(
    "SELECT profile_visibility,activity_visibility FROM social_profiles WHERE user_id=?"
  ).bind(actor).first<{ profile_visibility: string; activity_visibility: string }>();
  if (profile?.profile_visibility !== "public" || profile.activity_visibility !== "public")
    throw new ApiError(403, "Make your profile and activity public before hosting a tournament.");
  const books = await validatedBooks(db, payload.productIds);
  const id = newId("ct"), started = now();
  const deadline = dbTime(Date.parse(started) + payload.roundDurationMinutes * 60_000);
  const entries = books.map((book, i) => ({ ...book, entryId: newId("cte"), seed: i + 1 }));
  // D1 batch is transactional. Never publish a tournament with missing entrants.
  await db.batch([
    db.prepare(
      \`INSERT INTO community_tournaments
       (id,host_user_id,title,entrants_count,rounds_total,current_round,
        round_duration_minutes,round_deadline,status,version,created_at,updated_at)
       VALUES(?,?,?,?,2,1,?,?,'live',1,?,?)\`
    ).bind(id, actor, payload.title, entries.length, payload.roundDurationMinutes, deadline, started, started),
    ...entries.map((book) => db.prepare(
      \`INSERT INTO community_tournament_entries
       (id,tournament_id,seed,product_id,public_product_id,title_snapshot,source_external_id)
       VALUES(?,?,?,?,?,?,?)\`
    ).bind(book.entryId, id, book.seed, book.id, book.publicId, book.title, book.externalId)),
    ...[0, 1].map((slot) => db.prepare(
      \`INSERT INTO community_tournament_matches
       (id,tournament_id,round_number,slot,entry_a_id,entry_b_id,status,opened_at,closes_at)
       VALUES(?,?,1,?,?,?,'open',?,?)\`
    ).bind(newId("ctm"), id, slot + 1, entries[slot * 2].entryId, entries[slot * 2 + 1].entryId, started, deadline)),
  ]);
  return tournamentDetail(db, id, actor);
}
async function castVote(db: DB, id: string, actor: string, input: z.infer<typeof voteSchema>) {
  const tournament = await publicTournament(db, id);
  if (!isOpen(tournament)) throw new ApiError(409, "This round has closed.");
  const match = await db.prepare(
    \`SELECT id,entry_a_id,entry_b_id,status,round_number FROM community_tournament_matches
     WHERE id=? AND tournament_id=?\`
  ).bind(input.matchId, id).first<MatchRow>();
  if (!match || match.status !== "open" ||
      Number(match.round_number) !== Number(tournament.current_round) ||
      ![match.entry_a_id, match.entry_b_id].includes(input.entryId))
    throw new ApiError(400, "Choose a contender in the active round.");
  const at = now();
  try {
    // One upsert per reader per match. The SQL triggers independently reject
    // late votes, wrong entrants, and voting after an advancement.
    await db.prepare(
      \`INSERT INTO community_tournament_votes(match_id,user_id,entry_id,created_at,updated_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(match_id,user_id) DO UPDATE SET entry_id=excluded.entry_id,
       updated_at=excluded.updated_at\`
    ).bind(match.id, actor, input.entryId, at, at).run();
  } catch (error) {
    if (String(error).includes("tournament_vote_closed_or_invalid"))
      throw new ApiError(409, "This match has closed or your selection is invalid.");
    throw error;
  }
  return tournamentDetail(db, id, actor);
}
async function advanceTournament(db: DB, id: string): Promise<boolean> {
  const t = await db.prepare(
    "SELECT * FROM community_tournaments WHERE id=?"
  ).bind(id).first<TournamentRow>();
  if (!t || t.status !== "live" || safeTime(t.round_deadline) > Date.now()) return false;
  const round = Number(t.current_round);
  const matches = (await db.prepare(
    \`SELECT m.* FROM community_tournament_matches m
     WHERE m.tournament_id=? AND m.round_number=?
     ORDER BY m.slot\`
  ).bind(id, round).all<MatchRow>()).results;
  const expected = Number(t.entrants_count) / Math.pow(2, round);
  if (matches.length !== expected || matches.some((m) => m.status !== "open"))
    throw new ApiError(409, "Tournament round state is incomplete.");
  const ballots = (await db.prepare(
    \`SELECT v.match_id,v.entry_id,COUNT(*) AS votes
     FROM community_tournament_votes v
     JOIN community_tournament_matches m ON m.id=v.match_id
     WHERE m.tournament_id=? AND m.round_number=?
     GROUP BY v.match_id,v.entry_id\`
  ).bind(id, round).all<{ match_id: string; entry_id: string; votes: number }>()).results;
  const totals = new Map(ballots.map((b) => [b.match_id + ":" + b.entry_id, Number(b.votes)]));
  const seeds = (await db.prepare(
    "SELECT id,seed FROM community_tournament_entries WHERE tournament_id=?"
  ).bind(id).all<{ id: string; seed: number }>()).results;
  const seed = new Map(seeds.map((entry) => [entry.id, Number(entry.seed)]));
  const resolved = matches.map((match) => {
    const aVotes = totals.get(match.id + ":" + match.entry_a_id) || 0;
    const bVotes = totals.get(match.id + ":" + match.entry_b_id) || 0;
    // The published deterministic tie policy is lower seed (including 0:0).
    const winnerId = aVotes === bVotes
      ? ((seed.get(match.entry_a_id) || 99) < (seed.get(match.entry_b_id) || 99)
        ? match.entry_a_id : match.entry_b_id)
      : aVotes > bVotes ? match.entry_a_id : match.entry_b_id;
    return { match, aVotes, bVotes, winnerId };
  });
  const done = round === Number(t.rounds_total);
  const at = now();
  const nextRound = round + (done ? 0 : 1);
  const nextDeadline = done ? t.round_deadline
    : dbTime(Date.now() + Number(t.round_duration_minutes) * 60_000);
  const nextMatches = done ? [] : Array.from({ length: resolved.length / 2 }, (_, i) => ({
    id: newId("ctm"), slot: i + 1,
    a: resolved[i * 2].winnerId, b: resolved[i * 2 + 1].winnerId,
  }));
  // Optimistic tournament CAS followed by closed match snapshots and next
  // pairings, all in one atomic D1 batch. If another request wins the CAS,
  // the guarded statements remain no-ops and UNIQUE slots prevent duplication.
  const writes = [
    db.prepare(
      \`UPDATE community_tournaments
       SET current_round=?,round_deadline=?,status=?,champion_entry_id=?,
           version=version+1,updated_at=?
       WHERE id=? AND version=? AND current_round=? AND status='live'
         AND round_deadline<=?\`
    ).bind(nextRound, nextDeadline, done ? "completed" : "live",
      done ? resolved[0].winnerId : null, at, id, t.version, round, at),
    ...resolved.map(({ match, aVotes, bVotes, winnerId }) => db.prepare(
      \`UPDATE community_tournament_matches
       SET status='closed',winner_entry_id=?,final_a=?,final_b=?,closed_at=?
       WHERE id=? AND status='open' AND EXISTS(
         SELECT 1 FROM community_tournaments t WHERE t.id=?
           AND t.version=? AND t.current_round=?)\`
    ).bind(winnerId, aVotes, bVotes, at, match.id, id, Number(t.version) + 1, nextRound)),
    ...nextMatches.map((match) => db.prepare(
      \`INSERT OR IGNORE INTO community_tournament_matches
       (id,tournament_id,round_number,slot,entry_a_id,entry_b_id,status,opened_at,closes_at)
       SELECT ?,id,?,?,?,?,'open',updated_at,round_deadline
       FROM community_tournaments
       WHERE id=? AND version=? AND current_round=? AND status='live'\`
    ).bind(match.id, nextRound, match.slot, match.a, match.b, id, Number(t.version) + 1, nextRound)),
  ];
  const results = await db.batch(writes);
  const changed = Number(results[0]?.meta?.changes || 0);
  return changed > 0;
}
/** Run from the existing backend's social scheduled queue, never from a GET. */
export async function advanceDueTournaments(db: DB, limit = 5): Promise<number> {
  const due = (await db.prepare(
    \`SELECT id FROM community_tournaments WHERE status='live'
     AND round_deadline<=? ORDER BY round_deadline,id LIMIT ?\`
  ).bind(now(), Math.max(1, Math.min(limit, 10))).all<{ id: string }>()).results;
  let advanced = 0;
  for (const row of due) if (await advanceTournament(db, row.id)) advanced++;
  return advanced;
}

export async function handleCommunityTournaments(
  request: Request, env: CoveEnv, path: string, userId: string | null,
): Promise<Response | null> {
  if (path !== "/social/tournaments" && !tournamentPath.test(path)) return null;
  const db = env.DB, method = request.method;
  if (path === "/social/tournaments" && method === "GET") {
    const ids = (await db.prepare(
      \`SELECT t.id FROM community_tournaments t
       JOIN social_profiles sp ON sp.user_id=t.host_user_id
       JOIN auth_accounts a ON a.app_id=t.host_user_id AND a.disabled_at IS NULL
       WHERE t.status<>'cancelled' AND sp.profile_visibility='public'
         AND sp.activity_visibility='public'
       ORDER BY CASE WHEN t.status='live' THEN 0 ELSE 1 END,t.created_at DESC
       LIMIT 8\`
    ).all<{ id: string }>()).results;
    return json({ items: await Promise.all(ids.map((t) => tournamentDetail(db, t.id, userId))) });
  }
  if (path === "/social/tournaments" && method === "POST") {
    const actor = requireIdentity(userId);
    await rateLimit(env, "tournament-create:" + actor, 4);
    const payload = createSchema.parse(await readBody(request));
    return json(await createTournament(db, actor, payload), 201);
  }
  const match = tournamentPath.exec(path);
  if (!match) return null;
  const [, tournamentId, action] = match;
  if (method === "GET" && !action)
    return json(await tournamentDetail(db, tournamentId, userId));
  if (method === "POST" && action === "vote") {
    const actor = requireIdentity(userId);
    await rateLimit(env, "tournament-vote:" + actor, 120);
    return json(await castVote(db, tournamentId, actor, voteSchema.parse(await readBody(request))));
  }
  if (method === "POST" && action === "advance") {
    await rateLimit(env, "tournament-advance:" + tournamentId, 25);
    await publicTournament(db, tournamentId);
    const advanced = await advanceTournament(db, tournamentId);
    return json({ advanced, tournament: await tournamentDetail(db, tournamentId, userId) });
  }
  throw new ApiError(405, "Tournament operation not supported.");
}
