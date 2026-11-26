// A provider 404 is not an application authentication receipt. Require a
// matching run-instance marker and explicit denial from the deployed code.
import assert from "node:assert/strict";

export async function verifyDetachedBridge({
  origin,
  gate,
  instance,
  fetcher = fetch,
  pause = () => new Promise((resolve) => setTimeout(resolve, 2000)),
  attempts = 30,
}) {
  assert.match(instance, /^[a-f0-9]{32}$/);
  assert.match(gate, /^[a-f0-9]{64}$/);
  const wrong = (gate[0] === "0" ? "1" : "0") + gate.slice(1);
  const observations = {};
  const probes = [
    { name: "authorized", credential: gate, expected: 204 },
    { name: "anonymous", credential: null, expected: 401 },
    { name: "invalid", credential: wrong, expected: 401 },
    { name: "authorized-confirmation", credential: gate, expected: 204 },
  ];

  for (let attempt = 0; attempt < attempts; attempt++) {
    let complete = true;
    for (const { name, credential, expected } of probes) {
      const response = await fetcher(origin + "/publish", {
        method: "POST",
        body: "probe:" + instance,
        headers: credential === null ? {} : { authorization: "Bearer " + credential },
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      const status = response?.status || 0;
      const marker = response?.headers.get("x-cove-qa-bridge-instance");
      const noStore = response?.headers.get("cache-control") === "no-store";
      const key = name + ":" + status + ":" + (marker === instance ? "instance" : "unverified");
      observations[key] = (observations[key] || 0) + 1;
      await response?.body?.cancel();
      // A success on an unauthenticated request is a security failure, not
      // something to retry until a different edge happens to deny it.
      if (expected === 401 && status >= 200 && status < 300)
        throw Error("Detached bridge accepted unauthorized " + name + " probe");
      if (marker === instance) {
        assert.equal(status, expected, "Detached bridge " + name + " status mismatch");
        assert.ok(noStore, "Detached bridge response must be non-cacheable");
      } else {
        // A routing 404, temporary provider error or unmarked 401 proves
        // nothing about the application. Never count it as verified denial.
        if (
          status !== 0 &&
          status !== 404 &&
          status !== 401 &&
          status !== 429 &&
          !(status >= 500 && status <= 599) &&
          !(expected === 204 && status === 204)
        )
          throw Error("Unexpected detached bridge provider status: " + name + ":" + status);
        complete = false;
        break;
      }
    }
    if (complete) return observations;
    if (attempt + 1 < attempts) await pause();
  }
  throw Error(
    "Detached bridge readiness/authorization unverified: " + JSON.stringify(observations),
  );
}
