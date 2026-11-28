import {
  TRANSFER_ACCOUNT,
  TRANSFER_OWNER,
  TRANSFER_BACKEND,
  TRANSFER_OWNER_ID,
  TRANSFER_VERIFIER,
  TRANSFER_NAMES,
  transferRuntimeModules,
  transferVersion,
  codeModule,
  assertOriginalModules,
} from "./production-owner-secret-transfer.mjs";
const requireTransfer = (ok, code) => {
  if (!ok) throw Error(code);
};
const orderedTransfer = (x) =>
  Array.isArray(x)
    ? x.map(orderedTransfer)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.entries(x)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, v]) => [k, orderedTransfer(v)]),
        )
      : x;
const transferEqual = (a, b) =>
  JSON.stringify(orderedTransfer(a)) === JSON.stringify(orderedTransfer(b));
export async function runProductionOwnerSecretTransfer({
  request,
  send,
  pause,
  reviewedMainSha,
  currentMainSha,
  confirm,
}) {
  requireTransfer(
    confirm === "copy-seven-existing-backend-bindings" &&
      /^[a-f0-9]{40}$/.test(reviewedMainSha || "") &&
      reviewedMainSha === currentMainSha,
    "transfer_reviewed_main_required",
  );
  const root = "/accounts/" + TRANSFER_ACCOUNT,
    wrapper = "__cove_binding_transfer.mjs";
  const api = async (method, path, body, query) => {
    let r;
    try {
      r = await request({
        method,
        path: root + path,
        ...(body === undefined ? {} : { body }),
        ...(query ? { query } : {}),
      });
    } catch {
      throw Error("transfer_provider_request_failed:" + method + ":" + path.split("/").at(-1));
    }
    requireTransfer(r.success === true, "transfer_provider_rejected");
    return r.result;
  };
  const script = (name) => "/workers/scripts/" + name;
  const worker = (name) => "/workers/workers/" + name;
  const active = async (name) => {
    const x = await api("GET", script(name) + "/deployments");
    const v = x.deployments[0]?.versions;
    requireTransfer(v?.length === 1 && v[0].percentage === 100, "transfer_split_deployment");
    return v[0].version_id;
  };
  const version = (name, id) =>
    api("GET", worker(name) + "/versions/" + id, undefined, { include: "modules,sourcemaps" });
  const subdomain = (name) => api("GET", script(name) + "/subdomain");
  const schedules = (name) => api("GET", script(name) + "/schedules");
  const originals = {},
    starting = {};
  for (const name of [TRANSFER_OWNER, TRANSFER_BACKEND, TRANSFER_VERIFIER]) {
    const id = await active(name);
    originals[name] = await version(name, id);
    starting[name] = {
      id,
      subdomain: await subdomain(name),
      schedules: (await schedules(name)).schedules.map((s) => s.cron).sort(),
    };
  }
  const owner = originals[TRANSFER_OWNER],
    backend = originals[TRANSFER_BACKEND],
    verifier = originals[TRANSFER_VERIFIER];
  const binding = (v, n) => v.bindings.find((b) => b.name === n);
  requireTransfer(
    binding(owner, "COVE_RIGHTS_OWNER_ENABLED")?.text === "0" &&
      binding(owner, "COVE_PRODUCTION_BIOSYNC_BRIDGE_ENABLED")?.text === "1",
    "transfer_owner_mode_drift",
  );
  requireTransfer(
    (binding(owner, "PRIMARY_DB")?.database_id || binding(owner, "PRIMARY_DB")?.id) ===
      "4bd657ac-8789-403e-a28c-93aba8d0a989" &&
      (binding(backend, "DB")?.database_id || binding(backend, "DB")?.id) ===
        "4bd657ac-8789-403e-a28c-93aba8d0a989",
    "transfer_primary_drift",
  );
  requireTransfer(
    binding(owner, "LEGAL_AUTHORITY")?.namespace_id === "83d7eadf3957436389a7b072120a9829",
    "transfer_namespace_drift",
  );
  requireTransfer(
    TRANSFER_NAMES.every((n) => binding(backend, n)?.type === "secret_text"),
    "transfer_source_bindings_missing",
  );
  requireTransfer(
    verifier.bindings.length === 0 &&
      starting[TRANSFER_VERIFIER].subdomain.enabled === false &&
      starting[TRANSFER_VERIFIER].subdomain.previews_enabled === false &&
      starting[TRANSFER_VERIFIER].schedules.length === 0,
    "transfer_verifier_not_parked",
  );
  const nonce = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const expires = String(Date.now() + 600000),
    operation = crypto.randomUUID();
  const extra = [
    { name: "COVE_TRANSFER_NONCE", type: "secret_text", text: nonce },
    { name: "COVE_TRANSFER_EXPIRES", type: "plain_text", text: expires },
  ];
  const deployed = {},
    touched = new Set(),
    cleanupErrors = [];
  let tokenId,
    copied = false,
    verification;
  const verifyBindings = (before, after, extraNames) => {
    requireTransfer(
      after.bindings.length === before.bindings.length + extraNames.length,
      "transfer_binding_count",
    );
    for (const b of before.bindings)
      requireTransfer(transferEqual(b, binding(after, b.name)), "transfer_binding_drift");
    requireTransfer(
      extraNames.every((n) => binding(after, n)),
      "transfer_extra_binding_missing",
    );
  };
  const activate = async (name, id, expected) => {
    requireTransfer((await active(name)) === expected, "transfer_active_version_changed");
    deployed[name] = id;
    touched.add(name);
    try {
      await api("POST", script(name) + "/deployments", {
        strategy: "percentage",
        versions: [{ version_id: id, percentage: 100 }],
        annotations: { "workers/message": "One-time owner configuration transfer " + operation },
      });
    } catch (error) {
      // Reconcile a lost deployment acknowledgement without repeating the write.
      if ((await active(name)) !== id) throw error;
    }
    requireTransfer((await active(name)) === id, "transfer_activation_not_confirmed");
  };
  const upload = async (name, body) => {
    body.annotations = {
      "workers/commit_sha": reviewedMainSha,
      "workers/message": "One-time owner configuration transfer " + operation,
    };
    const r = await api("POST", worker(name) + "/versions", body);
    return r.id;
  };
  try {
    const resource = "com.cloudflare.api.account." + TRANSFER_ACCOUNT,
      selector = "com.cloudflare.edge.worker.script." + TRANSFER_OWNER_ID;
    const policy = {
      effect: "allow",
      permission_groups: [{ id: "7e79ec33834341f28dd431ab73884400" }],
      resources: { [resource]: { [selector]: "*" } },
    };
    const token = await api("POST", "/tokens", {
      name: "Cove one-time owner bindings " + operation,
      expires_on: new Date(Date.now() + 3600000).toISOString(),
      policies: [policy],
    });
    tokenId = token.id;
    requireTransfer(
      typeof token.value === "string" && token.value.length >= 20,
      "transfer_token_not_returned",
    );
    const inspected = await api("GET", "/tokens/" + tokenId);
    requireTransfer(
      inspected.status === "active" && inspected.policies?.length === 1,
      "transfer_token_policy",
    );
    const p = inspected.policies[0];
    requireTransfer(
      p.effect === "allow" &&
        p.permission_groups?.length === 1 &&
        p.permission_groups[0].id === policy.permission_groups[0].id &&
        transferEqual(p.resources, policy.resources),
      "transfer_token_scope",
    );
    for (const [name, role] of [
      [TRANSFER_OWNER, "receiver"],
      [TRANSFER_BACKEND, "sender"],
    ]) {
      const old = originals[name],
        code = transferRuntimeModules(old.main_module)[role];
      const added =
        role === "sender"
          ? [...extra, { name: "COVE_TRANSFER_TOKEN", type: "secret_text", text: token.value }]
          : extra;
      const body = transferVersion(old, wrapper, added, [codeModule(wrapper, code)]);
      const id = await upload(name, body),
        read = await version(name, id);
      assertOriginalModules(old, read, wrapper);
      verifyBindings(
        old,
        read,
        added.map((b) => b.name),
      );
      await activate(name, id, starting[name].id);
    }
    const probe = transferRuntimeModules("worker.js").verifier;
    const probeBindings = [
      ...extra,
      {
        name: "BACKEND",
        type: "service",
        service: TRANSFER_BACKEND,
        entrypoint: "CoveBackendBindingTransfer",
      },
      {
        name: "OWNER",
        type: "service",
        service: TRANSFER_OWNER,
        entrypoint: "CoveOwnerBindingProof",
      },
    ];
    const probeId = await upload(TRANSFER_VERIFIER, {
      main_module: "transfer.mjs",
      modules: [codeModule("transfer.mjs", probe)],
      bindings: probeBindings,
      compatibility_date: "2026-11-28",
    });
    await activate(TRANSFER_VERIFIER, probeId, starting[TRANSFER_VERIFIER].id);
    await api("POST", script(TRANSFER_VERIFIER) + "/subdomain", {
      enabled: true,
      previews_enabled: false,
    });
    const domain = await api("GET", "/workers/subdomain");
    requireTransfer(/^[a-z0-9-]+$/.test(domain.subdomain), "transfer_subdomain");
    for (let i = 0; i < 5; i++) {
      const response = await send(
        "https://" + TRANSFER_VERIFIER + "." + domain.subdomain + ".workers.dev/transfer",
        {
          method: "POST",
          headers: { authorization: "Bearer " + nonce, "content-length": "0" },
          body: "",
          redirect: "manual",
        },
      );
      if (response.status === 200) {
        verification = await response.json();
        break;
      }
      requireTransfer(response.status !== 409, "transfer_existing_owner_secret_mismatch");
      await pause(1000 * (i + 1));
    }
    requireTransfer(
      verification?.matching === true &&
        verification.existingOwnerSecretMatched === true &&
        transferEqual(verification.copied, TRANSFER_NAMES),
      "transfer_values_not_verified",
    );
    copied = true;
  } finally {
    const clean = async (label, fn) => {
      try {
        await fn();
      } catch {
        cleanupErrors.push(label);
      }
    };
    if (tokenId)
      await clean("token_revocation", async () => {
        await api("DELETE", "/tokens/" + tokenId);
        const list = await api("GET", "/tokens", undefined, { per_page: 100 });
        requireTransfer(
          list.length < 100 && !list.some((t) => t.id === tokenId && t.status === "active"),
          "transfer_token_still_active",
        );
      });
    if (touched.has(TRANSFER_VERIFIER))
      await clean("verifier_routes", () =>
        api("POST", script(TRANSFER_VERIFIER) + "/subdomain", {
          enabled: false,
          previews_enabled: false,
        }),
      );
    for (const name of [TRANSFER_BACKEND, TRANSFER_OWNER, TRANSFER_VERIFIER])
      if (touched.has(name))
        await clean(name, async () => {
          const id = await active(name),
            live = await version(name, id),
            old = originals[name];
          if (id === starting[name].id) {
            assertOriginalModules(old, live, old.main_module);
            return;
          }
          if (name !== TRANSFER_VERIFIER) assertOriginalModules(old, live, wrapper);
          if (name === TRANSFER_BACKEND || name === TRANSFER_VERIFIER)
            requireTransfer(id === deployed[name], "transfer_cleanup_deployment_drift");
          const additions =
            name === TRANSFER_OWNER
              ? TRANSFER_NAMES.filter(
                  (n) => !binding(old, n) && binding(live, n)?.type === "secret_text",
                ).map((n) => ({ name: n, type: "inherit", version_id: id }))
              : [];
          const restore =
            name === TRANSFER_VERIFIER
              ? {
                  main_module: old.main_module,
                  modules: old.modules,
                  bindings: [],
                  compatibility_date: old.compatibility_date,
                  compatibility_flags: old.compatibility_flags || [],
                  usage_model: old.usage_model,
                }
              : transferVersion(old, old.main_module, additions, [], id);
          const restoredId = await upload(name, restore);
          await activate(name, restoredId, id);
          const actual = await version(name, restoredId);
          assertOriginalModules(old, actual, old.main_module);
          verifyBindings(
            old,
            actual,
            additions.map((b) => b.name),
          );
          requireTransfer(
            !actual.bindings.some((b) => b.name.startsWith("COVE_TRANSFER_")),
            "transfer_ephemeral_binding_remained",
          );
        });
    for (const name of [TRANSFER_OWNER, TRANSFER_BACKEND, TRANSFER_VERIFIER])
      await clean(name + "_triggers", async () => {
        requireTransfer(
          transferEqual(
            (await schedules(name)).schedules.map((s) => s.cron).sort(),
            starting[name].schedules,
          ),
          "transfer_schedule_drift",
        );
        requireTransfer(
          transferEqual(await subdomain(name), starting[name].subdomain),
          "transfer_public_route_drift",
        );
      });
    requireTransfer(
      cleanupErrors.length === 0,
      "transfer_cleanup_incomplete:" + cleanupErrors.join(","),
    );
  }
  requireTransfer(copied, "transfer_not_completed");
  return {
    schema: "cove.production-owner-binding-transfer.v1",
    operation,
    copied: TRANSFER_NAMES,
    matchingValuesVerified: true,
    existingOwnerSecretMatched: true,
    originalRuntimeModulesRestored: true,
    originalBindingsPreserved: true,
    schedulesUnchanged: true,
    publicRoutesUnchanged: true,
    temporaryTokenRevoked: true,
    ephemeralBindingsRemoved: true,
    rightsOwnerEnabled: false,
    primaryBindingRemoved: false,
    writerExclusivityCertified: false,
  };
}
