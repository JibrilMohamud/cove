/**
 * Isolated-QA-only D1 read transport for a caller with NO native D1 binding.
 *
 * This is a constrained transport prototype, NOT production authorization.
 * Production has no enrolled route, rollout flag, or acceptable synthetic QA
 * owner lease. The actual legal-owner handler must independently apply the
 * private QA lease to serveQaOwnerPrimaryRead; never expose it publicly.
 *
 * No SQL writes, raw handles or arbitrary D1 APIs. An opted-in
 * first-primary session carries an actual D1 bookmark issued by the leased
 * owner across consecutive requests, never a fabricated local session.
 * This is monotonic SQL consistency only: NOT a rights/withdrawal authority.
 * A separate owner denial fence is mandatory for any legal decision.
 */
export const QA_OWNER_PRIMARY_READ_SCHEMA = "cove.qa.owner-primary-read.v1";
export const QA_OWNER_PRIMARY_READ_ROUTE = "/qa/private-primary-read";
const MAX_OPS = 24;
const MAX_QUERY_CHARS = 16384;
const MAX_BODY_CHARS = 196608;
const MAX_RESULT_CHARS = 2_097_152;
const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const deny = () => {
  throw Error("qa_owner_read_denied");
};

function plainObject(x) {
  return (
    x !== null &&
    typeof x === "object" &&
    !Array.isArray(x) &&
    Object.getPrototypeOf(x) === Object.prototype
  );
}
function exactKeys(x, expected) {
  return plainObject(x) && Object.keys(x).sort().join(",") === expected.slice().sort().join(",");
}
export function checkedQaOwnerReadSql(sql) {
  if (typeof sql !== "string" || sql.length < 1 || sql.length > MAX_QUERY_CHARS) deny();
  // Read-only CTEs as well as SELECT are permitted in synthetic QA. Every
  // modifying verb, PRAGMA, comment or stacked SQL remains denied by the
  // same lexical gate. False positives must fail closed, never be waived.
  // This does not make a lexical parser a production SQL authorization.
  if (
    !/^\s*(SELECT|WITH)\b/i.test(sql) ||
    (/^\s*WITH\b/i.test(sql) && !/\bSELECT\b/i.test(sql)) ||
    /[;\u0000]/.test(sql) ||
    /--|\/\*|\*\//.test(sql) ||
    /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|ALTER|DROP|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|TRIGGER|LOAD_EXTENSION)\b/i.test(
      sql,
    )
  )
    deny();
  return sql;
}
export function checkedQaOwnerReadParams(params) {
  if (!Array.isArray(params) || params.length > 64) deny();
  for (const value of params) {
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (typeof value === "string" && value.length <= 8192) continue;
    deny();
  }
  return params;
}
function checkedOps(ops) {
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_OPS) deny();
  let total = 0;
  return ops.map((op) => {
    if (!exactKeys(op, ["sql", "params", "mode"]) || !["first", "all"].includes(op.mode)) deny();
    const sql = checkedQaOwnerReadSql(op.sql);
    const params = checkedQaOwnerReadParams(op.params);
    total += sql.length;
    if (total > MAX_BODY_CHARS) deny();
    return { sql, params, mode: op.mode };
  });
}
function json(body, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

/** Called only inside the separately leased QA legal owner, never from a
 * public Worker endpoint or production's disabled-authority exception. */
export async function serveQaOwnerPrimaryRead(request, primary, secret, qaLeaseLive) {
  if (qaLeaseLive !== true || !primary || typeof primary.prepare !== "function")
    return json({ error: "qa_owner_read_not_enrolled" }, 503);
  if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret))
    return json({ error: "qa_owner_read_secret_invalid" }, 503);
  if (request.headers.get("authorization") !== "Bearer " + secret)
    return json({ error: "qa_owner_read_unauthorized" }, 401);
  if (new URL(request.url).pathname !== QA_OWNER_PRIMARY_READ_ROUTE)
    return json({ error: "qa_owner_read_not_found" }, 404);
  if (
    request.method !== "POST" ||
    request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
  )
    return json({ error: "qa_owner_read_method_denied" }, 405);
  let input;
  try {
    const body = await request.text();
    if (body.length > MAX_BODY_CHARS) return json({ error: "qa_owner_read_too_large" }, 413);
    input = JSON.parse(body);
    const sessionMode = exactKeys(input, ["schema", "ops", "session"]);
    if (
      (!sessionMode && !exactKeys(input, ["schema", "ops"])) ||
      input.schema !== QA_OWNER_PRIMARY_READ_SCHEMA
    )
      return json({ error: "qa_owner_read_bad_schema" }, 400);
    const ops = checkedOps(input.ops);
    let active = primary;
    if (sessionMode) {
      const session = input.session;
      if (
        !exactKeys(session, ["mode", "bookmark"]) ||
        session.mode !== "first-primary" ||
        !(
          session.bookmark === null ||
          (typeof session.bookmark === "string" &&
            session.bookmark.length > 0 &&
            session.bookmark.length <= 1024 &&
            /^[a-zA-Z0-9+/_:=.-]+$/.test(session.bookmark) &&
            session.bookmark !== "first-unconstrained" &&
            session.bookmark !== "first-primary")
        ) ||
        typeof primary.withSession !== "function"
      )
        return json({ error: "qa_owner_read_session_denied" }, 400);
      active = primary.withSession(session.bookmark ?? "first-primary");
      if (
        !active ||
        typeof active.prepare !== "function" ||
        typeof active.getBookmark !== "function"
      )
        return json({ error: "qa_owner_read_session_unavailable" }, 503);
    }
    const statements = ops.map((op) => active.prepare(op.sql).bind(...op.params));
    const result = [];
    // D1 batch is used only for all() statements. A mixed batch must not
    // masquerade as an atomic session: execute per-request and never claim a
    // transaction when calls need first()/all() shape parity.
    if (ops.length > 1) {
      if (ops.some((op) => op.mode !== "all") || typeof active.batch !== "function")
        return json({ error: "qa_owner_read_mixed_batch_denied" }, 400);
      const batch = await active.batch(statements);
      if (!Array.isArray(batch) || batch.length !== ops.length)
        return json({ error: "qa_owner_read_result_mismatch" }, 503);
      result.push(...batch);
    } else {
      const statement = statements[0];
      result.push(ops[0].mode === "first" ? await statement.first() : await statement.all());
    }
    const bookmark = sessionMode ? active.getBookmark() : null;
    if (
      sessionMode &&
      (typeof bookmark !== "string" ||
        bookmark.length < 1 ||
        bookmark.length > 1024 ||
        !/^[a-zA-Z0-9+/_:=.-]+$/.test(bookmark))
    )
      return json({ error: "qa_owner_read_bookmark_unavailable" }, 503);
    const output = JSON.stringify(
      sessionMode
        ? { schema: QA_OWNER_PRIMARY_READ_SCHEMA, result, bookmark }
        : { schema: QA_OWNER_PRIMARY_READ_SCHEMA, result },
    );
    if (output.length > MAX_RESULT_CHARS)
      return json({ error: "qa_owner_read_result_too_large" }, 503);
    return new Response(output, {
      status: 200,
      headers: { ...NO_STORE, "content-type": "application/json" },
    });
  } catch {
    return json({ error: "qa_owner_read_failed_closed" }, 503);
  }
}

