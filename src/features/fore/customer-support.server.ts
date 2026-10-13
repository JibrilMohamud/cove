import { z } from "zod";
import type { CoveEnv } from "./api.server";
import { ApiError, now } from "./service";

type DB = CoveEnv["DB"];
type Ticket = {
  id: string;
  user_id: string;
  order_id: string | null;
  category: string;
  subject: string;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
  last_read_at: string | null;
  request_reference: string | null;
};
type Message = { id: string; sender_kind: "customer" | "staff"; body: string; created_at: string };
const key = z.string().uuid();
const states = z.enum(["open", "pending_customer", "pending_internal", "resolved", "closed"]);
const digest = async (value: unknown) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const publicTicket = (row: Ticket) => ({
  id: row.id,
  orderId: row.order_id,
  category: row.category,
  subject: row.subject,
  status: row.status,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  requestId: row.request_reference,
});

async function ticketRow(db: DB, id: string, userId?: string): Promise<Ticket> {
  const row = await db
    .prepare(`SELECT * FROM customer_support_tickets WHERE id=?${userId ? " AND user_id=?" : ""}`)
    .bind(id, ...(userId ? [userId] : []))
    .first<Ticket>();
  if (!row) throw new ApiError(404, "Support request not found.");
  return row;
}

export async function supportInbox(db: DB, userId?: string, cursor?: string | null) {
  let after: Ticket | null = null;
  if (cursor) after = await ticketRow(db, cursor, userId);
  const rows = await db
    .prepare(
      `SELECT t.*,EXISTS(SELECT 1 FROM customer_support_messages m WHERE m.ticket_id=t.id AND m.sender_kind='staff'
      AND m.expected_version>t.last_read_version) unread
    FROM customer_support_tickets t WHERE ${userId ? "t.user_id=?" : "1=1"}
      ${after ? "AND (t.updated_at<? OR (t.updated_at=? AND t.id<?))" : ""}
    ORDER BY t.updated_at DESC,t.id DESC LIMIT 26`,
    )
    .bind(
      ...(userId ? [userId] : []),
      ...(after ? [after.updated_at, after.updated_at, after.id] : []),
    )
    .all<Ticket & { unread: number }>();
  const page = rows.results.slice(0, 25);
  return {
    tickets: page.map((row) => ({
      ...publicTicket(row),
      unread: Boolean(row.unread),
      ...(!userId ? { userId: row.user_id } : {}),
    })),
    nextCursor: rows.results.length > 25 ? page.at(-1)?.id : null,
  };
}

export async function supportThread(db: DB, id: string, userId?: string, before?: string | null) {
  const ticket = await ticketRow(db, id, userId);
  const older = before
    ? await db
        .prepare(
          "SELECT expected_version FROM customer_support_messages WHERE id=? AND ticket_id=?",
        )
        .bind(before, id)
        .first<{ expected_version: number }>()
    : null;
  if (before && !older) throw new ApiError(404, "Conversation page not found.");
  const rows = await db
    .prepare(
      `SELECT id,sender_kind,body,created_at FROM customer_support_messages WHERE ticket_id=?
    ${older ? "AND expected_version<?" : ""} ORDER BY expected_version DESC LIMIT 101`,
    )
    .bind(id, ...(older ? [older.expected_version] : []))
    .all<Message>();
  const page = rows.results.slice(0, 100).reverse();
  return {
    ticket: publicTicket(ticket),
    messages: page.map((row) => ({
      id: row.id,
      sender: row.sender_kind,
      body: row.body,
      createdAt: row.created_at,
    })),
    nextBefore: rows.results.length > 100 ? page[0]?.id : null,
  };
}

export async function createCustomerSupport(db: DB, userId: string, raw: unknown) {
  const x = z
    .object({
      requestKey: key,
      category: z.enum(["billing", "refund", "download", "account", "reading", "other"]),
      subject: z.string().trim().min(3).max(180),
      message: z.string().trim().min(10).max(6000),
      orderId: z.string().min(1).max(240).nullable().optional(),
      requestId: z.string().max(100).optional(),
    })
    .strict()
    .parse(raw);
  const fingerprint = await digest({
    category: x.category,
    subject: x.subject,
    message: x.message,
    orderId: x.orderId || null,
    requestId: x.requestId || "",
  });
  const prior = await db
    .prepare(
      "SELECT id,creation_sha256 FROM customer_support_tickets WHERE user_id=? AND creation_key=?",
    )
    .bind(userId, x.requestKey)
    .first<{ id: string; creation_sha256: string }>();
  if (prior) {
    if (prior.creation_sha256 !== fingerprint)
      throw new ApiError(409, "This submission key was used for a different request.");
    return supportThread(db, prior.id, userId);
  }
  if (
    x.orderId &&
    !(await db
      .prepare("SELECT id FROM commerce_orders WHERE id=? AND user_id=?")
      .bind(x.orderId, userId)
      .first())
  )
    throw new ApiError(404, "Order not found in your account.");
  const open = await db
    .prepare(
      "SELECT count(*) count FROM customer_support_tickets WHERE user_id=? AND status NOT IN ('resolved','closed')",
    )
    .bind(userId)
    .first<{ count: number }>();
  if (Number(open?.count || 0) >= 10)
    throw new ApiError(
      409,
      "You have ten open requests. Reply to an existing request for the same issue.",
    );
  const id = `help_${crypto.randomUUID()}`,
    at = now();
  const body = x.message;
  await db
    .batch([
      db
        .prepare(
          "INSERT INTO customer_support_tickets(id,user_id,order_id,category,subject,creation_key,creation_sha256,created_at,updated_at,request_reference) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          id,
          userId,
          x.orderId || null,
          x.category,
          x.subject,
          x.requestKey,
          fingerprint,
          at,
          at,
          x.requestId || null,
        ),
      db
        .prepare(
          "INSERT INTO customer_support_messages(id,ticket_id,sender_kind,sender_id,body,request_key,content_sha256,expected_version,created_at) VALUES(?,?,'customer',?,?,?,?,1,?)",
        )
        .bind(`msg_${crypto.randomUUID()}`, id, userId, body, x.requestKey, fingerprint, at),
      db.prepare("UPDATE customer_support_tickets SET version=2 WHERE id=?").bind(id),
    ])
    .catch(async (error: unknown) => {
      // A simultaneous retry may win the unique key between the read and batch.
      const winner = await db
        .prepare(
          "SELECT creation_sha256 FROM customer_support_tickets WHERE user_id=? AND creation_key=?",
        )
        .bind(userId, x.requestKey)
        .first<{ creation_sha256: string }>();
      if (!winner || winner.creation_sha256 !== fingerprint) {
        if (String(error).includes("customer support open limit"))
          throw new ApiError(
            409,
            "Reply to an existing open request before creating more requests.",
          );
        throw error;
      }
    });
  const saved = await db
    .prepare("SELECT id FROM customer_support_tickets WHERE user_id=? AND creation_key=?")
    .bind(userId, x.requestKey)
    .first<{ id: string }>();
  return supportThread(db, saved?.id || id, userId);
}

