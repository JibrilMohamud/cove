import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// The master credential belongs to provisioning only, never to a Cove binding or artifact.
export async function createSearchCredentials({
  origin,
  masterKey,
  index,
  expiresAt,
  allowLoopback = false,
}) {
  const url = new URL(origin);
  assert.ok(
    (url.protocol === "https:" ||
      (allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1")) &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password,
    "Use a TLS service origin (or explicitly allowed local engine)",
  );
  assert.match(index, /^[a-zA-Z0-9_-]{1,180}$/);
  assert.ok(typeof masterKey === "string" && masterKey.length >= 16);
  assert.ok(new Date(expiresAt).getTime() > Date.now(), "Credentials must have a future expiry");
  const created = [];
  async function create(role, actions) {
    const response = await fetch(new URL("/keys", url), {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        uid: randomUUID(),
        name: `Cove ${role}: ${index}`,
        actions,
        indexes: [index],
        expiresAt,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 201)
      throw Error(`Search credential creation failed: HTTP ${response.status}`);
    const value = await response.json();
    assert.ok(typeof value.key === "string" && value.key.length >= 16);
    assert.notEqual(value.key, masterKey);
    created.push(value.uid);
    return { uid: value.uid, key: value.key };
  }
  try {
    const search = await create("search", ["search"]);
    const indexer = await create("indexer", [
      "indexes.create",
      "indexes.get",
      "settings.update",
      "tasks.get",
      "documents.add",
      "documents.delete",
      "stats.get",
    ]);
    assert.notEqual(search.key, indexer.key);
    return { search, indexer, index, expiresAt };
  } catch (error) {
    // Do not strand a partially provisioned credential pair.
    await Promise.allSettled(
      created.map((uid) =>
        fetch(new URL(`/keys/${uid}`, url), {
          method: "DELETE",
          redirect: "error",
          headers: { authorization: `Bearer ${masterKey}` },
          signal: AbortSignal.timeout(10000),
        }),
      ),
    );
    throw error;
  }
}

export async function verifySearchCredentialBoundary({ origin, index, searchKey, adminKey }) {
  assert.notEqual(searchKey, adminKey, "Serving and indexing must use distinct credentials");
  async function request(path, key, init = {}) {
    return fetch(new URL(path, origin), {
      ...init,
      redirect: "error",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
  }
  const denied = async (path, key, init) => {
    const r = await request(path, key, init);
    await r.arrayBuffer();
    assert.ok(
      [401, 403].includes(r.status),
      `Capability must be denied: ${path}, HTTP ${r.status}`,
    );
  };
  const base = `/indexes/${encodeURIComponent(index)}`;
  await denied(`${base}/search`, null, { method: "POST", body: "{}" });
  await denied(`${base}/documents`, searchKey, { method: "POST", body: "[]" });
  await denied("/keys", searchKey);
  await denied("/keys", adminKey);
  // This randomly named index cannot contain customer data. Empty probes never remove a real index.
  await denied(`/indexes/cove-forbidden-${randomUUID()}/stats`, adminKey);
  const result = await request(`${base}/search`, searchKey, {
    method: "POST",
    body: '{"limit":1}',
  });
  await result.arrayBuffer();
  assert.equal(result.status, 200, "Serving credential must search the intended index");
  return {
    unauthenticatedDenied: true,
    servingWritesDenied: true,
    keyManagementDenied: true,
    otherIndexDenied: true,
  };
}
