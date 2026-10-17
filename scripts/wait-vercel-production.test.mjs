import assert from "node:assert/strict";
import test from "node:test";
import { vercelCommitStatus, waitForVercelProduction } from "./wait-vercel-production.mjs";

const sha = "f".repeat(40);
const repository = "JibrilMohamud/cove";
const statusResponse = (state) => Response.json({ statuses: [{ context: "Vercel", state }] });

test("production readiness only accepts exact Vercel success", () => {
  assert.equal(
    vercelCommitStatus({ statuses: [{ context: "Vercel", state: "success" }] }),
    "success",
  );
  assert.equal(vercelCommitStatus({ statuses: [{ context: "CI", state: "success" }] }), "pending");
  assert.equal(vercelCommitStatus({ statuses: [] }), "pending");
  assert.equal(vercelCommitStatus({ statuses: [{ context: "Vercel", state: "error" }] }), "error");
});

test("waits for pushed commit success without credentials in output", async () => {
  let calls = 0;
  const result = await waitForVercelProduction({
    repository,
    sha,
    token: "never-print-this",
    timeoutMs: 5000,
    pollMs: 1,
    pause: async () => {},
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, `https://api.github.com/repos/${repository}/commits/${sha}/status`);
      assert.equal(options.headers.Authorization, "Bearer never-print-this");
      return statusResponse(calls < 3 ? "pending" : "success");
    },
  });
  assert.equal(result, "success");
  assert.equal(calls, 3);
});

test("fails closed on deployment errors or GitHub permission failures", async () => {
  await assert.rejects(
    waitForVercelProduction({
      repository,
      sha,
      token: "opaque",
      fetcher: async () => statusResponse("failure"),
    }),
    /did not succeed/,
  );
  await assert.rejects(
    waitForVercelProduction({
      repository,
      sha,
      token: "opaque",
      fetcher: async () => new Response("Forbidden", { status: 403 }),
    }),
    /403/,
  );
  await assert.rejects(
    waitForVercelProduction({
      repository,
      sha,
      token: "",
      fetcher: async () => statusResponse("success"),
    }),
    /token is required/,
  );
});