export async function replyCustomerSupport(
  db: DB,
  id: string,
  senderId: string,
  staff: boolean,
  raw: unknown,
) {
  const x = z
    .object({
      requestKey: key,
      expectedVersion: z.number().int().positive(),
      message: z.string().trim().min(1).max(6000),
      status: states.optional(),
    })
    .strict()
    .parse(raw);
  if (!staff && x.status) throw new ApiError(403, "Only support staff can change request status.");
  const ticket = await ticketRow(db, id, staff ? undefined : senderId);
  const fingerprint = await digest({ message: x.message, status: x.status || null });
  const prior = await db
    .prepare(
      "SELECT content_sha256 FROM customer_support_messages WHERE ticket_id=? AND sender_id=? AND request_key=?",
    )
    .bind(id, senderId, x.requestKey)
    .first<{ content_sha256: string }>();
  if (prior) {
    if (prior.content_sha256 !== fingerprint)
      throw new ApiError(409, "This reply key was used for a different message.");
    return supportThread(db, id, staff ? undefined : senderId);
  }
  if (ticket.version !== x.expectedVersion)
    throw new ApiError(409, "This conversation changed. Refresh it before replying.");
  if (!staff && ticket.status === "closed")
    throw new ApiError(409, "This request is closed. Open a new request if you still need help.");
  const at = now(),
    status = staff ? x.status || "pending_customer" : "open";
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO customer_support_messages(id,ticket_id,sender_kind,sender_id,body,request_key,content_sha256,expected_version,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          `msg_${crypto.randomUUID()}`,
          id,
          staff ? "staff" : "customer",
          senderId,
          x.message,
          x.requestKey,
          fingerprint,
          x.expectedVersion,
          at,
        ),
      db
        .prepare(
          "UPDATE customer_support_tickets SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?",
        )
        .bind(status, at, id, x.expectedVersion),
    ]);
  } catch (error) {
    const replay = await db
      .prepare(
        "SELECT content_sha256 FROM customer_support_messages WHERE ticket_id=? AND sender_id=? AND request_key=?",
      )
      .bind(id, senderId, x.requestKey)
      .first<{ content_sha256: string }>();
    if (replay?.content_sha256 === fingerprint)
      return supportThread(db, id, staff ? undefined : senderId);
    if (String(error).includes("customer support"))
      throw new ApiError(409, "This conversation changed. Refresh before replying.");
    throw error;
  }
  return supportThread(db, id, staff ? undefined : senderId);
}

export async function markSupportRead(db: DB, id: string, userId: string, raw: unknown) {
  const x = z.object({ viewedVersion: z.number().int().positive() }).strict().parse(raw);
  const ticket = await ticketRow(db, id, userId);
  if (x.viewedVersion > ticket.version) throw new ApiError(409, "Conversation version not found.");
  await db
    .prepare(
      "UPDATE customer_support_tickets SET last_read_at=?,last_read_version=MAX(last_read_version,?) WHERE id=? AND user_id=?",
    )
    .bind(now(), x.viewedVersion - 1, id, userId)
    .run();
  return { read: true };
}

export async function exportCustomerSupport(db: DB, userId: string) {
  const [tickets, messages] = await Promise.all([
    db
      .prepare("SELECT * FROM customer_support_tickets WHERE user_id=? ORDER BY created_at,id")
      .bind(userId)
      .all<Ticket>(),
    db
      .prepare(
        "SELECT m.id,m.ticket_id,m.sender_kind,m.body,m.created_at FROM customer_support_messages m JOIN customer_support_tickets t ON t.id=m.ticket_id WHERE t.user_id=? ORDER BY m.created_at,m.id",
      )
      .bind(userId)
      .all<Message & { ticket_id: string }>(),
  ]);
  return {
    tickets: tickets.results.map(publicTicket),
    messages: messages.results.map((row) => ({
      id: row.id,
      ticketId: row.ticket_id,
      sender: row.sender_kind,
      body: row.body,
      createdAt: row.created_at,
    })),
  };
}
