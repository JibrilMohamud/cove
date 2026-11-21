# Cove — unpatched picomatch ReDoS exposure and honest release gating

**Last reviewed:** November 18, 2026 (UTC)

**Advisory:** `GHSA-fc5q-39xc-vjpf` / `CVE-2026-112366`

**Release status:** **NO-GO**; high-severity `npm audit` is mandatory, with no exception, suppression, or skipped check.

## Verified state

The currently published latest upstream `micromatch/picomatch` release remains `4.0.7`, within the advisory's affected range. No confirmed patched npm release exists at the time of this review. The advisory concerns pathological repeated single-branch extglob patterns and potentially attacker-controlled glob input. The npm package is installed transitively by build and tooling packages in Cove's lockfile, including `vite`, `tinyglobby`, `unplugin`, `@tanstack/start-plugin-core`, and `@tanstack/devtools-vite`. It is **not** correct to declare the dependency non-exploitable merely because these consumers look like tooling.

The source-only `scripts/security/check-glob-matcher-runtime-exposure.mjs` records the currently installed version(s) and exact lockfile consumers, then parses customer-serving `src/`, `app/`, and `server/` JavaScript/TypeScript source with the TypeScript compiler. It fails if they directly import, re-export, dynamically import or `require` `picomatch`, `tinyglobby`, or `unplugin`. Mutation/negative fixtures verify direct imports cannot slip past the scanner. This is **one narrow defense-in-depth measure only**, not a proof that compiled dependencies, runtime imports, config paths, or user inputs cannot reach picomatch indirectly.

## Mandatory honest path to a green release

1. Wait for a genuine upstream npm release outside the advisory's affected range **or** replace the vulnerable dependency with a trusted, separately assessed implementation that truly resolves the ReDoS behavior.
2. Regenerate and review npm's lockfile; verify integrity and expected dependency trees, including production and development installs.
3. Run deterministic ReDoS regression cases in bounded, sandboxed child processes in addition to upstream compatibility tests; do **not** run pathological patterns on the live server or in CI's main Node event loop.
4. Require the unchanged `npm audit --audit-level=high` to succeed with the same complete install and all independent source checks. The existing `supply-chain` job must continue to fail whenever either dependency audit or source tests fail or are skipped.
5. Repeat browser, SSR, legal-owner, storefront 503, protected staging, geographic latency/100-RPS and protected rollback acceptance independently.

Do **not** create an alias/fork solely to rename the vulnerable package or hide it from npm audit, add `--omit=dev` as a release workaround, introduce advisory allowlists, or change GitHub's required `supply-chain` status. None of those actions would prove Cove secure.

No production deployment, D1 schema, legal rights, Stripe, Cloudflare Worker, token, routing, or monitoring setting is part of this source-only review.
