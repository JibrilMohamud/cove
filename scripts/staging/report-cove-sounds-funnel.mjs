import {
  buildSoundsFunnelSql,
  summarizeSoundsFunnel,
  renderSoundsFunnelMarkdown,
} from "./cove-sounds-funnel-report-lib.mjs";

const accountId = "d26430caa63ec55f6612e32f36aca5e9";
const token = process.env.CLOUDFLARE_API_TOKEN || "";
if (token.length < 10) throw new Error("Cloudflare Analytics read token is missing.");
const days = Number(process.env.COVE_SOUNDS_REPORT_DAYS || 7);
if (!Number.isSafeInteger(days) || days < 1 || days > 30)
  throw new Error("Reporting window must be between one and thirty days.");
const sql = buildSoundsFunnelSql(days);
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
  {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "content-type": "text/plain",
    },
    body: sql,
    signal: AbortSignal.timeout(30000),
  },
);
if (!response.ok) throw new Error(`Private analytics query failed with HTTP ${response.status}`);
const payload = await response.json();
const rows = payload?.data || payload?.result?.data;
if (!Array.isArray(rows)) throw new Error("Analytics SQL query did not return rows.");
const report = renderSoundsFunnelMarkdown(summarizeSoundsFunnel(rows), days);
process.stdout.write(report + "\n");
const output = process.env.GITHUB_STEP_SUMMARY;
if (output) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(output, report + "\n");
}
