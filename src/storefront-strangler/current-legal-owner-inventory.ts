import type { CatalogDB } from "../features/fore/catalog-model.server";
import { resolveProductRights, type SalesChannel } from "../features/fore/rights.server";
import {
  baselineClock,
  baselineDigest,
  hashLegalBaseline,
  type BaselineScope,
} from "./current-legal-owner-baseline";
import type { AuthoritySql } from "./legal-authority-core";
export type OwnerProduct = {
  productId: string;
  editionId: string;
  format: string;
  status: string;
  sourceName: string;
  sourceItemId: string;
};
export type OwnerInventoryRow = BaselineScope & {
  source: string;
  sourceItemId: string;
  artifactSha256: string | null;
  policySha256: string | null;
  canonicalAllowed: boolean;
  outstandingHold: boolean;
};
const scopeKey = (x: BaselineScope) =>
  JSON.stringify([x.productId, x.territory, x.format, x.channel]);
function source(p: OwnerProduct) {
  if (p.sourceName !== "gutenberg")
    return ["publisher", "publishing", "commercial"].includes(p.sourceName) ? "contract" : null;
  return /^pgca_/.test(p.sourceItemId)
    ? "pg_ca"
    : /^pgau_/.test(p.sourceItemId)
      ? "pg_au"
      : /^pgeu_/.test(p.sourceItemId)
        ? "pg_eu"
        : "pg_us";
}
export async function currentCanonicalLegalFacts(
  db: CatalogDB,
  sql: AuthoritySql,
  scope: BaselineScope,
  atMs = Date.now(),
) {
  const deny = {
    artifactSha256: null,
    policySha256: null,
    canonicalAllowed: false,
    outstandingHold: true,
  };
  if (
    !scope ||
    typeof scope.productId !== "string" ||
    !/^[A-Z]{2}$/.test(scope.territory) ||
    !["ebook", "audiobook"].includes(scope.format) ||
    !["retail", "subscription", "library"].includes(scope.channel) ||
    !Number.isSafeInteger(atMs)
  )
    return deny;
  const clock = baselineClock(sql);
  const unchanged = () => {
    const at = baselineClock(sql);
    return at.ownerEpoch === clock.ownerEpoch && at.withdrawalSequence === clock.withdrawalSequence;
  };
  const p = await db
    .prepare(
      "SELECT id productId,edition_id editionId,format,storefront_status status,source_name sourceName,source_external_id sourceItemId FROM products WHERE id=?",
    )
    .bind(scope.productId)
    .first<OwnerProduct>();
  if (!unchanged() || !p || p.format !== scope.format || !source(p)) return deny;
  const assets = await db
    .prepare(
      "SELECT av.sha256 FROM digital_assets da JOIN asset_versions av ON av.id=da.current_version_id AND av.asset_id=da.id WHERE da.edition_id=? AND da.kind=? ORDER BY da.id",
    )
    .bind(p.editionId, scope.format === "ebook" ? "epub" : "audio")
    .all<{ sha256: string | null }>();
  if (!unchanged()) return deny;
  const a = assets.results || [],
    artifactSha256 = a.length === 1 && baselineDigest(a[0].sha256) ? a[0].sha256 : null;
  const decision = await resolveProductRights(db, scope.productId, scope.territory, {
    salesChannel: scope.channel as SalesChannel,
    at: new Date(atMs).toISOString(),
    persist: false,
  });
  if (!unchanged()) return deny;
  const policySha256 = await hashLegalBaseline({ product: p, decision });
  if (!unchanged()) return deny;
  const withdrawn =
    sql
      .exec("SELECT 1 FROM cove_market_withdrawals WHERE territory=? LIMIT 1", scope.territory)
      .toArray().length > 0;
  const pending =
    sql
      .exec(
        "SELECT 1 FROM cove_publication_commands WHERE product_id=? AND state='pending' LIMIT 1",
        p.productId,
      )
      .toArray().length > 0;
  const productHold =
    p.sourceName === "gutenberg"
      ? sql
          .exec(
            "SELECT 1 FROM cove_legal_fences WHERE source_id=? AND territory IN (?,'*') AND verdict='deny' LIMIT 1",
            p.sourceItemId,
            scope.territory,
          )
          .toArray().length > 0
      : sql
          .exec(
            "SELECT 1 FROM cove_commercial_authority WHERE product_id=? AND verdict='deny' LIMIT 1",
            p.productId,
          )
          .toArray().length > 0;
  const subject =
    sql
      .exec(
        "SELECT 1 FROM cove_commercial_subject_denials WHERE (subject_kind='grant' AND subject_id=?) OR (subject_kind='contract' AND subject_id=?) LIMIT 1",
        decision.grantId,
        decision.contractId,
      )
      .toArray().length > 0;
  const retired =
    sql
      .exec(
        "SELECT 1 FROM cove_commercial_retired_evidence WHERE product_id=? AND grant_id=? AND contract_id=? AND contract_version_id=? LIMIT 1",
        p.productId,
        decision.grantId,
        decision.contractId,
        decision.contractVersionId,
      )
      .toArray().length > 0;
  return {
    artifactSha256,
    policySha256,
    canonicalAllowed: p.status === "active" && decision.allowed && !!artifactSha256,
    outstandingHold: withdrawn || pending || productHold || subject || retired,
  };
}
export async function captureCanonicalLegalInventoryPage(
  db: CatalogDB,
  sql: AuthoritySql,
  input: {
    phase: "products" | "scopes";
    cursor: string;
    ownerEpoch: number;
    withdrawalSequence: number;
    atMs: number;
  },
) {
  const check = () => {
    const c = baselineClock(sql);
    if (c.ownerEpoch !== input.ownerEpoch || c.withdrawalSequence !== input.withdrawalSequence)
      throw Error("owner_inventory_clock_changed");
  };
  check();
  if (input.phase === "products") {
    const result = await db
      .prepare(
        "SELECT id productId,edition_id editionId,format,storefront_status status,source_name sourceName,source_external_id sourceItemId FROM products WHERE id>? ORDER BY id LIMIT 128",
      )
      .bind(input.cursor)
      .all<OwnerProduct>();
    check();
    const rows = result.results || [];
    return {
      kind: "products" as const,
      rows,
      nextCursor: rows.at(-1)?.productId || input.cursor,
      done: rows.length === 0,
    };
  }
  let cursor: string[];
  try {
    cursor = input.cursor ? JSON.parse(input.cursor) : ["", "", "", ""];
  } catch {
    throw Error("owner_inventory_cursor");
  }
  if (!Array.isArray(cursor) || cursor.length !== 4 || cursor.some((x) => typeof x !== "string"))
    throw Error("owner_inventory_cursor");
  const page = await db
    .prepare(
      `SELECT DISTINCT p.id productId,p.edition_id editionId,p.format,p.storefront_status status,p.source_name sourceName,p.source_external_id sourceItemId,t.territory_code territory,c.channel
    FROM products p JOIN rights_grants g ON g.edition_id=p.edition_id AND g.format=p.format JOIN rights_grant_territories t ON t.grant_id=g.id
    CROSS JOIN (SELECT 'retail' channel UNION ALL SELECT 'subscription' UNION ALL SELECT 'library') c
    WHERE p.format IN ('ebook','audiobook') AND length(t.territory_code)=2 AND t.territory_code<>'ZZ' AND (p.id,t.territory_code,p.format,c.channel)>(?,?,?,?)
    ORDER BY p.id,t.territory_code,p.format,c.channel LIMIT 16`,
    )
    .bind(...cursor)
    .all<OwnerProduct & { territory: string; channel: string }>();
  check();
  const found = page.results || [],
    rows: OwnerInventoryRow[] = [];
  for (const p of found) {
    const s = {
      productId: p.productId,
      territory: p.territory,
      format: p.format,
      channel: p.channel,
    };
    const facts = await currentCanonicalLegalFacts(db, sql, s, input.atMs);
    check();
    rows.push({ ...s, source: source(p) || "contract", sourceItemId: p.sourceItemId, ...facts });
  }
  const last = found.at(-1);
  return {
    kind: "scopes" as const,
    rows,
    nextCursor: last ? scopeKey(last) : input.cursor,
    done: found.length === 0,
  };
}
