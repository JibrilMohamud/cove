// Auth's exact Supabase subject namespace is part of the canonical buyer ID.
// Keep legacy internal IDs unchanged; never normalize or accept arbitrary
// colon-delimited subjects, and never use this for product/order IDs.
export const ownerUserIdPattern =
  /^(?:[A-Za-z0-9_-]{8,160}|sb:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$(?![\s\S])/;
