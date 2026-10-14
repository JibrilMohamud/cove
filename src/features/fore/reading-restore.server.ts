import { z } from "zod";
import type { CoveEnv } from "./api.server";
import { ApiError, now } from "./service";

type DB = CoveEnv["DB"];
const uuid = z.string().uuid();
const timestamp = z.string().datetime();
const sourceId = z.string().min(1).max(120);
const annotation = z.object({
  id: uuid,
  book_id: sourceId,
  quote: z.string().min(1).max(12000),
  cfi: z.string().min(1).max(3000),
  chapter: z.string().max(300).default(""),
  color: z.enum(["yellow", "green", "blue", "pink", "purple"]).default("yellow"),
  note: z.string().max(12000).default(""),
  created_at: timestamp,
});
const definition = z.object({
  id: uuid,
  book_id: sourceId,
  word: z.string().min(1).max(100),
  phonetic: z.string().max(200).nullable().optional(),
  meaning: z.string().min(1).max(5000),
  part_of_speech: z.string().max(60).nullable().optional(),
  cfi: z.string().max(3000).nullable().optional(),
  context: z.string().max(12000).nullable().optional(),
  source: z.string().max(500).nullable().optional(),
  created_at: timestamp,
});
const state = z.object({
  product_id: sourceId.optional(),
  external_book_id: sourceId,
  status: z.enum(["want-to-read", "reading", "finished"]),
  progress: z.number().min(0).max(1),
  cfi: z.string().max(3000).default(""),
  updated_at: timestamp,
});
const session = z.object({
  id: uuid,
  book_id: sourceId,
  mode: z.enum(["read", "listen"]),
  started_at: timestamp,
  ended_at: timestamp,
  active_seconds: z.number().int().min(0).max(21600),
  words_read: z.number().int().min(0).max(250000),
});
const metric = z.object({
  book_id: sourceId,
  word_count: z.number().int().min(0).max(20000000),
  reading_level: z.number().min(-20).max(100).nullable(),
  language: z.string().min(2).max(10),
});
const goal = z.object({
  year: z.number().int().min(2000).max(2200),
  books: z.number().int().min(1).max(1000),
});
const backupSchema = z.object({
  schema: z.literal("fore-account-export").optional(),
  format: z.literal("fore-reading-data").optional(),
  version: z.number().int().min(2).max(4),
  reading: z.object({
    states: z.array(state).max(250).default([]),
    annotations: z.array(annotation).max(500).default([]),
    definitions: z.array(definition).max(500).default([]),
    sessions: z.array(session).max(500).default([]),
    bookMetrics: z.array(metric).max(250).default([]),
    goals: z.array(goal).max(40).default([]),
  }).optional(),
  bookId: sourceId.optional(),
  readingState: state.partial().nullable().optional(),
  annotations: z.array(annotation).max(500).optional(),
  definitions: z.array(definition).max(500).optional(),
  sessions: z.array(session).max(500).optional(),
});
type Backup = z.infer<typeof backupSchema>;
type RestoreRow = { kind: string; bookId: string; value: any };

