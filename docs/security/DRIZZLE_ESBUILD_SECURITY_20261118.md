# Scoped migration-tool compiler security update — November 18

> **November 21 update:** The separate `picomatch` advisory
> [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
> was withdrawn November 18, as *not a security issue*. No audit suppression
> or security-threshold change was made. Exact-head #770 re-runs now PASS the
> full `npm audit --audit-level=high`, `dependency-audit`, independent
> `source-checks`, required `supply-chain`, and the final
> `zod-security-compatibility` audit. All vulnerability totals and NO-GO
> references below document the **November 18 historical snapshot**,
> not the current dependency finding. Production release remains NO-GO on
> independent legal, LIVE commerce, 503, performance and rollback gates.

`drizzle-kit@0.31.11` has a deprecated `@esbuild-kit/esm-loader` dependency
whose `core-utils@3.3.2` resolves a separate `esbuild@0.18.20`. Updating the
root esbuild does not replace this nested compiler. The official
[GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)
affects esbuild through 0.24.2; its published fix starts at 0.25.0.

The candidate adds an exact override **only under `@esbuild-kit/core-utils`**
to use **0.25.12**, the same authentic npm version already locked for
Drizzle's direct esbuild dependency. npm generated the lockfile without
package scripts, forced upgrades or broad dependency refreshes. The only
lock changes relative to this PR's previous head are that nested esbuild and
its platform-specific optional binaries. All other versions and registry
integrities are unchanged. The pinned root esbuild and Drizzle versions
stay unchanged. No dependency is renamed, vendored or hidden from npm audit.

This crosses pre-1.0 esbuild minor versions, so compatibility needs execution
evidence. `scripts/security/check-drizzle-esbuild-compatibility.mjs` checks
the installed core-utils and Drizzle resolution, rejects any remaining
vulnerable esbuild in the lock, executes the real core-utils synchronous CJS
and asynchronous ESM TypeScript transforms with source maps, and executes
the real Drizzle CLI's **generate** command against an isolated temporary
SQLite schema/config. It verifies the generated primary key, required
fields, boolean default and index. The fixture is removed in `finally`.
No migration is applied and no remote database or production config is read.
The independent source-checks job runs this test before the unchanged
mandatory dependency audit aggregation.

Local validation passed a fresh `npm ci --ignore-scripts`, Node 24, the real
compiler/schema test, the existing security gate regressions, TypeScript,
strict lint/format non-regression and the complete storefront build. A fresh
full `npm audit --json` reports **0 moderate, 19 high, 0 critical**: its only
direct advisory is picomatch, with the remaining high entries propagating
through dependency chains. It contains no esbuild advisory. This is not a
clean high-severity audit or approval to release. Exact-head
CI must independently validate the ordinary install, Node 22 compiler test,
source checks, builds, domain/rights/commerce tests and device coverage. This
is a draft remediation candidate until those results are inspected.

**Release remains blocked:** picomatch 4.0.7 still has the independent HIGH
GHSA-fc5q-39xc-vjpf finding with no verified patched upstream release. The
strict `npm audit --audit-level=high` and required `supply-chain` checks are
unchanged and must still fail if that finding remains. This scoped esbuild
fix does not certify any production legal, writer, commerce, performance,
503 incident or rollback gate. No production deployment or data change is
part of this update.
