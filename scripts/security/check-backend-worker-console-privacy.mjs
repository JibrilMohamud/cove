import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// This audits ONLY logging in the Worker entrypoint. Imported modules and
// Cloudflare invocation/error logging require separate privacy review.
const PATH = "src/persistence-backend.worker.ts";
const raw = readFileSync(PATH, "utf8");
const wrangler = readFileSync("wrangler.backend.production.toml", "utf8");
const levels = new Set(["warn", "error", "info", "log", "debug"]);
const numericTemplates = new Set([
  "`Cove track backlog ${trackState.queued}; filling ${trackState.slots} of 2 preparation slots.`",
  "`Cove audio discovery paused with ${pendingTracks} pending track jobs.`",
]);
function inspect(source) {
  const file = ts.createSourceFile(PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(file.parseDiagnostics.length, 0, "Worker must parse without TypeScript errors");
  const calls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console" &&
      levels.has(node.expression.name.text)
    ) {
      calls.push(node);
      assert.equal(node.arguments.length, 1, "Logs cannot receive raw error or ID arguments");
      const arg = node.arguments[0];
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        assert.ok(arg.text.length > 0 && arg.text.length < 160, "Unexpected long log");
      } else if (ts.isConditionalExpression(arg)) {
        assert.equal(
          arg.condition.getText(file),
          "isD1QuotaError(error)",
          "Only the reviewed D1 quota classifier may branch on a dynamic error",
        );
        assert.ok(ts.isStringLiteral(arg.whenTrue) && ts.isStringLiteral(arg.whenFalse));
        assert.equal(arg.whenTrue.text, "Cove scheduled queue D1 quota blocked");
        assert.equal(arg.whenFalse.text, "Cove scheduled queue failed");
      } else if (ts.isTemplateExpression(arg)) {
        assert.ok(
          numericTemplates.has(arg.getText(file)),
          "Only two reviewed numeric-only backlog templates may be logged",
        );
      } else {
        assert.fail("Unreviewed Worker logger argument: " + ts.SyntaxKind[arg.kind]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(calls.length, 31, "Worker logger inventory must be explicitly re-reviewed");
  return true;
}
// The scheduled Vercel audio trigger writes a status-only diagnostic to D1.
// The remote error body must NEVER be read, logged, or stored as configuration.
function inspectTriggerDiagnostic(source) {
  const file = ts.createSourceFile(PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fn = file.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "triggerVercelAudio",
  );
  assert.ok(fn, "Scheduled audio trigger must remain reviewable");
  const trigger = fn.getText(file);
  assert.doesNotMatch(trigger, /response\.(?:text|json|arrayBuffer)\s*\(/);
  // Cancel untrusted response streams without reading them or delaying D1 status receipt.
  const failedResponse = trigger.indexOf("if (!response.ok)");
  const cancel = trigger.indexOf("void response.body?.cancel().catch(() => {});");
  const firstReceipt = trigger.indexOf(
    'persistAudioTriggerDiagnostic(env, "audio_trigger_last_timeout"',
  );
  assert.ok(failedResponse >= 0 && cancel > failedResponse && firstReceipt > cancel);
  const allowed = new Set(["path", "status", "disposition"]);
  const keys = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === "persistAudioTriggerDiagnostic"
    ) {
      const details = node.arguments[2];
      assert.ok(
        ts.isObjectLiteralExpression(details),
        "Status receipt must remain a literal object",
      );
      for (const property of details.properties) {
        assert.ok(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property));
        const name = property.name.getText(file);
        assert.ok(
          allowed.has(name),
          "No upstream body, error, identities, or secrets in D1 status",
        );
        const value = ts.isPropertyAssignment(property) ? property.initializer.getText(file) : name;
        assert.ok(
          (name === "path" && value === "path") ||
            (name === "status" && value === "response.status") ||
            (name === "disposition" && value === '"in-flight"'),
          "Only exact reviewed fields may reach persistent status receipts",
        );
        keys.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  assert.equal(keys.filter((k) => k === "status").length, 3);
  assert.equal(keys.filter((k) => k === "path").length, 3);
  return true;
}
assert.ok(inspectTriggerDiagnostic(raw));
const upstreamBodyMutation = raw.replace(
  '        status: response.status,\n        disposition: "in-flight",',
  '        status: response.status,\n        body: await response.text(),\n        disposition: "in-flight",',
);
assert.notEqual(upstreamBodyMutation, raw);
assert.throws(() => inspectTriggerDiagnostic(upstreamBodyMutation));
const cancelMutation = raw.replace("void response.body?.cancel().catch(() => {});", "");
assert.notEqual(cancelMutation, raw);
assert.throws(() => inspectTriggerDiagnostic(cancelMutation));

assert.ok(inspect(raw));
assert.doesNotMatch(
  wrangler,
  /^\[observability(?:\.|\])/,
  "Production Worker log collection cannot be enabled before full imported-module and invocation-log privacy review",
);
for (const [existing, unsafe] of [
  [
    'console.warn("Catalog search sync failed")',
    'console.warn("Catalog search sync failed", error)',
  ],
  ['console.error("Regional EPUB repair failed")', "console.error(String(error))"],
  [
    'console.info("Cove BioSync short-track transcript cached")',
    'console.info("Cove BioSync short-track transcript cached", editionId, trackId)',
  ],
  [
    'console.warn("Soundtrack import failed")',
    'console.warn("Soundtrack import failed", JSON.stringify(result))',
  ],
  [
    'console.info("Cove scheduled queue tick completed")',
    'console.info(JSON.stringify({ event: "cove_queue_tick", result }))',
  ],
]) {
  assert.ok(raw.includes(existing), "Expected log regression site must be present");
  assert.throws(() => inspect(raw.replace(existing, unsafe)));
}
console.log(
  "PASS: Worker entrypoint logs include no raw exceptions, entitlement/catalog IDs, rights objects or queue result payloads.",
);
console.log(
  "BLOCKED: production Workers Logs cannot be enabled without full imported-module/invocation-log review.",
);
