/**
 * SYNTHETIC STAGING ONLY: integrity-bound continuation, never an entitlement.
 * The complete immutable R2 snapshot digest prevents replay across reseeds.
 * HMAC keys are domain-separated from the existing private staging gate.
 */
export type SyntheticCursorScope = {
  digest: string;
  revision: string;
  expiresAt: number;
};

export type SyntheticCursorAnchor = { position: number; productId: string };

type SignedCursor = {
  v: 1;
  territory: "US";
  currency: "USD";
  sort: "popular";
  pageSize: 24;
  digest: string;
  revision: string;
  expiresAt: number;
  position: number;
  productId: string;
};

const text = new TextEncoder();
const MAX_TOKEN = 768;
const TWO_MINUTES = 120_000;
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{1,159}$/.test(value);

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > MAX_TOKEN) return null;
  try {
    const decoded = Uint8Array.from(
      atob(
        value
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(Math.ceil(value.length / 4) * 4, "="),
      ),
      (c) => c.charCodeAt(0),
    );
    return base64Url(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

async function keyForStageGate(secret: string): Promise<CryptoKey> {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("Invalid isolated cursor key");
  const domainSeparated = await crypto.subtle.digest(
    "SHA-256",
    text.encode("cove.synthetic-stage.cursor-signing.v1\0" + secret),
  );
  return crypto.subtle.importKey("raw", domainSeparated, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function syntheticSnapshotSha256(raw: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", text.encode(raw)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validScope(scope: SyntheticCursorScope, now: number) {
  return (
    /^[a-f0-9]{64}$/.test(scope.digest) &&
    /^[1-9][0-9]{0,18}$/.test(scope.revision) &&
    Number.isSafeInteger(scope.expiresAt) &&
    scope.expiresAt > now &&
    scope.expiresAt <= now + TWO_MINUTES
  );
}

function shape(payload: SignedCursor, scope: SyntheticCursorScope, now: number): boolean {
  return (
    Object.keys(payload).length === 10 &&
    payload.v === 1 &&
    payload.territory === "US" &&
    payload.currency === "USD" &&
    payload.sort === "popular" &&
    payload.pageSize === 24 &&
    payload.digest === scope.digest &&
    payload.revision === scope.revision &&
    payload.expiresAt === scope.expiresAt &&
    Number.isSafeInteger(payload.position) &&
    payload.position >= 0 &&
    payload.position < 95 &&
    validId(payload.productId) &&
    validScope(scope, now)
  );
}

export async function signSyntheticStageCursor(
  anchor: SyntheticCursorAnchor,
  scope: SyntheticCursorScope,
  secret: string,
  now = Date.now(),
): Promise<string> {
  const payload: SignedCursor = {
    v: 1,
    territory: "US",
    currency: "USD",
    sort: "popular",
    pageSize: 24,
    digest: scope.digest,
    revision: scope.revision,
    expiresAt: scope.expiresAt,
    position: anchor.position,
    productId: anchor.productId,
  };
  if (!shape(payload, scope, now)) throw new Error("Unsafe synthetic cursor binding");
  const body = base64Url(text.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await keyForStageGate(secret), text.encode(body)),
  );
  const token = body + "." + base64Url(signature);
  if (token.length > MAX_TOKEN) throw new Error("Synthetic cursor exceeded size limit");
  return token;
}

export async function verifySyntheticStageCursor(
  token: string,
  scope: SyntheticCursorScope,
  secret: string,
  now = Date.now(),
): Promise<SyntheticCursorAnchor | null> {
  if (typeof token !== "string" || token.length > MAX_TOKEN || !validScope(scope, now)) return null;
  const fragments = token.split(".");
  if (fragments.length !== 2) return null;
  const body = decodeBase64Url(fragments[0]);
  const mac = decodeBase64Url(fragments[1]);
  if (!body || !mac || mac.length !== 32) return null;
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const decoded: unknown = JSON.parse(raw);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const payload = decoded as SignedCursor;
    if (!shape(payload, scope, now) || JSON.stringify(payload) !== raw) return null;
    const signature = new Uint8Array(32);
    signature.set(mac);
    const authentic = await crypto.subtle.verify(
      "HMAC",
      await keyForStageGate(secret),
      signature,
      text.encode(fragments[0]),
    );
    return authentic ? { position: payload.position, productId: payload.productId } : null;
  } catch {
    return null;
  }
}