export function createQaOwnerReadOnlyD1(owner, secret) {
  if (
    typeof owner?.fetch !== "function" ||
    typeof secret !== "string" ||
    !/^[a-f0-9]{64}$/.test(secret)
  )
    deny();

  function makeFacade(session) {
    const issued = new WeakMap();
    async function sendUnserialized(ops) {
      checkedOps(ops);
      if (session?.poisoned) deny();
      const body = {
        schema: QA_OWNER_PRIMARY_READ_SCHEMA,
        ops,
        ...(session ? { session: { mode: "first-primary", bookmark: session.bookmark } } : {}),
      };
      const response = await owner.fetch(
        new Request("https://cove-owner.internal" + QA_OWNER_PRIMARY_READ_ROUTE, {
          method: "POST",
          headers: {
            authorization: "Bearer " + secret,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
      if (
        !response ||
        response.status !== 200 ||
        response.headers.get("cache-control") !== "no-store"
      )
        deny();
      const reply = await response.text();
      if (reply.length > MAX_RESULT_CHARS) deny();
      let message;
      try {
        message = JSON.parse(reply);
      } catch {
        deny();
      }
      if (
        !exactKeys(message, session ? ["schema", "result", "bookmark"] : ["schema", "result"]) ||
        message.schema !== QA_OWNER_PRIMARY_READ_SCHEMA ||
        !Array.isArray(message.result) ||
        message.result.length !== ops.length
      )
        deny();
      if (session) {
        if (
          typeof message.bookmark !== "string" ||
          message.bookmark.length < 1 ||
          message.bookmark.length > 1024 ||
          !/^[a-zA-Z0-9+/_:=.-]+$/.test(message.bookmark) ||
          ["first-primary", "first-unconstrained"].includes(message.bookmark)
        )
          deny();
        // Only the owner-issued, independently received bookmark is allowed
        // to advance a remote logical session.
        session.bookmark = message.bookmark;
      }
      return message.result;
    }
    function send(ops) {
      if (!session) return sendUnserialized(ops);
      // Without serialization, two overlapping calls could reuse a stale
      // bookmark and acknowledge a logically inconsistent session.
      const attempt = session.tail.then(() => sendUnserialized(ops));
      session.tail = attempt.then(
        () => undefined,
        () => {
          // A timeout or lost acknowledgment cannot restart a session from
          // an older bookmark and claim monotonicity.
          session.poisoned = true;
        },
      );
      return attempt;
    }
    function prepared(sql, params) {
      checkedQaOwnerReadSql(sql);
      checkedQaOwnerReadParams(params);
      const receipt = Object.freeze({
        bind(...values) {
          return prepared(sql, values);
        },
        async first() {
          return (await send([{ mode: "first", sql, params }]))[0];
        },
        async all() {
          const value = (await send([{ mode: "all", sql, params }]))[0];
          if (!value || typeof value !== "object" || !Array.isArray(value.results)) deny();
          return value;
        },
        run: deny,
        raw: deny,
      });
      issued.set(receipt, { mode: "all", sql, params });
      return receipt;
    }
    return Object.freeze({
      prepare(sql) {
        return prepared(sql, []);
      },
      async batch(statements) {
        if (!Array.isArray(statements) || statements.length < 1 || statements.length > MAX_OPS)
          deny();
        const ops = statements.map((statement) => {
          if (!statement || typeof statement !== "object") deny();
          const op = issued.get(statement);
          if (!op) deny();
          return op;
        });
        return send(ops);
      },
      withSession(mode) {
        if (session || mode !== "first-primary") deny();
        return makeFacade({ bookmark: null, poisoned: false, tail: Promise.resolve() });
      },
      ...(session
        ? {
            getBookmark() {
              return session.bookmark;
            },
          }
        : {}),
      exec: deny,
    });
  }
  return makeFacade(null);
}
