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
        return observations;
      }
    }
    observations.edge404++;
    if (attempt < 30) await sleep(2000);
  }
  throw Error("QA browser ingress did not settle before login: edge404=" + observations.edge404);
}
