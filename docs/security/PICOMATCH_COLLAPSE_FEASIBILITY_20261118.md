# Non-shipping picomatch remediation experiment

All reviewed failed Cove PR workflows still fail the required dependency
audit on GHSA-fc5q-39xc-vjpf. npm currently publishes no picomatch above 4.0.7.
This experiment does not alter that audit result or any installed dependency.
The branch also includes PR #770's published serializer/parser/compiler
remediations; those are independent of this uninstalled parser experiment.

The previous experiment literalized every leading-star repeated branch. Its
assertions incorrectly required `+(*)` to reject an arbitrary string and
did not check the published upstream regression `isMatch('abc', '+(*)c')`.
That is a compatibility regression, not a sufficient security backport.
Do not ship the previous literalizer or infer a fix from its passing job.

The replacement experiment copies exact npm-installed 4.0.7 into a disposable
directory. It authenticates `lib/parse.js` with SHA-256
`4e1e05447668aa1e94366c5516a2bcd8f5fff800cc92b1d0cd7d77703b8618c4`.
It adapts the redundant-repetition collapse proposed in upstream
[PR 237](https://github.com/micromatch/picomatch/pull/237) and
[PR 246](https://github.com/micromatch/picomatch/pull/246) to the published
4.0.7 parser, retaining later published fixes. This is an independent,
unreviewed candidate, not an official upstream fix or release.

For its deliberately narrow simple-segment grammar, a branch containing a
bare star is closed under concatenation: the star can absorb preceding
copies of the same branch. The prototype removes the redundant outer `+`
or replaces the outer `*` with optionality. It preserves valid ordinary
matching, including `+(*)c`, rather than treating those globs as literals.
It excludes quoting, escapes, character classes, globstars, paths, raw regex
and nested syntax. Capture mode uses the existing explicit risky-pattern
literal fallback because collapsing can change repeated capture semantics.
The preexisting `maxExtglobRecursion:false` opt-out remains unchanged.

Local Node 24 evidence:

- Original 4.0.7 stalls on the actual non-match `+(*a)` against 64 `a`
  characters followed by `!`; a subprocess is killed after 1.5 seconds.
- The prototype returns false within the same deadline. Additional 20,000
  character cases run under an enforced subprocess deadline.
- **202,104** differential matches preserve the original ordinary matching
  under default, dot, Windows, Bash and case-insensitive options. Explicit
  tests retain excluded-syntax regexes and capture fallback behavior.
- All **1,983 published upstream tests pass**, against the exact release
  commit `6bb40679c218cefba5d4e9662408c5fdf699a8bb`. The unmodified release
  suite also passes independently. No moving branch supplies the oracle.
- The installed parser, root package manifest and root lockfile are checked
  unchanged in `finally`; the patched copy is removed.

The dedicated read-only CI job repeats this on Node 22 with no production
credentials. Its separate public checkout is pinned to the same release
commit; test-only package scripts are disabled. Full application CI and the
mandatory npm high-severity audit remain independent and unchanged.

**Not release-ready:** the narrow grammar does not prove arbitrary untrusted
glob/regex inputs safe. Excluded patterns and opt-out behavior remain outside
the mitigation; capture behavior deliberately changes. This is not complete
CVE coverage, an installed patch, a replacement package, an audit exception,
or authorization to merge/deploy. A shipping remedy still needs complete
scope review, authenticated distribution, consumer/runtime/build compatibility
and clean mandatory dependency-security checks. Legal ownership, exclusive
D1 writers, real-catalog correctness, 503s, strict performance, LIVE commerce
and protected rollback also remain independent release gates.
