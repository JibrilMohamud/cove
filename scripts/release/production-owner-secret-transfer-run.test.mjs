import assert from "node:assert/strict";
import { test } from "node:test";
import { runProductionOwnerSecretTransfer } from "./production-owner-secret-transfer-run.mjs";
import {
  TRANSFER_NAMES,
  TRANSFER_OWNER as owner,
  TRANSFER_BACKEND as backend,
  TRANSFER_VERIFIER as verifier,
  codeModule,
} from "./production-owner-secret-transfer.mjs";
function provider({
  failCopy = false,
  failBackendUpload = false,
  loseBackendDeploymentAck = false,
} = {}) {
  let counter = 1,
    token,
    tokenDeleted = false;
  const versions = new Map(),
    active = {},
    domains = {},
    originals = {};
  const id = () => "11111111-1111-4111-8111-" + String(counter++).padStart(12, "0");
  const secret = (name) => ({ name, type: "secret_text" });
  for (const name of [owner, backend, verifier]) {
    const bindings =
      name === owner
        ? [
            { name: "COVE_RIGHTS_OWNER_ENABLED", type: "plain_text", text: "0" },
            { name: "COVE_PRODUCTION_BIOSYNC_BRIDGE_ENABLED", type: "plain_text", text: "1" },
            { name: "PRIMARY_DB", type: "d1", database_id: "4bd657ac-8789-403e-a28c-93aba8d0a989" },
            {
              name: "LEGAL_AUTHORITY",
              type: "durable_object_namespace",
              namespace_id: "83d7eadf3957436389a7b072120a9829",
            },
            secret("COVE_RIGHTS_OWNER_SECRET"),
          ]
        : name === backend
          ? [
              ...TRANSFER_NAMES.map(secret),
              secret("COVE_RIGHTS_OWNER_SECRET"),
              { name: "DB", type: "d1", database_id: "4bd657ac-8789-403e-a28c-93aba8d0a989" },
            ]
          : [];
    const version = {
      id: id(),
      bindings,
      main_module: "worker.js",
      modules: [
        codeModule("worker.js", "export default {fetch(){return new Response('unchanged')}}"),
      ],
      compatibility_date: "2026-09-01",
    };
    versions.set(version.id, version);
    active[name] = version.id;
    originals[name] = structuredClone(version);
    domains[name] = { enabled: false, previews_enabled: false };
  }
  const read = (v) => ({
    ...structuredClone(v),
    bindings: v.bindings.map((b) => {
      const copy = { ...b };
      if (b.type === "secret_text") delete copy.text;
      return copy;
    }),
  });
  const request = async ({ method, path, body }) => {
    const p = path.replace(/^\/accounts\/[a-f0-9]{32}/, "");
    let result;
    const v = p.match(/^\/workers\/workers\/([^/]+)\/versions(?:\/([^/]+))?$/),
      d = p.match(/^\/workers\/scripts\/([^/]+)\/(deployments|subdomain|schedules)$/);
    if (v) {
      const name = v[1];
      if (method === "GET") result = read(versions.get(v[2]));
      else {
        if (name === backend && failBackendUpload) throw Error("fixture_backend_upload_failure");
        const row = {
          ...body,
          id: id(),
          bindings: body.bindings.map((b) =>
            b.type === "inherit"
              ? structuredClone(versions.get(b.version_id).bindings.find((x) => x.name === b.name))
              : { ...b },
          ),
        };
        versions.set(row.id, row);
        result = { id: row.id };
      }
    } else if (d) {
      const [, name, kind] = d;
      if (kind === "deployments") {
        if (method === "POST") {
          active[name] = body.versions[0].version_id;
          if (name === backend && loseBackendDeploymentAck) {
            loseBackendDeploymentAck = false;
            throw Error("fixture_lost_deploy_ack");
          }
        }
        result = { deployments: [{ versions: [{ version_id: active[name], percentage: 100 }] }] };
      } else if (kind === "subdomain") {
        if (method === "POST") domains[name] = { ...body };
        result = domains[name];
      } else
        result = { schedules: name === backend ? [{ cron: "* * * * *", last_run: counter }] : [] };
    } else if (p === "/tokens" && method === "POST") {
      token = {
        ...body,
        id: "a".repeat(32),
        status: "active",
        value: "fixture-temporary-token-value",
      };
      result = token;
    } else if (p === "/tokens" && method === "GET") result = tokenDeleted ? [] : [token];
    else if (p.startsWith("/tokens/")) {
      if (method === "DELETE") tokenDeleted = true;
      result = token;
    } else if (p === "/workers/subdomain") result = { subdomain: "test-only-example" };
    else throw Error("unexpected_provider_call:" + method + ":" + p);
    return { success: true, result };
  };
  const send = async (url, init) => {
    assert.match(
      url,
      /^https:\/\/cove-production-owner-verifier\.test-only-example\.workers\.dev\/transfer$/,
    );
    assert.match(init.headers.authorization, /^Bearer [a-f0-9]{64}$/);
    if (failCopy) return new Response(null, { status: 503 });
    const current = versions.get(active[owner]),
      next = structuredClone(current);
    next.id = id();
    for (const name of TRANSFER_NAMES)
      if (!next.bindings.some((x) => x.name === name)) next.bindings.push(secret(name));
    versions.set(next.id, next);
    active[owner] = next.id;
    return Response.json({
      matching: true,
      copied: TRANSFER_NAMES,
      existingOwnerSecretMatched: true,
    });
  };
  return {
    request,
    send,
    pause: async () => {},
    originals,
    closed() {
      assert.equal(tokenDeleted, true);
      for (const name of [owner, backend, verifier]) {
        const row = read(versions.get(active[name]));
        assert.equal(row.main_module, "worker.js");
        assert.deepEqual(row.modules, originals[name].modules);
        assert.equal(
          row.bindings.some((b) => b.name.startsWith("COVE_TRANSFER_")),
          false,
        );
        assert.deepEqual(domains[name], { enabled: false, previews_enabled: false });
      }
    },
    ownerBindings: () => read(versions.get(active[owner])).bindings,
  };
}
const options = {
  reviewedMainSha: "a".repeat(40),
  currentMainSha: "a".repeat(40),
  confirm: "copy-seven-existing-backend-bindings",
};
test("configuration transfer restores exact runtime modules and closes temporary authority", async () => {
  const f = provider();
  const r = await runProductionOwnerSecretTransfer({ ...f, ...options });
  assert.equal(r.matchingValuesVerified, true);
  assert.equal(r.temporaryTokenRevoked, true);
  assert.equal(r.rightsOwnerEnabled, false);
  f.closed();
  assert.ok(TRANSFER_NAMES.every((n) => f.ownerBindings().some((b) => b.name === n)));
});
test("failed transfer and partial installation still restore original handlers and revoke the token", async () => {
  for (const failure of [{ failCopy: true }, { failBackendUpload: true }]) {
    const f = provider(failure);
    await assert.rejects(
      () => runProductionOwnerSecretTransfer({ ...f, ...options }),
      /transfer_values_not_verified|transfer_provider_request_failed/,
    );
    f.closed();
  }
});
test("refuse unreviewed or mismatched main before any provider operation", async () => {
  await assert.rejects(
    () =>
      runProductionOwnerSecretTransfer({
        ...options,
        currentMainSha: "b".repeat(40),
        request() {
          throw Error("provider_should_not_be_called");
        },
      }),
    /reviewed_main/,
  );
});

test("lost deployment acknowledgement is reconciled before restoration", async () => {
  const f = provider({ loseBackendDeploymentAck: true });
  const r = await runProductionOwnerSecretTransfer({ ...f, ...options });
  assert.equal(r.matchingValuesVerified, true);
  f.closed();
});
