import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/features/fore/Store.tsx", "utf8");
assert.match(source, /const \[homeDiscoveryReady, setHomeDiscoveryReady\] = useState\(false\)/);
assert.match(source, /if \(!home \|\| books\.length === 0 \|\| homeDiscoveryReady\) return/);
assert.match(source, /window\.setTimeout\(\(\) => setHomeDiscoveryReady\(true\), 1_400\)/);
assert.match(source, /window\.clearTimeout\(timer\)/);
const deferredReadChecks = source.match(
  /enabled: home && homeDiscoveryReady && !!visitor && books\.length > 0/g,
);
assert.equal(
  deferredReadChecks?.length,
  2,
  "Both nonessential home discovery queries must wait for visible rights-checked books.",
);
assert.match(source, /const result = useQuery<CatalogResponse>\(\{/);
assert.match(source, /const catalogDisplay = result\.data \?\? fastPreview;/);
const backendWorkflow = readFileSync(".github/workflows/deploy-persistence-backend.yml", "utf8");
const deployTriggers = backendWorkflow.slice(
  backendWorkflow.indexOf("\non:\n") + 1,
  backendWorkflow.indexOf("\npermissions:\n"),
);
// The stronger release freeze removed ALL main-push production Worker deploys.
// Requiring the old Store.tsx path exclusion would encourage reverting safety.
assert.match(deployTriggers, /\n  workflow_dispatch:\n/);
assert.doesNotMatch(deployTriggers, /\n  push:\n/);
assert.match(backendWorkflow, /environment: cove-production-release-audit/);
assert.match(backendWorkflow, /inputs\.confirm_production_deploy == true/);
assert.match(backendWorkflow, /inputs\.reviewed_main_sha == github\.sha/);
console.log("Optional reads deferred; production persistence deployment stays manual-only: PASS");
