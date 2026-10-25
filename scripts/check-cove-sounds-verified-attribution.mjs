/* eslint-disable prettier/prettier -- Focused privacy and referral assertions. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const built = await build({
  entryPoints: ["src/features/fore/cove-sounds-attribution.ts"],
  bundle: true, platform: "node", target: "es2022", format: "esm",
  write: false, logLevel: "silent",
});
const attribution = await import("data:text/javascript;base64," +
  Buffer.from(built.outputFiles[0].text).toString("base64"));
const state = new Map();
globalThis.window = {};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { doNotTrack: "0", globalPrivacyControl: false },
});
globalThis.sessionStorage = {
  getItem: (key) => state.get(key) || null,
  setItem: (key, value) => { state.set(key, value); },
  removeItem: (key) => { state.delete(key); },
};
assert.equal(attribution.soundsCheckoutReferral(), null, "No phantom referral");
attribution.rememberSoundsBookReferral("gothic-hour", "cm_7");
assert.deepEqual(attribution.soundsCheckoutReferral(), {
  soundsStation: "gothic-hour", soundsRecording: "cm_7",
});
attribution.rememberSoundsBookReferral("not-a-station", "cm_9");
assert.equal(attribution.soundsCheckoutReferral().soundsStation, "gothic-hour");
navigator.globalPrivacyControl = true;
assert.equal(attribution.soundsCheckoutReferral(), null, "GPC suppresses checkout attribution");
navigator.globalPrivacyControl = false;
navigator.doNotTrack = "1";
assert.equal(attribution.soundsCheckoutReferral(), null, "DNT suppresses checkout attribution");
navigator.doNotTrack = "0";
const originalNow = Date.now;
try {
  Date.now = () => originalNow() + 2 * 60 * 60_000 + 1;
  assert.equal(attribution.soundsCheckoutReferral(), null, "Expired referral must not attribute purchases");
} finally { Date.now = originalNow; }
const backend = readFileSync("src/features/fore/commerce.server.ts", "utf8");
assert.ok(backend.includes("commerce_sounds_purchase_attribution(order_id,station_slug,recording_id,captured_at)"));
assert.ok(backend.includes("stationBySlug(input.soundsStation)"), "Checkout station allowlist required");
assert.ok(backend.includes("input.soundsRecording"), "Recording is optional but bounded");
const api = readFileSync("src/features/fore/api.server.ts", "utf8");
assert.ok(api.includes("edgeCountry"), "Anonymous collector territory is edge-derived");
assert.ok(!api.includes('handleSoundsAnalytics(request, env, "/sounds/events", "ZZ")'));
const analytics = readFileSync("src/features/fore/cove-sounds-analytics.server.ts", "utf8");
assert.ok(analytics.includes('request.headers.get("sec-gpc")'), "Server GPC enforced");
assert.ok(analytics.includes('request.headers.get("dnt")'), "Server DNT enforced");
console.log("PASS: referral TTL, station validation, GPC/DNT opt-out, canonical checkout persistence and edge country");
