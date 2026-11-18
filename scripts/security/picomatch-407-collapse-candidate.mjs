import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const PUBLISHED_PARSER_SHA256 =
  "4e1e05447668aa1e94366c5516a2bcd8f5fff800cc92b1d0cd7d77703b8618c4";
export const PUBLISHED_COMMIT = "6bb40679c218cefba5d4e9662408c5fdf699a8bb";

/** NON-SHIPPING experiment inspired by micromatch/picomatch#237 and #246. */
export function collapseCandidate(parser) {
  assert.equal(
    createHash("sha256").update(parser).digest("hex"),
    PUBLISHED_PARSER_SHA256,
    "Refuse any source other than the exact published 4.0.7 parser",
  );
  const anchor = "const repeatedExtglobRecursion = pattern => {";
  const helper = `// Experimental backport: plain segment branches containing an ordinary
// star are closed under concatenation. Remove the redundant OUTER quantifier.
// Exclude quotes, escapes, paths, globstars, classes and raw regex syntax.
const isCovePlainStarBranch = branch => {
  return /^[a-zA-Z0-9_., ?*-]+$/.test(branch) &&
    branch.includes('*') && !branch.includes('**') &&
    branch.trim() === branch;
};

`;
  assert.equal(parser.split(anchor).length, 2);
  let patched = parser.replace(anchor, helper + anchor);
  const end = "  return { risky: false };\n};\n\n/**\n * Parse the given input string.";
  assert.equal(patched.split(end).length, 2);
  patched = patched.replace(
    end,
    `  if (branches.length === 1 && isCovePlainStarBranch(branches[0])) {
    // Collapsing changes repetition captures. Use the existing explicit risky
    // literal fallback rather than silently return different captures.
    return options.capture ? { risky: true } : { risky: false, collapse: true };
  }

` + end,
  );
  const close = "    let output = token.close + (opts.capture ? ')' : '');";
  assert.equal(patched.split(close).length, 2);
  patched = patched.replace(
    close,
    `    if (analysis.collapse === true && (token.type === 'plus' || token.type === 'star')) {
      token.close = token.type === 'plus' ? ')' : ')?';
    }

` + close,
  );
  return patched;
}
