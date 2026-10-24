/**
 * Offline label evaluation, not an acoustic model or a proof that labels are
 * authentic. An independent, blinded listening panel must supply real data.
 * Never turn this numeric result into rights or customer serving permission.
 */
export const focusEvaluationLimits = Object.freeze({
  minimumMasters: 600,
  minimumDistracting: 200,
  minimumQuiet: 200,
  minimumGroupDistracting: 40,
  maximumFalseAcceptanceUpper95: 0.05,
  maximumGroupFalseAcceptanceUpper95: 0.15,
  minimumQuietRecall: 0.55,
});
function wilsonUpper95(bad, total) {
  if (!total) return 1;
  const z = 1.96, p = bad / total;
  const center = p + (z * z) / (2 * total);
  const uncertainty = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return Math.min(1, (center + uncertainty) / (1 + (z * z) / total));
}
export function evaluateQuietReadingLabels(rows, limits = focusEvaluationLimits) {
  if (!Array.isArray(rows)) throw Error("A blind-listening dataset is required");
  const ids = new Set(), groups = new Map();
  let distracting = 0, quiet = 0, falseAccept = 0, quietAccepted = 0;
  for (const row of rows) {
    if (!/^[0-9a-f]{64}$/.test(row?.masterSha256 || "") ||
        ids.has(row.masterSha256) || !/^[a-z_-]{2,40}$/.test(row?.family || "") ||
        !Array.isArray(row.ratings) || row.ratings.length < 3 ||
        !["quiet_focus","gentle_background","distracting","needs_vocal_evidence"].includes(row.predictedTier))
      throw Error("Malformed or duplicate blind-listening record");
    const raters = new Set();
    let panelQuiet = 0, panelDistracting = 0;
    for (const vote of row.ratings) {
      if (!/^[a-zA-Z0-9_-]{3,60}$/.test(vote?.rater || "") || raters.has(vote.rater) ||
          !["quiet","distracting"].includes(vote.label))
        throw Error("Independent blind-panel votes are required");
      raters.add(vote.rater);
      if (vote.label === "quiet") panelQuiet++; else panelDistracting++;
    }
    ids.add(row.masterSha256);
    const humansDistracting = panelDistracting > panelQuiet;
    if (panelDistracting === panelQuiet) throw Error("Ambiguous panel consensus");
    const accepted = ["quiet_focus","gentle_background"].includes(row.predictedTier);
    const group = groups.get(row.family) || { distracting:0, falseAccept:0 };
    if (humansDistracting) {
      distracting++;
      group.distracting++;
      if (accepted) { falseAccept++; group.falseAccept++; }
    } else {
      quiet++;
      if (accepted) quietAccepted++;
    }
    groups.set(row.family,group);
  }
  const byGroup = [...groups.entries()].map(([family,x])=>({
    family,
    ...x,
    falseAcceptanceUpper95: Number(wilsonUpper95(x.falseAccept,x.distracting).toFixed(4)),
  }));
  const upper = wilsonUpper95(falseAccept,distracting);
  const recall = quiet ? quietAccepted / quiet : 0;
  const pass = rows.length >= limits.minimumMasters &&
    distracting >= limits.minimumDistracting &&
    quiet >= limits.minimumQuiet &&
    upper <= limits.maximumFalseAcceptanceUpper95 &&
    recall >= limits.minimumQuietRecall &&
    byGroup.every(x=>x.distracting>=limits.minimumGroupDistracting &&
      x.falseAcceptanceUpper95 <= limits.maximumGroupFalseAcceptanceUpper95);
  return {
    pass,
    sampleCount:rows.length,
    distracting,
    quiet,
    falseAccept,
    falseAcceptanceUpper95:Number(upper.toFixed(4)),
    quietRecall:Number(recall.toFixed(4)),
    byGroup,
    provenance:"external_blind_listening_attestation_required",
    note:"This metric does not establish source licenses, customer utility or provenance of human labels.",
  };
}
if (process.argv[1]?.endsWith("/quiet-reading-benchmark.mjs")) {
  const { readFile } = await import("node:fs/promises");
  const path = process.argv.find(x=>x.startsWith("--dataset="))?.slice(10);
  if (!path) throw Error("Provide a genuine offline --dataset=... JSON file");
  const report = evaluateQuietReadingLabels(JSON.parse(await readFile(path,"utf8")));
  console.log(JSON.stringify(report,null,2));
  if (!report.pass) process.exitCode=1;
}
