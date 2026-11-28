import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { discoverLegalScopes } from "./current-legal-scope-discovery.mjs";

let db;
try {
  if (
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    process.argv.length !== 4
  )
    throw Error("local_interactive_only");
  db = new DatabaseSync(process.argv[2], { readOnly: true });
  const report = discoverLegalScopes(db);
  writeFileSync(process.argv[3], JSON.stringify(report) + "\n", { flag: "wx", mode: 0o600 });
  console.log(
    JSON.stringify({
      products: report.manifest.products.length,
      scopes: report.manifest.scopes.length,
      unresolvedGrants: report.manifest.unresolvedGrantIds.length,
      productsWithoutRecordedScopes: report.manifest.productsWithoutRecordedScopes.length,
      manifestSha256: report.manifestSha256,
      completeOwnerInventory: false,
      authorizing: false,
    }),
  );
} catch {
  console.error("Scope discovery failed; no publication authorized.");
  process.exitCode = 1;
} finally {
  db?.close();
}