async function allowedProduct(db: DB, userId: string, ref: string) {
  const p = await db
    .prepare(
      "SELECT id,public_id,source_external_id,source_name FROM products WHERE id=? OR public_id=? OR source_external_id=? LIMIT 1",
    )
    .bind(ref, ref, ref)
    .first<{ id: string; public_id: string | null; source_external_id: string; source_name: string }>();
  if (!p) return null;
  if (p.source_name === "gutenberg") return p;
  // Imports must belong to this user; licensed editions require current active access.
  const owned = await db
    .prepare(
      "SELECT id FROM entitlements WHERE user_id=? AND product_id=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) LIMIT 1",
    )
    .bind(userId, p.id, now(), now())
    .first();
  return owned ? p : null;
}
export async function restoreReadingBackup(db: DB, userId: string, raw: unknown) {
  const input = z
    .object({
      dryRun: z.boolean(),
      confirm: z.literal(true).optional(),
      backup: backupSchema,
    })
    .parse(raw);
  if (!input.dryRun && !input.confirm)
    throw new ApiError(400, "Preview the import and confirm before restoring data.");
  const payload: Backup = input.backup;
  if (!payload.schema && !payload.format)
    throw new ApiError(400, "Unrecognized Cove backup format.");
  const reading = payload.reading || {
    states: payload.readingState?.external_book_id
      ? [state.parse(payload.readingState)]
      : [],
    annotations: payload.annotations || [],
    definitions: payload.definitions || [],
    sessions: payload.sessions || [],
    bookMetrics: [],
    goals: [],
  };
  const rows: RestoreRow[] = [
    ...reading.states.map((value) => ({ kind: "position", bookId: value.external_book_id, value })),
    ...reading.annotations.map((value) => ({ kind: "annotation", bookId: value.book_id, value })),
    ...reading.definitions.map((value) => ({ kind: "definition", bookId: value.book_id, value })),
    ...reading.sessions.map((value) => ({ kind: "session", bookId: value.book_id, value })),
    ...reading.bookMetrics.map((value) => ({ kind: "metric", bookId: value.book_id, value })),
  ];
  const products = new Map<string, Awaited<ReturnType<typeof allowedProduct>>>();
  for (const ref of new Set(rows.map((row) => row.bookId)))
    products.set(ref, await allowedProduct(db, userId, ref));
  const eligible = rows.filter((row) => !!products.get(row.bookId));
  const skipped = rows.length - eligible.length;
  const report = {
    total: rows.length + reading.goals.length,
    eligible: eligible.length + reading.goals.length,
    skipped,
    counts: Object.fromEntries(
      ["position", "annotation", "definition", "session", "metric", "goal"].map((kind) => [
        kind,
        kind === "goal"
          ? reading.goals.length
          : eligible.filter((row) => row.kind === kind).length,
      ]),
    ),
    mode: input.dryRun ? "preview" : "applied",
    policy: "Only personal reading data is imported; purchases, licenses, identity and billing are never restored.",
  };
  if (input.dryRun) return report;
  const statements: ReturnType<DB["prepare"]>[] = [];
  const at = now();
  for (const row of eligible) {
    const p = products.get(row.bookId)!;
    const v = row.value;
    if (row.kind === "position") {
      statements.push(db.prepare(
        "INSERT OR IGNORE INTO reading_states(user_id,product_id,external_book_id,in_library,status,progress,cfi,legacy_shelves_json,review_migrated,updated_at,version) VALUES(?,?,?,1,?,?,?,'[]',0,?,1)",
      ).bind(userId,p.id,p.source_external_id,v.status,v.progress,v.cfi,v.updated_at));
    } else if (row.kind === "annotation") {
      statements.push(db.prepare(
        "INSERT OR IGNORE INTO annotations(id,user_id,book_id,book_title,author,quote,cfi,chapter,color,note,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,1)",
      ).bind(v.id,userId,p.source_external_id,"Restored book","",v.quote,v.cfi,v.chapter,v.color,v.note,v.created_at,at));
    } else if (row.kind === "definition") {
      statements.push(db.prepare(
        "INSERT OR IGNORE INTO definitions(id,user_id,word,phonetic,meaning,part_of_speech,book_id,book_title,cfi,context,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(v.id,userId,v.word,v.phonetic||"",v.meaning,v.part_of_speech||"",p.source_external_id,"Restored book",v.cfi||"",v.context||"",v.source||"backup",v.created_at));
    } else if (row.kind === "session") {
      const start = Date.parse(v.started_at), end = Date.parse(v.ended_at);
      if (start > end || end > Date.now() + 60000 || v.active_seconds > (end-start)/1000 + 2)
        throw new ApiError(400, "Backup contains invalid session timing.");
      statements.push(db.prepare(
        "INSERT OR IGNORE INTO reading_sessions(id,user_id,book_id,mode,started_at,ended_at,active_seconds,words_read) VALUES(?,?,?,?,?,?,?,?)",
      ).bind(v.id,userId,p.source_external_id,v.mode,v.started_at,v.ended_at,v.active_seconds,v.words_read));
    } else if (row.kind === "metric") {
      statements.push(db.prepare(
        "INSERT OR IGNORE INTO book_metrics(user_id,book_id,word_count,reading_level,language,method,updated_at) VALUES(?,?,?,?,?,'backup-import',?)",
      ).bind(userId,p.source_external_id,v.word_count,v.reading_level,v.language,at));
    }
  }
  for (const g of reading.goals) {
    statements.push(db.prepare(
      "INSERT OR IGNORE INTO reading_goals(user_id,year,books) VALUES(?,?,?)",
    ).bind(userId,g.year,g.books));
  }
  // D1's batch transaction is atomic: no partial account imports on a failed statement.
  for (let i = 0; i < statements.length; i += 50)
    await db.batch(statements.slice(i, i + 50));
  return report;
}
