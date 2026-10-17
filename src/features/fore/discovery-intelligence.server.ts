import type { CatalogDB } from "./catalog-model.server";
import {
  tasteControlsSchema,
  literaryKey,
  featureMatchesTag,
  satisfactionEvidence,
  type LiteraryFeature,
  type ReaderTaste,
} from "./discovery-engine";

export async function loadTasteControls(db: CatalogDB, userId: string | null) {
  if (!userId) return tasteControlsSchema.parse({});
  const row = await db
    .prepare("SELECT preferences_json FROM recommendation_taste_controls WHERE user_id=?")
    .bind(userId)
    .first<{ preferences_json: string }>();
  return tasteControlsSchema.parse(row ? JSON.parse(row.preferences_json) : {});
}
export async function saveTasteControls(db: CatalogDB, userId: string, raw: unknown) {
  const controls = tasteControlsSchema.parse(raw);
  await db
    .prepare(
      `INSERT INTO recommendation_taste_controls(user_id,preferences_json,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET preferences_json=excluded.preferences_json,revision=revision+1,updated_at=excluded.updated_at`,
    )
    .bind(userId, JSON.stringify(controls), new Date().toISOString())
    .run();
  return controls;
}
export async function loadLiteraryFeatures(db: CatalogDB, ids: string[]) {
  const result = new Map<string, LiteraryFeature[]>();
  // D1 has a small bind parameter budget. Keep all new multi-ID queries bounded.
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    if (!chunk.length) continue;
    const rows = await db
      .prepare(
        `SELECT product_id,dimension,feature,confidence FROM recommendation_book_features WHERE product_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(...chunk)
      .all<LiteraryFeature & { product_id: string }>();
    for (const row of rows.results)
      result.set(row.product_id, [...(result.get(row.product_id) || []), row]);
  }
  return result;
}
/** Catalog genres are metadata evidence, never substitutes for inferred themes or style. */
export async function loadDiscoveryFeatures(db: CatalogDB, ids: string[]) {
  const features = await loadLiteraryFeatures(db, ids);
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const rows = await db
      .prepare(
        `SELECT p.id product_id,lower(n.name) feature,MIN(0.5,e.confidence) confidence FROM products p JOIN edition_taxonomy_nodes e ON e.edition_id=p.edition_id JOIN storefront_taxonomy_nodes n ON n.id=e.taxonomy_node_id WHERE p.id IN (${chunk.map(() => "?").join(",")}) AND n.visible=1 AND e.confidence>=0.25`,
      )
      .bind(...chunk)
      .all<{ product_id: string; feature: string; confidence: number }>();
    for (const row of rows.results)
      features.set(row.product_id, [
        ...(features.get(row.product_id) || []),
        { dimension: "genres", feature: row.feature, confidence: row.confidence },
      ]);
  }
  return features;
}
export async function buildLiteraryTaste(
  db: CatalogDB,
  userId: string | null,
  features?: Map<string, LiteraryFeature[]>,
) {
  const taste: ReaderTaste = new Map();
  if (!userId) return taste;
  const rows = await db
    .prepare(
      `SELECT product_id,event_type,value,occurred_at FROM recommendation_events WHERE user_id=? AND occurred_at>=datetime('now','-365 days') AND occurred_at>COALESCE((SELECT reset_at FROM recommendation_learning_boundaries WHERE user_id=recommendation_events.user_id),'') ORDER BY occurred_at DESC LIMIT 1000`,
    )
    .bind(userId)
    .all<{ product_id: string; event_type: string; value: number | null; occurred_at: string }>();
  const states = await db
    .prepare(
      `SELECT s.product_id,s.status,s.progress,s.updated_at,r.rating_steps FROM reading_states s LEFT JOIN reviews r ON r.user_id=s.user_id AND r.book_id=s.external_book_id WHERE s.user_id=? AND s.updated_at>COALESCE((SELECT reset_at FROM recommendation_learning_boundaries WHERE user_id=s.user_id),'') ORDER BY s.updated_at DESC LIMIT 300`,
    )
    .bind(userId)
    .all<{
      product_id: string;
      status: string;
      progress: number;
      updated_at: string;
      rating_steps: number | null;
    }>();
  const observed = new Set(rows.results.map((r) => r.product_id));
  for (const state of states.results) {
    if (observed.has(state.product_id)) continue;
    const type =
      state.rating_steps != null
        ? "rating"
        : state.status === "finished"
          ? "completion"
          : state.progress > 0.1
            ? "read_progress"
            : "read_start";
    rows.results.push({
      product_id: state.product_id,
      event_type: type,
      value: state.rating_steps == null ? null : state.rating_steps / 2,
      occurred_at: state.updated_at,
    });
  }
  const bookFeatures =
    features ||
    (await loadDiscoveryFeatures(db, [...new Set(rows.results.map((x) => x.product_id))]));
  const books = new Map<string, { long: number; recent: number; explicit: boolean }>();
  // Latest explicit satisfaction wins over earlier behavior, including an earlier rating.
  for (const row of rows.results) {
    const state = books.get(row.product_id) || { long: 0, recent: 0, explicit: false };
    if (state.explicit) continue;
    const value = satisfactionEvidence(row.event_type, row.value);
    if (!value) continue;
    const age = Math.max(0, (Date.now() - Date.parse(row.occurred_at)) / 86400000);
    if (!Number.isFinite(age)) continue;
    const explicit = ["rating", "loved", "not_for_me", "recommend", "abandon"].includes(
      row.event_type,
    );
    if (explicit) {
      state.long = 0;
      state.recent = 0;
      state.explicit = true;
    }
    state.long = Math.max(
      -8,
      Math.min(explicit ? 8 : 3, state.long + value * Math.pow(0.5, age / 180)),
    );
    state.recent = Math.max(
      -8,
      Math.min(explicit ? 8 : 3, state.recent + value * Math.pow(0.5, age / 14)),
    );
    books.set(row.product_id, state);
  }
  for (const [id, state] of books)
    for (const f of bookFeatures.get(id) || []) {
      const key = literaryKey(f),
        old = taste.get(key) || { long: 0, recent: 0, observations: 0 };
      old.long += state.long * f.confidence;
      old.recent += state.recent * f.confidence;
      old.observations++;
      taste.set(key, old);
    }
  return taste;
}
export async function retrieveLiteraryCandidates(
  db: CatalogDB,
  terms: LiteraryFeature[],
  territory: string,
) {
  const ids = new Set<string>();
  // Each lookup uses the inverted index, rather than scanning catalog JSON at serve time.
  const dimensions = [...new Set(terms.map((t) => t.dimension))].slice(0, 6);
  for (const dimension of dimensions) {
    if (dimension === "genres") {
      const tags = terms
        .filter((t) => t.dimension === "genres")
        .map((t) => t.feature)
        .slice(0, 20);
      const taxonomy = await db
        .prepare("SELECT id,lower(name) name FROM storefront_taxonomy_nodes WHERE visible=1")
        .all<{ id: string; name: string }>();
      const nodes = taxonomy.results
        .filter((n) =>
          tags.some((t) =>
            featureMatchesTag({ dimension: "genres", feature: n.name, confidence: 1 }, t),
          ),
        )
        .slice(0, 20);
      if (nodes.length) {
        const rows = await db
          .prepare(
            `SELECT DISTINCT p.id FROM edition_taxonomy_nodes e JOIN products p ON p.edition_id=e.edition_id WHERE e.taxonomy_node_id IN (${nodes.map(() => "?").join(",")}) AND e.confidence>=0.25 AND p.storefront_status='active' AND EXISTS(SELECT 1 FROM retail_product_availability a WHERE a.product_id=p.id AND a.territory_code=upper(?)) ORDER BY p.id LIMIT 60`,
          )
          .bind(...nodes.map((n) => n.id), territory)
          .all<{ id: string }>();
        rows.results.forEach((r) => ids.add(r.id));
      }
      continue;
    }
    const features = [
      ...new Set(terms.filter((t) => t.dimension === dimension).map((t) => t.feature)),
    ].slice(0, 20);
    const rows = await db
      .prepare(
        `SELECT f.product_id,MAX(f.confidence) confidence FROM recommendation_book_features f JOIN products p ON p.id=f.product_id WHERE f.dimension=? AND f.feature IN (${features.map(() => "?").join(",")}) AND p.storefront_status='active' AND EXISTS(SELECT 1 FROM retail_product_availability a WHERE a.product_id=f.product_id AND a.territory_code=upper(?)) GROUP BY f.product_id ORDER BY confidence DESC,f.product_id LIMIT 40`,
      )
      .bind(dimension, ...features, territory)
      .all<{ product_id: string }>();
    for (const row of rows.results) ids.add(row.product_id);
  }
  return [...ids].slice(0, 200);
}

export async function literaryDiscoveryStatus(db: CatalogDB) {
  const [profiles, indexed, signals] = await Promise.all([
    db
      .prepare(
        "SELECT status,coverage,COUNT(*) count FROM literary_profiles GROUP BY status,coverage",
      )
      .all(),
    db
      .prepare(
        "SELECT COUNT(DISTINCT product_id) books,COUNT(*) features FROM recommendation_book_features",
      )
      .first(),
    db
      .prepare(
        "SELECT event_type,COUNT(*) count FROM recommendation_events WHERE occurred_at>=datetime('now','-30 days') AND event_type IN ('rating','loved','not_for_me','abandon','recommend','completion') GROUP BY event_type",
      )
      .all(),
  ]);
  return {
    version: "cove-discovery-v1",
    profiles: profiles.results,
    indexed,
    signals30d: signals.results,
    calibration:
      "Uncalibrated baseline unless an evaluated discoveryRanker is explicitly activated",
    intentMode:
      "Exact evidence tags and reading-time clauses; arbitrary conversation is not yet supported",
  };
}
