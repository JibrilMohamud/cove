import fs from "node:fs";
import path from "node:path";
import { isolatedD1Config, PERFORMANCE_D1 } from "./isolated-d1-gate.mjs";

const template = fs.readFileSync("wrangler.frontend.staging.toml", "utf8");
const outDir = process.argv[2] || ".";
for (const [role, spec] of Object.entries(PERFORMANCE_D1)) {
  const worker =
    role === "baseline" ? "cove-lazyfacet-control-staging" : "cove-lazyfacet-candidate-staging";
  const namespace = role === "baseline" ? "732010" : "732011";
  const text = isolatedD1Config(template, role, worker, namespace);
  fs.writeFileSync(path.join(outDir, `wrangler.perf-${role}.toml`), text);
  console.log("Created synthetic-only staging config for " + spec.name);
}
