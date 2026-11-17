/**
 * Synthetic-QA-only native primary D1 catalog authorization experiment.
 *
 * This module never accepts SQL from callers and never caches an approval.
 * The caller supplies the existing source-controlled primary SELECT, followed
 * by a synchronous owner-fence read AFTER the D1 await. No asynchronous work
 * may occur between the final owner check and returning a positive result.
 */
export type NativeFirstPaintRow = {
  product_id: string;
  product_public_id: string | null;
  edition_id: string;
  edition_public_id: string | null;
  offer_json: string | null;
};

type NativeRequest = {
  ids: string[];
  territory: string;
  currency: string;
};
type NativeRead = {
  rows: NativeFirstPaintRow[];
  servedByPrimary: boolean;
};
type NativePorts = {
  readPrimary(ids: string[], territory: string, currency: string): Promise<NativeRead>;
  readOwner(ids: string[], territory: string, currency: string): NativeFirstPaintRow[];
  marketWithdrawn(territory: string): boolean;
};

const productId = /^prd_[a-zA-Z0-9_-]{3,120}$/;
const editionId = /^[a-zA-Z0-9_-]{3,160}$/;

export function nativeFirstPaintRequest(raw: unknown): NativeRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("invalid_native_qa_request");
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "currency,ids,territory" ||
    !Array.isArray(value.ids) ||
    value.ids.length < 1 ||
    value.ids.length > 25 ||
    value.ids.some((id) => typeof id !== "string" || !productId.test(id)) ||
    new Set(value.ids).size !== value.ids.length ||
    typeof value.territory !== "string" ||
    !/^[A-Z]{2}$/.test(value.territory) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency)
  )
    throw new Error("invalid_native_qa_request");
  return value as NativeRequest;
}

function checkedRow(
  raw: NativeFirstPaintRow,
  input: NativeRequest,
  allowed: Set<string>,
): NativeFirstPaintRow {
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw.product_id !== "string" ||
    !allowed.has(raw.product_id) ||
    typeof raw.edition_id !== "string" ||
    !editionId.test(raw.edition_id) ||
    (raw.product_public_id !== null &&
      (typeof raw.product_public_id !== "string" ||
        raw.product_public_id.length > 160)) ||
    (raw.edition_public_id !== null &&
      (typeof raw.edition_public_id !== "string" ||
        raw.edition_public_id.length > 160)) ||
    typeof raw.offer_json !== "string" ||
    raw.offer_json.length > 512
  )
    throw new Error("native_qa_malformed_authority_row");

  let offer: Record<string, unknown>;
  try {
    offer = JSON.parse(raw.offer_json) as Record<string, unknown>;
  } catch {
    throw new Error("native_qa_invalid_offer");
  }
  if (
    !offer ||
    typeof offer !== "object" ||
    Array.isArray(offer) ||
    Object.keys(offer).sort().join(",") !== "amountMinor,currency,type" ||
    offer.currency !== input.currency ||
    typeof offer.type !== "string" ||
    !Number.isSafeInteger(offer.amountMinor) ||
    (offer.amountMinor as number) < 0
  )
    throw new Error("native_qa_invalid_offer");
  if (
    raw.product_id.startsWith("prd_gutenberg_")
      ? offer.type !== "public-domain" || offer.amountMinor !== 0
      : offer.type === "public-domain" ||
        !/^[a-z][a-z0-9_-]{2,39}$/.test(offer.type)
  )
    throw new Error("native_qa_invalid_offer");
  return raw;
}

export async function readOwnerNativeFirstPaintQa(raw: unknown, ports: NativePorts) {
  const input = nativeFirstPaintRequest(raw);
  // A market-level withdrawal vetoes all previously published proofs.
  if (ports.marketWithdrawn(input.territory))
    throw new Error("native_qa_market_withdrawn");

  const primary = await ports.readPrimary(input.ids, input.territory, input.currency);
  if (!primary || primary.servedByPrimary !== true || !Array.isArray(primary.rows))
    throw new Error("native_qa_primary_unverified");

  // This read runs AFTER the awaited D1 statement. A withdrawal occurring
  // while the primary call is in flight must be visible before any approval.
  if (ports.marketWithdrawn(input.territory))
    throw new Error("native_qa_market_withdrawn");
  const owner = ports.readOwner(input.ids, input.territory, input.currency);
  if (!Array.isArray(owner) || owner.length > input.ids.length)
    throw new Error("native_qa_owner_unavailable");

  const allowed = new Set(input.ids);
  const byPrimary = new Map<string, NativeFirstPaintRow>();
  const byOwner = new Map<string, NativeFirstPaintRow>();
  for (const item of primary.rows) {
    // A primary read must prove that every returned row belongs to the
    // candidate request, with unique identity and a lawful retail offer.
    const row = checkedRow(item, input, allowed);
    if (byPrimary.has(row.product_id)) throw new Error("native_qa_duplicate_primary");
    byPrimary.set(row.product_id, row);
  }
  for (const item of owner) {
    const row = checkedRow(item, input, allowed);
    if (byOwner.has(row.product_id)) throw new Error("native_qa_duplicate_owner");
    byOwner.set(row.product_id, row);
  }
  const rows: NativeFirstPaintRow[] = [];
  for (const id of input.ids) {
    const source = byPrimary.get(id);
    const approval = byOwner.get(id);
    if (!source || !approval) continue; // Missing proof is denial, not fallback.
    if (
      source.edition_id !== approval.edition_id ||
      source.product_public_id !== approval.product_public_id ||
      source.edition_public_id !== approval.edition_public_id ||
      source.offer_json !== approval.offer_json
    )
      throw new Error("native_qa_owner_primary_disagree");
    rows.push(approval);
  }
  return { schema: "cove.qa.owner-native-first-paint.v1", rows };
}
