// Counts are part of the experiment, not caller-supplied success criteria.
export const coldPhases = Object.freeze({ "new-deployment-cold-20": 20 });
export const burstPhases = Object.freeze({
  "1-concurrent": 1,
  "4-concurrent": 4,
  "8-concurrent": 8,
  "16-concurrent": 16,
  "32-concurrent": 32,
  "25-rps-10s": 250,
  "50-rps-10s": 500,
  "100-rps-20s-phase-1": 2000,
  "100-rps-20s-phase-2": 2000,
  "transport-control-32": 32,
  "transport-25-rps-10s": 250,
  "real-core-delegation": 1,
});
export const isSustainedPhase = (name) => /^100-rps-20s-phase-[12]$/.test(name);

/** Recompute acceptance from measured counts and tails, never a pass label. */
export function validateCapacityEvidence(data, { sha, transport, mode }) {
  const expected = mode === "cold" ? coldPhases : burstPhases;
  const failures = [];
  if (
    !/^[a-f0-9]{40}$/.test(sha || "") ||
    data?.schema !== "cove.strangler-capacity.v2" ||
    data.sha !== sha ||
    data.transport !== transport ||
    data.mode !== mode
  )
    failures.push("artifact-identity");
  const phases = Array.isArray(data?.phases) ? data.phases : [];
  if (phases.length !== Object.keys(expected).length) failures.push("phase-count");
  for (const [name, count] of Object.entries(expected)) {
    const matches = phases.filter((phase) => phase.name === name);
    if (matches.length !== 1) {
      failures.push(name + ":missing-or-duplicate");
      continue;
    }
    const phase = matches[0];
    if (
      phase.offered !== count ||
      phase.delivered !== count ||
      phase.valid !== count ||
      phase.dropped !== 0 ||
      phase.lateArrivals !== 0
    )
      failures.push(name + ":incomplete-arrivals");
    if (
      ![phase.p95Ms, phase.p99Ms, phase.maxMs].every((ms) => Number.isFinite(ms) && ms >= 0) ||
      phase.p95Ms > phase.p99Ms ||
      phase.p99Ms > phase.maxMs ||
      phase.maxMs >= 800 ||
      (isSustainedPhase(name) && (phase.p95Ms >= 600 || phase.p99Ms >= 750)) ||
      phase.pass !== true
    )
      failures.push(name + ":latency-or-correctness");
  }
  return { valid: failures.length === 0, failures };
}
