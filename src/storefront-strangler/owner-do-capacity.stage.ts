/* eslint-disable prettier/prettier -- Isolated stage probe; explicit safety guards are audited. */
/* Research-only isolated owner SQLite capacity probe. NEVER customer legal authority. */
import { DurableObject } from "cloudflare:workers";
import {
  createAuthoritySchema, createAuthorityProofSchema, applyAuthorityCommand,
  storeAuthorizedPresentationProof, readAuthorizedPresentations,
  type AuthoritySql,
} from "./legal-authority-core";
import {
  createCommercialAuthoritySchema, publishFreshCommercialProof,
  denyCommercialSubject,
} from "./commercial-legal-core";
import {
  createCommercialStorefrontSchema, publishCommercialStorefront,
  readCommercialStorefront,
} from "./commercial-storefront-authority";
import { createMarketAuthoritySchema, denyMarket, marketIsWithdrawn } from "./market-authority-core";

type StageEnv = {
  COVE_OWNER_DO_STAGE: string;
  COVE_OWNER_DO_EXPIRES_AT: string;
  COVE_OWNER_DO_GATE: string;
  OWNER_DO: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
};
const freeIds = Array.from({ length: 12 }, (_, i) => "prd_gutenberg_" + (900000001 + i));
const paidIds = Array.from({ length: 13 }, (_, i) => "prd_stage_owner_" + String(i + 1).padStart(3, "0"));
const ids = [...freeIds, ...paidIds];
const freeSource = (id: string) => id.slice("prd_gutenberg_".length);
const paidSuffix = (id: string) => id.slice("prd_stage_owner_".length);
const expiry = () => new Date(Date.now() + 4 * 60_000).toISOString();
const expectedOffers = [...Array(12).fill(0), ...Array(13).fill(599)];
const headers = { "cache-control": "no-store", "content-type": "application/json" };
const scope = "isolated-cove-owner-stage-20261115";

function stageLive(env: StageEnv) {
  return env.COVE_OWNER_DO_STAGE === "1" &&
    /^[a-f0-9]{64}$/.test(env.COVE_OWNER_DO_GATE || "") &&
    Number.isSafeInteger(Number(env.COVE_OWNER_DO_EXPIRES_AT)) &&
    Date.now() < Number(env.COVE_OWNER_DO_EXPIRES_AT);
}

export class StageUnifiedOwner extends DurableObject<StageEnv> {
  constructor(ctx: { storage: { sql: unknown } }, env: StageEnv) {
    super(ctx, env);
    const sql = ctx.storage.sql as unknown as AuthoritySql;
    createAuthoritySchema(sql);
    createAuthorityProofSchema(sql);
    createCommercialAuthoritySchema(sql);
    createCommercialStorefrontSchema(sql);
    createMarketAuthoritySchema(sql);
    sql.exec("CREATE TABLE IF NOT EXISTS stage_owner_fixture (id INTEGER PRIMARY KEY CHECK(id=1), seeded_at TEXT NOT NULL)");
  }

  private transaction<T>(fn: () => T): T {
    const storage = this.ctx.storage as typeof this.ctx.storage & {
      transactionSync<T>(callback: () => T): T;
    };
    return storage.transactionSync(fn);
  }

  private read() {
    const sql = this.ctx.storage.sql as unknown as AuthoritySql;
    if (marketIsWithdrawn(sql, "US")) return { valid: false, count: 0, fingerprint: "market-denied" };
    const free = readAuthorizedPresentations(sql, freeIds, "US", "USD");
    const paid = readCommercialStorefront(sql, paidIds, "US", "USD");
    const actual = [...free, ...paid];
    const valid = actual.length === 25 &&
      actual.every((row, i) => {
        if (row.product_id !== ids[i]) return false;
        const offer = JSON.parse(row.offer_json) as { currency: string; amountMinor: number };
        return offer.currency === "USD" && offer.amountMinor === expectedOffers[i];
      });
    return { valid, count: actual.length, fingerprint: valid ? "exact-12-free-13-paid" : "incomplete" };
  }

