import { writeFileSync } from "node:fs";
import { createPhysicalWriterReadTransport } from "./physical-d1-writer-read-transport.mjs";
import { diagnoseUserTokenRemediation } from "./diagnose-user-token-remediation.mjs";

try {
  if (
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    process.argv.length !== 3
  )
    throw Error("local_interactive_only");
  const { get } = createPhysicalWriterReadTransport();
  const report = await diagnoseUserTokenRemediation(get, process.env.CF_USER_AUDIT_TOKEN);
  writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log("Private remediation report written; no credential changed.");
  if (!report.full.verified) process.exitCode = 1;
} catch {
  console.error("Private remediation unavailable; no credential changed.");
  process.exitCode = 1;
}
