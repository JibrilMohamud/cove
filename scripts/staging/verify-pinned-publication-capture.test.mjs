import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPTURE_SOURCE,
  CAPTURE_VERSION,
  requirePinnedCapture,
} from "./verify-pinned-publication-capture.mjs";

function evidence() {
  return {
    deployment: { deployments: [{ versions: [{ version_id: CAPTURE_VERSION, percentage: 100 }] }] },
    version: {
      id: CAPTURE_VERSION,
      resources: {
        bindings: [
          { name: "PUBLIC_SOURCE_DB", type: "d1", id: CAPTURE_SOURCE },
          { name: "SOURCE_READER", type: "service", service: "cove-legal-authority-production" },
          { name: "COVE_PUBLICATION_SOURCE_READER_SECRET", type: "secret_text" },
          { name: "COVE_PUBLICATION_CAPTURE_ENABLED", type: "plain_text", text: "1" },
        ],
      },
    },
    subdomain: { enabled: false, previews_enabled: false },
    schedules: { schedules: [{ cron: "* * * * *" }] },
  };
}
test("exact private typed capture is accepted, drift fails closed", () => {
  assert.equal(requirePinnedCapture(evidence()).typedOwnerReader, true);
  for (const change of [
    (x) => { x.deployment.deployments[0].versions[0].percentage = 99; },
    (x) => { x.version.resources.bindings[0].id = "4bd657ac-8789-403e-a28c-93aba8d0a989"; },
    (x) => { x.version.resources.bindings[1].service = "unreviewed"; },
    (x) => { x.version.resources.bindings.push({ name: "DB", type: "d1" }); },
    (x) => { x.subdomain.enabled = true; },
    (x) => { x.subdomain.previews_enabled = true; },
    (x) => { x.schedules.schedules = []; },
  ]) {
    const x = evidence();
    change(x);
    assert.throws(() => requirePinnedCapture(x));
  }
});
