import assert from "node:assert/strict";
import test from "node:test";
import {
  REQUIRED_RIGHTS_COHORTS,
  assertSyntheticRightsDifferentialCoverage,
} from "./rights-differential-coverage.mjs";

function fixture() {
  return {
    checked: 18,
    canonicalAllowed: 9,
    denied: 9,
    viewAllowed: 9,
    mismatchedViewPositive: 0,
    mismatchedCanonicalPositive: 0,
    advancedPolicyStrataCovered: true,
    fullProductionRightsParityCertified: false,
    policyCohorts: Object.fromEntries(
      REQUIRED_RIGHTS_COHORTS.map((cohort) => [
        cohort,
        { candidates: 3, uniquelySelected: 2 },
      ]),
    ),
  };
}

test("representative selected staging cohorts can pass, without ever certifying production", () => {
  assert.equal(assertSyntheticRightsDifferentialCoverage(fixture()), true);
});

test("missing advanced rights witnesses always fail closed", () => {
  for (const cohort of REQUIRED_RIGHTS_COHORTS) {
    const absent = fixture();
    absent.policyCohorts[cohort].candidates = 0;
    absent.policyCohorts[cohort].uniquelySelected = 0;
    assert.throws(() => assertSyntheticRightsDifferentialCoverage(absent), /cohort/);

    const unselected = fixture();
    unselected.policyCohorts[cohort].uniquelySelected = 0;
    assert.throws(() => assertSyntheticRightsDifferentialCoverage(unselected), /cohort/);

    const missing = fixture();
    delete missing.policyCohorts[cohort];
    assert.throws(() => assertSyntheticRightsDifferentialCoverage(missing), /cohort/);
  }
});

test("both directions of legal-view mismatch reject positives", () => {
  for (const key of ["mismatchedViewPositive", "mismatchedCanonicalPositive"]) {
    const failure = fixture();
    failure[key] = 1;
    assert.throws(() => assertSyntheticRightsDifferentialCoverage(failure), /parity/);
  }
});

test("never infer legal parity from a successful but narrow sample", () => {
  for (const mutation of [
    (x) => {
      x.checked = 11;
    },
    (x) => {
      x.checked = 49;
    },
    (x) => {
      x.denied = 0;
    },
    (x) => {
      x.canonicalAllowed = 0;
    },
    (x) => {
      x.advancedPolicyStrataCovered = false;
    },
    (x) => {
      x.fullProductionRightsParityCertified = true;
    },
    (x) => {
      x.canonicalAllowed = NaN;
    },
    (x) => {
      x.viewAllowed = x.checked + 1;
    },
    (x) => {
      x.policyCohorts.explicit_deny.candidates = 25;
    },
    (x) => {
      x.policyCohorts.contract_version.uniquelySelected = 4;
    },
  ]) {
    const result = fixture();
    mutation(result);
    assert.throws(() => assertSyntheticRightsDifferentialCoverage(result));
  }
});
