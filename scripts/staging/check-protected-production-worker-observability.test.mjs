/* eslint-disable prettier/prettier -- Release-only static privacy and deploy guards. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const checkedIn=readFileSync('wrangler.backend.production.toml','utf8');
const deploy=readFileSync('.github/workflows/deploy-persistence-backend.yml','utf8');
const handler=readFileSync('src/features/fore/api.server.ts','utf8');
function assertConfig(content){
  const observability=content.split('[observability]\n');
  assert.equal(observability.length,2,'exactly one observability stanza expected');
  const header=observability[1].split('\n[')[0];
  assert.match(header,/^enabled = true$/m);
  assert.match(header,/^head_sampling_rate = 1$/m);
  assert.match(header,/^redact_query_string = true$/m,'never persist query string');
  const logs=content.split('[observability.logs]\n');
  assert.equal(logs.length,2,'exactly one observability logs stanza expected');
  const section=logs[1].split('\n[')[0];
  assert.match(section,/^enabled = true$/m);
  assert.match(section,/^invocation_logs = true$/m);
  assert.match(section,/^head_sampling_rate = 1$/m);
}
test('checked-in and generated Wrangler configs both include redacted full invocation capture',()=>{
  assertConfig(checkedIn);
  // Actual deployment uses dynamically generated Wrangler configuration, not the
  // checked-in file. Read its shell heredoc, stripping indentation.
  const start=deploy.indexOf('          cat > wrangler.backend.deploy.toml <<EOF\n');
  const end=deploy.indexOf('\n          EOF',start);
  assert.ok(start>0&&end>start,'generated production Wrangler heredoc exists');
  const body=deploy.slice(start,end).split('\n').slice(1)
    .map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
  assertConfig(body);
});
test('real production workflow remains opt-in, migrations default off',()=>{
  assert.match(deploy,/vars\.COVE_PRODUCTION_PERSISTENCE_AUTO_DEPLOY == '1'/);
  assert.match(deploy,/github\.event_name == 'workflow_dispatch' && inputs\.apply_migrations == true/);
  assert.match(deploy,/apply_migrations:[\s\S]{0,220}?default: false/);
});
test('api-server primary error paths cannot emit raw exception messages to Workers Logs',()=>{
  assert.doesNotMatch(handler,/console\.error\(\s*"Cove service error",[\s\S]{0,150}e\.message/);
  assert.match(handler,/console\.error\("Cove service error; request failed closed"\)/);
  for(const marker of [
    'Initial search index sync failed','Commercial catalog search failed closed',
    'Catalog asset maintenance failed','Regional search sync failed',
    'Catalog search sync failed','Reading Journey generation failed',
    'Annotation version anchor snapshot failed'
  ]){
    const re=new RegExp('console\\.(?:warn|error)\\("'+marker+'",\\s*(?:error|e)\\)');
    assert.doesNotMatch(handler,re,marker);
  }
});
test('source changes cannot silently deploy Worker or promote the storefront',()=>{
  assert.match(deploy,/if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| \(github\.ref == 'refs\/heads\/main' && vars\.COVE_PRODUCTION_PERSISTENCE_AUTO_DEPLOY == '1'\) \}\}/);
  assert.doesNotMatch(deploy,/if: \$\{\{ github\.event_name == 'push' \}\}/);
});

const entry=readFileSync('src/persistence-backend.worker.ts','utf8');

test('primary persistence entrypoint logs do not expose raw exceptions, IDs or job data',()=>{
  // All Worker entrypoint log sites are reviewed as a fixed inventory.
  // Changing the count requires an explicit new privacy review.
  assert.equal((entry.match(/console\.(?:warn|error|info|log|debug)\(/g)||[]).length,31);
  for(const unsafe of [
    'console.warn("Catalog search sync failed", error)',
    'console.warn("Unable to persist Cove audio trigger diagnostic", error)',
    'console.error("Cove scheduled queue failed", name, error)',
    'console.info("Cove BioSync short-track transcript cached", row.edition_id',
    'console.warn("Cove minute maintenance failed", String(error)',
    'console.error("Cove scheduled BioSync trigger failed", result.reason)',
    'console.error("Cove scheduled audio trigger failed", result.reason)',
    'console.warn("Cove published soundtrack rights audit", JSON.stringify(rights))',
    'console.info("Cove soundtrack R2 import", JSON.stringify(result))',
    'console.error("Hosted BioSync transcription failed", editionId',
    'console.error("Community tournament advancement failed", error)',
    'console.error("Cove scheduled ingestion failed", controller.cron, error)',
    'console.error("Regional EPUB repair failed", String(error)',
    'console.info(JSON.stringify({ event: "account_erasure_tick", ...result }))'
  ])assert.equal(entry.includes(unsafe),false,'unsafe Worker logger: '+unsafe);
  assert.match(entry,/console\.info\(JSON\.stringify\(\{ event: "account_erasure_tick", completed: true \}\)\)/);
  assert.match(entry,/console\.info\(JSON\.stringify\(\{ event: "cove_queue_tick", name, completed: true \}\)\)/);
  assert.match(entry,/console\.warn\("Cove published soundtrack rights audit"\)/);
  assert.match(entry,/console\.error\("Cove service error; request failed closed"\)|console\.error\("Cove scheduled queue failed", name\)/);
});
