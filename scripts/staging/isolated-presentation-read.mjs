import assert from "node:assert/strict";
import {
  checkedQaOwnerReadSql,
  checkedQaOwnerReadParams,
} from "../../src/storefront-strangler/qa-owner-primary-read-transport.mjs";
import { requireIsolatedCatalogSnapshotTarget } from "../performance/real-catalog-snapshot-safety.mjs";
import { retryAfterDelayMs } from "../release/protected-d1-read-throttle.mjs";

/** Control-plane preparation only. Never used by a serving request or a timed
 * acceptance sample. All attempts are SELECT-only against the isolated copy. */
export function createIsolatedPresentationReader({
  readToken,
  source,
  sourceName,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onDiagnostic = (event) => console.warn(JSON.stringify(event)),
}) {
  const target = requireIsolatedCatalogSnapshotTarget(source, sourceName);
  assert.ok(typeof readToken === "string" && readToken.length >= 20);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9/d1/database/${target.id}/query`;
  let requests = 0;
  async function query(sql, params) {
    checkedQaOwnerReadSql(sql);
    checkedQaOwnerReadParams(params);
    for (let attempt = 0; attempt < 4; attempt++) {
      assert.ok(++requests <= 128, "Isolated presentation preparation request budget exhausted");
      let response, body;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          redirect: "error",
          headers: { authorization: "Bearer " + readToken, "content-type": "application/json" },
          body: JSON.stringify({ sql, params }),
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        // Network/JSON failures do not prove provider throttling. Stop with
        // bounded diagnostics rather than leaking an error or guessing.
        const event = {
          event: "isolated_presentation_read_failure",
          httpStatus: 0,
          attempt: attempt + 1,
          failure: "transport",
          params: params.length,
          sqlChars: sql.length,
        };
        onDiagnostic(event);
        throw Error("Isolated presentation preparation failed: " + JSON.stringify(event));
      }
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const result = body?.result?.[0];
      if (response.ok && body?.success === true && result?.success === true) {
        assert.ok(Array.isArray(result.results), "Invalid isolated presentation rows");
        assert.equal(
          result.meta?.changed_db,
          false,
          "Isolated presentation SELECT changed its source",
        );
        assert.equal(result.meta?.changes, 0, "Isolated presentation SELECT reported writes");
        assert.equal(result.meta?.rows_written, 0, "Isolated presentation SELECT wrote rows");
        return result;
      }
      const errors = [
        ...(Array.isArray(body?.errors) ? body.errors : []),
        ...(Array.isArray(result?.errors) ? result.errors : []),
      ];
      const codes = [
        ...new Set(errors.map((error) => Number(error.code)).filter(Number.isSafeInteger)),
      ];
      const throttle =
        codes.includes(7429) ||
        errors.some((error) =>
          /(?:D1 DB is overloaded|Too many resources consumed within a 10 second window|\bcode:\s*7429\b)/i.test(
            String(error.message || ""),
          ),
        );
      const unavailable = [502, 503, 504].includes(response.status);
      const retryable =
        response.status === 429 ||
        unavailable ||
        (response.status !== 401 && response.status !== 403 && throttle);
      const event = {
        event: "isolated_presentation_read_failure",
        httpStatus: response.status,
        providerCodes: codes,
        attempt: attempt + 1,
        failure: unavailable
          ? "provider-unavailable"
          : retryable
            ? "provider-throttle"
            : body
              ? "provider-rejection"
              : "invalid-json",
        params: params.length,
        sqlChars: sql.length,
      };
      onDiagnostic(event);
      if (!retryable || attempt === 3)
        throw Error("Isolated presentation preparation failed: " + JSON.stringify(event));
      const providerDelay = retryAfterDelayMs(response.headers.get("retry-after"), Date.now());
      const delay = Math.max(12000 + attempt * 6000, providerDelay);
      assert.ok(
        Number.isSafeInteger(delay) && delay <= 60000,
        "Isolated preparation throttle exceeds bounded retry budget",
      );
      await sleep(delay);
    }
    throw Error("Unreachable isolated presentation read state");
  }
  const approved = new WeakSet();
  function statement(sql, params = []) {
    checkedQaOwnerReadSql(sql);
    checkedQaOwnerReadParams(params);
    const value = {
      bind: (...values) => statement(sql, values),
      all: () => query(sql, params),
      first: async () => (await query(sql, params)).results[0] || null,
    };
    approved.add(value);
    return value;
  }
  return {
    prepare: statement,
    batch: (statements) => {
      assert.ok(
        Array.isArray(statements) &&
          statements.length > 0 &&
          statements.length <= 24 &&
          statements.every((s) => approved.has(s)),
        "Only validated isolated SELECT statements may be batched",
      );
      // Preparation has no latency budget: avoid bursting the REST reader.
      return statements.reduce(
        async (prior, statement) => [...(await prior), await statement.all()],
        Promise.resolve([]),
      );
    },
  };
}
