import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/features/fore/Store.tsx", "utf8");
assert.match(source, /const \[homeDiscoveryReady, setHomeDiscoveryReady\] = useState\(false\)/);
assert.match(source, /if \(!home \|\| books\.length === 0 \|\| homeDiscoveryReady\) return/);
assert.match(source, /window\.setTimeout\(\(\) => setHomeDiscoveryReady\(true\), 1_400\)/);
assert.match(source, /window\.clearTimeout\(timer\)/);
assert.equal(
  (source.match(/enabled: home && homeDiscoveryReady && !!visitor && books\.length > 0/g) || []).length,
  2,
  "Both nonessential home discovery queries must wait for visible rights-checked books.",
);
assert.match(source, /const result = useQuery<CatalogResponse>\(\{/);
assert.match(source, /const catalogDisplay = result\.data \?\? fastPreview;/);
console.log("Nonessential home queries defer until after rights-checked book first paint: PASS");
