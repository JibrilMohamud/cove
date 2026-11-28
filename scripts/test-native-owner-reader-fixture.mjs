// Disposable workerd fixture only. Provider verification uses a closed fake
// upstream; no production authentication or legal evidence is asserted here.
import assert from "node:assert/strict";

const providerId = "00000000-0000-4000-8000-000000000028";
export const nativeReaderId = "sb:" + providerId;
const token =
  [
    { alg: "HS256", typ: "JWT" },
    { sub: providerId, session_id: "native-reader-session", aal: "aal1", exp: 4102444800 },
  ]
    .map((x) => Buffer.from(JSON.stringify(x)).toString("base64url"))
    .join(".") + ".fixture";
const session = {
  access_token: token,
  refresh_token: "closed-local-fixture-refresh",
  expires_at: 4102444800,
  expires_in: 3600,
  token_type: "bearer",
  user: { id: providerId, email: "native-reader@example.invalid" },
};
const cookie = "fore-auth=base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
export function nativeReaderProvider(request) {
  const url = new URL(request.url);
  if (url.origin !== "https://native-auth.invalid") return null;
  assert.equal(url.pathname, "/auth/v1/user", "Only verified user lookup may leave this fixture");
  if (request.headers.get("authorization") !== "Bearer " + token)
    return Response.json({ message: "Invalid fixture credential" }, { status: 401 });
  return Response.json({
    id: providerId,
    aud: "authenticated",
    role: "authenticated",
    email: "native-reader@example.invalid",
    email_confirmed_at: "2026-01-01T00:00:00Z",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { full_name: "Native Reader" },
    identities: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
}

export async function proveNativeOwnerReader({ client, db, backendToken, production = false }) {
  async function call(path, value, expected = 200, authenticated = true, method) {
    const response = await client.fetch("https://fixture.invalid/api/fore" + path, {
      method: method || (value === undefined ? "GET" : "POST"),
      headers: {
        "x-cove-backend-token": backendToken,
        "x-cove-client-country": "US",
        "content-type": "application/json",
        ...(authenticated ? { cookie } : {}),
        // An attacker-controlled platform identity must never replace Supabase.
        "oai-authenticated-user-id": "forged-platform-user",
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const payload = await response.json();
    assert.equal(response.status, expected, path + ": " + JSON.stringify(payload));
    return payload;
  }
  await call("/profile", { name: "Untrusted" }, 401, false);
  await call("/profile", { name: "Native Reader Saved" });
  assert.equal(
    (await db.prepare("SELECT name FROM profiles WHERE user_id=?").bind(nativeReaderId).first())
      .name,
    "Native Reader Saved",
  );
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM profiles WHERE user_id='forged-platform-user'")
        .first()
    ).n,
    0,
  );
  const registered = await call(
    "/sync/register",
    {
      clientKey: "native-owner-device-identity-000000000000",
      name: "Native fixture",
      platform: "web",
    },
    201,
  );
  const clientId = registered.clientId;
  assert.ok(clientId);
  await call("/reader/settings", { clientId, key: "fontSize", value: 22, expectedVersion: 0 });
  await call("/reader/settings", { clientId, key: "fontSize", value: 30, expectedVersion: 0 }, 409);
  assert.deepEqual(
    await db
      .prepare(
        "SELECT value_json,version FROM reader_settings WHERE user_id=? AND setting_key='fontSize'",
      )
      .bind(nativeReaderId)
      .first(),
    { value_json: "22", version: 1 },
  );
  const rows = { profile: true, syncClient: true, readerSetting: true, staleSettingDenied: true };
  await call("/account/preferences", { storefrontCountry: "US", privacy: { activity: false } });
  assert.equal(
    (
      await db
        .prepare("SELECT privacy_json FROM account_preferences WHERE user_id=?")
        .bind(nativeReaderId)
        .first()
    ).privacy_json,
    '{"activity":false}',
  );
  const device = await call("/account/device/register", {
    deviceKey: "native-owner-device-key-000000000000",
    name: "Native reader",
    platform: "web",
  });
  assert.ok(device.id);
  assert.equal(
    (
      await db
        .prepare("SELECT revoked_at FROM devices WHERE id=? AND user_id=?")
        .bind(device.id, nativeReaderId)
        .first()
    ).revoked_at,
    null,
  );
  await call("/account/device/revoke", { deviceId: device.id });
  assert.ok(
    (
      await db
        .prepare("SELECT revoked_at FROM devices WHERE id=? AND user_id=?")
        .bind(device.id, nativeReaderId)
        .first()
    ).revoked_at,
  );
  Object.assign(rows, {
    preferences: true,
    nativeDeviceRegistered: true,
    nativeDeviceRevoked: true,
  });
  if (!production) {
    const product = await db
      .prepare(
        "SELECT id,source_external_id FROM products WHERE source_name='gutenberg' ORDER BY id LIMIT 1",
      )
      .first();
    assert.ok(product);
    // Known synthetic entitlement, inserted only in this disposable full-schema
    // test database. This never constitutes a grant/release evidence artifact.
    const at = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,starts_at,granted_at,updated_at) VALUES(?,?,?,'purchase','active','local-fixture',?,?,?)",
      )
      .bind("native_reader_entitlement", nativeReaderId, product.id, at, at, at)
      .run();
    const position = {
      mutationId: "native-progress-mutation-0001",
      entityType: "reading_position",
      entityId: product.id,
      expectedVersion: 0,
      operation: "upsert",
      payload: {
        productId: product.id,
        externalBookId: product.source_external_id,
        cfi: "epubcfi(/6/2)",
        progress: 0.35,
        status: "reading",
      },
    };
    await call("/sync/push", { clientId, mutations: [position] });
    await call("/sync/push", { clientId, mutations: [position] });
    const progress = await db
      .prepare("SELECT progress,version FROM reading_states WHERE user_id=? AND product_id=?")
      .bind(nativeReaderId, product.id)
      .first();
    assert.equal(progress.progress, 0.35);
    assert.equal(progress.version, 1, "Exact sync replay cannot repeat the domain write");
    const noteId = "00000000-0000-4000-8000-000000000029";
    await call(
      "/annotations",
      {
        bookId: product.source_external_id,
        quote: "Native owner quotation",
        cfi: "epubcfi(/6/2)",
        note: "Persisted native note",
        clientId: noteId,
      },
      201,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT note FROM annotations WHERE id=? AND user_id=?")
          .bind(noteId, nativeReaderId)
          .first()
      ).note,
      "Persisted native note",
    );
    await call(
      "/bookmarks",
      {
        productId: product.id,
        externalBookId: product.source_external_id,
        cfi: "epubcfi(/6/2)",
        label: "Native bookmark",
        clientId,
      },
      201,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) n FROM text_bookmarks WHERE user_id=? AND product_id=?")
          .bind(nativeReaderId, product.id)
          .first()
      ).n,
      1,
    );
    Object.assign(rows, {
      progress: true,
      exactProgressReplay: true,
      annotation: true,
      bookmark: true,
    });
  }
  assert.ok(
    (
      await db
        .prepare("SELECT count(*) n FROM account_sessions WHERE user_id=?")
        .bind(nativeReaderId)
        .first()
    ).n > 0,
    "Verified session must persist",
  );
  await call("/sync/clients/revoke", { clientId });
  await call("/reader/settings", { clientId, key: "fontSize", value: 30, expectedVersion: 1 }, 403);
  rows.revokedClientDenied = true;
  console.log(
    "PASS: native authenticated owner persisted reader/account rows",
    JSON.stringify(rows),
  );
  return rows;
}
