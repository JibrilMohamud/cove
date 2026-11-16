/* eslint-disable prettier/prettier -- Static defense-in-depth; provider settings are authoritative. */
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const source=JSON.parse(readFileSync('vercel.json','utf8'));
test('main Git pushes cannot request an automatic Vercel deployment',()=>{
  assert.equal(source.git?.deploymentEnabled?.main,false);
  assert.equal(source.git?.deploymentEnabled?.['diagnostics/**'],false);
  assert.equal(source.git?.deploymentEnabled?.['docs/**'],false);
  assert.equal(source.git?.deploymentEnabled?.['*'],undefined,'do not disable preview branches');
});
test('protect dual-service routing and do not rely on ignored Services build guards',()=>{
  assert.ok(source.services?.app);
  assert.ok(source.services?.audio_pipeline);
  assert.equal(source.services.app.root,'.');
  assert.equal(source.services.audio_pipeline.root,'scripts');
  assert.ok(source.rewrites?.some(row=>row.source==='/(.*)'&&row.destination?.service==='app'));
  // Vercel's project-level autoAssignCustomDomains:false must be maintained
  // independently. The source ignoreCommand was NOT honored for a prior audit
  // commit; the checked-in git guard is not sufficient release certification.
});
