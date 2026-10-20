// Frozen exact selector from published runtime b2a5236; independent regression reference.
function hash32(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rootTaxonomy(paths) {
  return paths.map((p) => p.split("/")[0]).filter(Boolean);
}
function diversitySelect(candidates, limit, seed, controls = {}) {
  const chosen = [],
    authorCount = /* @__PURE__ */ new Map(),
    seriesCount = /* @__PURE__ */ new Map(),
    rootCount = /* @__PURE__ */ new Map();
  const remaining = [...candidates],
    diversity = Math.max(0, Math.min(3, Number(controls.diversityStrength ?? 1))),
    exploration = Math.max(0, Math.min(0.5, Number(controls.explorationRate ?? 0.08)));
  while (chosen.length < limit && remaining.length) {
    let bestIndex = 0,
      best = -Infinity;
    const explore =
      chosen.length === Math.min(3, Math.max(0, limit - 1)) &&
      remaining.length > 8 &&
      hash32(`${seed}:explore`) % 1e4 < exploration * 1e4;
    if (explore)
      bestIndex = 5 + (hash32(`${seed}:explore-item`) % Math.min(20, remaining.length - 5));
    if (!explore)
      for (let i = 0; i < remaining.length; i++) {
        const c = remaining[i],
          m = c.meta;
        if (!m) continue;
        let penalty = 0;
        for (const a of m.authorIds) penalty += (authorCount.get(a) || 0) * 1.9;
        for (const s of m.seriesIds) penalty += (seriesCount.get(s) || 0) * 2.4;
        for (const r of rootTaxonomy(m.taxonomyPaths)) penalty += (rootCount.get(r) || 0) * 0.45;
        const jitter = (hash32(`${seed}:${c.productId}`) % 1e3) / 1e5;
        const overlap = Math.max(
          0,
          ...chosen.map((p) => {
            const a = new Set((p.literaryFeatures || []).map((f) => `${f.dimension}:${f.feature}`));
            const b = c.literaryFeatures || [];
            return b.length
              ? b.filter((f) => a.has(`${f.dimension}:${f.feature}`)).length /
                  Math.max(a.size, b.length)
              : 0;
          }),
        );
        const value = c.score - (penalty + overlap * 2) * diversity + jitter;
        if (value > best) {
          best = value;
          bestIndex = i;
        }
      }
    const [pick] = remaining.splice(bestIndex, 1);
    if (!pick?.meta) continue;
    if (chosen.some((c) => c.meta?.workId === pick.meta?.workId)) continue;
    chosen.push(pick);
    for (const a of pick.meta.authorIds) authorCount.set(a, (authorCount.get(a) || 0) + 1);
    for (const s of pick.meta.seriesIds) seriesCount.set(s, (seriesCount.get(s) || 0) + 1);
    for (const r of rootTaxonomy(pick.meta.taxonomyPaths))
      rootCount.set(r, (rootCount.get(r) || 0) + 1);
  }
  return chosen;
}
export { diversitySelect };
