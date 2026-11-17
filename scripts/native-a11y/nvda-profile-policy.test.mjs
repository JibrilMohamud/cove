import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("isolated native NVDA audit keeps real speech and focus checks while suppressing external update UI", () => {
  const workflow = readFileSync(".github/workflows/native-screen-reader.yml", "utf8");
  const audit = readFileSync("scripts/native-a11y/audit.mjs", "utf8");
  const plugin = readFileSync("scripts/native-a11y/coveSpeech.py", "utf8");
  const profile = workflow.match(/\[general\][\s\S]*?\[development\]/)?.[0];
  assert.ok(profile, "Native NVDA isolated profile missing");
  assert.match(profile, /showWelcomeDialogAtStartup = False/);
  assert.match(profile, /\[update\]\s*(?:#[^\n]*\n\s*)*autoCheck = False\s*startupNotification = False/);
  assert.match(workflow, /nvda_2026\.2\.exe/);
  assert.match(workflow, /Get-AuthenticodeSignature/);
  assert.match(workflow, /\$signature\.Status -ne 'Valid'/);
  assert.match(workflow, /COVE_NVDA_CONFIG=\$profile/);
  assert.match(workflow, /node scripts\/native-a11y\/audit\.mjs/);
  assert.match(audit, /Native active-window title/);
  assert.match(audit, /Sign-in button name and role/);
  assert.match(audit, /Authentication dialog\/focused field/);
  assert.match(audit, /Passage control announces chapter and quoted passage/);
  assert.match(audit, /Dismissed reader panel returns native focus/);
  assert.match(plugin, /extensions\.pre_speech\.register\(self\.capture\)/);
});
