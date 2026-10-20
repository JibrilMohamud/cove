// D1 restricts compound SELECT terms more tightly than local SQLite. Use independent
// scalar minima in a JSON rowset rather than a ten-arm UNION ALL compound query.
const sources = [
  ["merch_campaigns", "starts_at"],
  ["merch_campaigns", "ends_at"],
  ["merch_placements", "starts_at"],
  ["merch_placements", "ends_at"],
  ["merch_collections", "starts_at"],
  ["merch_collections", "ends_at"],
  ["merch_collection_items", "starts_at"],
  ["merch_collection_items", "ends_at"],
  ["merch_experiments", "starts_at"],
  ["merch_experiments", "ends_at"],
];
export const merchandisingScheduleBoundarySql = `SELECT MIN(value) at FROM json_each(json_array(
  ${sources.map(([table, column]) => `(SELECT MIN(unixepoch(${column}))*1000 FROM ${table} WHERE julianday(${column})>julianday('now'))`).join(",\n  ")}
)) WHERE value IS NOT NULL`;