  async fetch(request: Request) {
    if (!stageLive(this.env) || request.method !== "POST" ||
      request.headers.get("x-cove-stage-owner-key") !== this.env.COVE_OWNER_DO_GATE)
      return new Response(null, { status: 404 });
    const route = new URL(request.url).pathname;
    const sql = this.ctx.storage.sql as unknown as AuthoritySql;
    try {
      if (route === "/seed") {
        this.transaction(() => {
          if (sql.exec("SELECT 1 AS ready FROM stage_owner_fixture WHERE id=1").toArray().length)
            throw Error("stage_owner_already_seeded");
          for (const id of freeIds) {
            const command = { sourceId: freeSource(id), territory: "US", revision: 1, action: "allow" as const };
            if (!applyAuthorityCommand(sql, command).applied) throw Error("free_fixture_denied");
            storeAuthorizedPresentationProof(sql, command, "USD", {
              productId: id,
              editionId: "ed_gutenberg_" + freeSource(id),
              productPublicId: null,
              editionPublicId: null,
              offerJson: JSON.stringify({ type: "public-domain", currency: "USD", amountMinor: 0 }),
            });
          }
          for (const id of paidIds) {
            const suffix = paidSuffix(id);
            const editionId = "ed_stage_owner_" + suffix;
            const grantId = "grant_stage_owner_" + suffix;
            const contractId = "contract_stage_owner_" + suffix;
            const contractVersionId = "contract_version_stage_owner_" + suffix;
            const validUntil = expiry();
            const proof = {
              productId: id, editionId, territory: "US", channel: "retail" as const,
              grantId, contractId, contractVersionId, validUntil,
            };
            const receipt = publishFreshCommercialProof(sql, proof, 0);
            if (!receipt.applied || receipt.epoch !== 1) throw Error("paid_fixture_denied");
            publishCommercialStorefront(sql, {
              product_id: id, edition_id: editionId, grant_id: grantId,
              contract_id: contractId, contract_version_id: contractVersionId,
              product_public_id: null, edition_public_id: null,
              territory: "US", currency: "USD", rights_epoch: 1,
              offer_json: JSON.stringify({ type: "retail", currency: "USD", amountMinor: 599 }),
              valid_until: validUntil,
            });
          }
          sql.exec("INSERT INTO stage_owner_fixture(id,seeded_at) VALUES(1,datetime('now'))");
        });
        return Response.json({ schema: "cove.stage-owner-do.v1", ...this.read(), releaseCertified: false }, { headers });
      }
      if (route === "/read") {
        const result = this.read();
        return Response.json(
          { schema: "cove.stage-owner-do.v1", ...result, releaseCertified: false },
          { status: result.valid ? 200 : 503, headers },
        );
      }
      if (route === "/deny-contract") {
        this.transaction(() => denyCommercialSubject(sql, {
          subjectKind: "contract",
          subjectId: "contract_stage_owner_001",
          operationId: "stage:contract:deny:1",
        }));
        return Response.json({ count: this.read().count, releaseCertified: false }, { headers });
      }
      if (route === "/deny-free") {
        this.transaction(() => {
          if (!applyAuthorityCommand(sql, {
            sourceId: freeSource(freeIds[0]), territory: "*", revision: 2, action: "deny",
          }).applied) throw Error("stage_free_denial_failed");
        });
        return Response.json({ count: this.read().count, releaseCertified: false }, { headers });
      }
      if (route === "/stale-regrant") {
        let denied = false;
        this.transaction(() => {
          try {
            storeAuthorizedPresentationProof(sql, {
              sourceId: freeSource(freeIds[0]), territory: "US", revision: 1, action: "allow",
            }, "USD", {
              productId: freeIds[0], editionId: "ed_gutenberg_" + freeSource(freeIds[0]),
              productPublicId: null, editionPublicId: null,
              offerJson: JSON.stringify({ type: "public-domain", currency: "USD", amountMinor: 0 }),
            });
          } catch {
            denied = true;
          }
        });
        return Response.json({ stalePositiveRejected: denied, count: this.read().count, releaseCertified: false },
          { status: denied ? 200 : 503, headers });
      }
      if (route === "/market-deny") {
        this.transaction(() => denyMarket(sql, {
          territory: "US", operationId: "stage:market:deny:1",
        }));
        return Response.json({ marketDenied: marketIsWithdrawn(sql, "US"), count: this.read().count, releaseCertified: false }, { headers });
      }
      return new Response(null, { status: 404 });
    } catch {
      return Response.json({ error: "stage_owner_fail_closed", releaseCertified: false },
        { status: 503, headers });
    }
  }
}

export default {
  async fetch(request: Request, env: StageEnv) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.search || request.headers.has("cookie") ||
      !stageLive(env) ||
      request.headers.get("authorization") !== "Bearer " + env.COVE_OWNER_DO_GATE)
      return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    if (url.pathname === "/__cove/owner-do/noop")
      return Response.json({ valid: true, releaseCertified: false }, { headers });
    const paths: Record<string, string> = {
      "/__cove/owner-do/seed": "/seed",
      "/__cove/owner-do/read": "/read",
      "/__cove/owner-do/deny-contract": "/deny-contract",
      "/__cove/owner-do/deny-free": "/deny-free",
      "/__cove/owner-do/stale-regrant": "/stale-regrant",
      "/__cove/owner-do/market-deny": "/market-deny",
    };
    const target = paths[url.pathname];
    if (!target) return new Response(null, { status: 404 });
    return env.OWNER_DO.getByName(scope).fetch(new Request("https://stage-owner.internal" + target, {
      method: "POST",
      headers: { "x-cove-stage-owner-key": env.COVE_OWNER_DO_GATE },
    }));
  },
};
