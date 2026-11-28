import assert from "node:assert/strict";
const qaOrigin = "https://cove-commerce-customer-qa-stage.cove-qa-reads.workers.dev";
const marker = "x-cove-qa-ingress-instance";
function receipt(response, instance) {
  const status = response.status();
  const headers = response.headers();
  const seen = headers[marker];
  // Only an edge 404 before application entry can delay pre-login readiness.
  // A response from the current or an old marked application fails at once.
  if (
    status === 404 &&
    !seen &&
    !headers["x-fore-request-id"] &&
    !headers["x-robots-tag"] &&
    !headers["content-security-policy"]
  )
    return { ready: false, status };
  assert.equal(seen, instance, "QA browser reached an unverified application deployment");
  assert.equal(status, 200, "QA application readiness returned a real failure");
  assert.match(headers["cache-control"] || "", /no-store/);
  return { ready: true, status };
}

// Browser preparation only: GET the homepage and fixed auth-options endpoint.
// No login, checkout, webhook, media grant or refund can be replayed here.
export async function prepareCommerceBrowser({
  page,
  origin,
  headers,
  instance,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  assert.match(instance || "", /^[a-f0-9]{32}$/);
  assert.equal(new URL(origin).origin, qaOrigin);
  const observations = { waves: 0, edge404: 0 };
  let cleanWaves = 0;
  for (let attempt = 1; attempt <= 30; attempt++) {
    observations.waves++;
    const navigation = await page.goto(qaOrigin + "/", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    assert.ok(navigation, "QA browser navigation returned no HTTP response");
    assert.equal(navigation.url(), qaOrigin + "/", "QA browser navigation redirected");
    let ready = receipt(navigation, instance).ready;
    if (ready) {
      assert.match(navigation.headers()["content-type"] || "", /text\/html/);
      const api = await page.context().request.get(qaOrigin + "/api/fore/auth/options", {
        headers,
        maxRedirects: 0,
        timeout: 15000,
      });
      assert.equal(api.url(), qaOrigin + "/api/fore/auth/options");
      ready = receipt(api, instance).ready;
      if (ready) {
        const body = await api.json();
        assert.equal(body?.available, true, "QA auth router is unavailable");
        cleanWaves++;
        if (cleanWaves === 3) return observations;
        if (attempt < 30) await sleep(2000);
        continue;
      }
    }
    cleanWaves = 0;
    observations.edge404++;
    if (attempt < 30) await sleep(2000);
  }
  throw Error("QA browser ingress did not settle before login: edge404=" + observations.edge404);
}

// Control-plane preparation for the exact disposable commerce application.
// A successful upload alone does not mean every workers.dev edge has it.
export async function waitForCommerceDeployment({
  token,
  deployedAfter,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  assert.ok(typeof token === "string" && token.length >= 20);
  assert.ok(Number.isFinite(deployedAfter) && deployedAfter > 0);
  const deadline = now() + 180000;
  while (now() < deadline) {
    const response = await fetchImpl(
      "https://api.cloudflare.com/client/v4/accounts/f51e8ccbc394e2d6016ff8c2c303d54b/workers/scripts/cove-commerce-customer-qa-stage/deployments",
      {
        method: "GET",
        headers: { authorization: "Bearer " + token },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    const body = await response.json();
    assert.ok(response.ok && body?.success === true, "QA deployment control-plane read failed");
    const latest = body.result?.deployments?.[0];
    const created = Date.parse(String(latest?.created_on || ""));
    if (
      Number.isFinite(created) &&
      created >= deployedAfter - 3000 &&
      latest.versions?.length === 1 &&
      latest.versions[0].percentage === 100 &&
      /^[a-f0-9-]{36}$/.test(latest.versions[0].version_id || "") &&
      now() - created >= 75000
    )
      return;
    await sleep(2000);
  }
  throw Error("Fresh 100% QA deployment did not settle before browser preparation");
}
