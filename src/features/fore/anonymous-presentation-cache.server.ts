import { networkCountry, resolveAnonymousHomepageContext } from "./localization.server";

type Context = Awaited<ReturnType<typeof resolveAnonymousHomepageContext>>;
type ContextDb = Parameters<typeof resolveAnonymousHomepageContext>[0];
type Entry = { value: Context; startedAt: number; expiresAt: number };

// Completed public data only. Never retain a Request, session, response,
// pending I/O promise, product, grant, or entitlement across invocations.
const databases = new WeakMap<ContextDb, Map<string, Entry>>();
const ttlMs = 2000;
const maxEntries = 32;

export async function anonymousPresentationContext(
  database: ContextDb,
  request: Request,
  fallbackCountry: string,
  readMetadata: () => ContextDb,
): Promise<Context> {
  const language = request.headers.get("accept-language") || "";
  if (
    language.length > 256 ||
    [
      "authorization",
      "cookie",
      "oai-authenticated-user-id",
      "oai-authenticated-user-email",
      "x-fore-authenticated-user-id",
    ].some((name) => request.headers.has(name))
  )
    return resolveAnonymousHomepageContext(readMetadata(), request, fallbackCountry);

  const network = networkCountry(request, fallbackCountry);
  const key = JSON.stringify([network.country, network.source, fallbackCountry, language]);
  let entries = databases.get(database);
  if (!entries) {
    entries = new Map();
    databases.set(database, entries);
  }
  const startedAt = Date.now();
  const previous = entries.get(key);
  if (previous && previous.expiresAt > startedAt) return structuredClone(previous.value);
  if (previous) entries.delete(key);

  // All simultaneous misses own their own I/O. A rejected/aborted read cannot
  // poison another invocation or leave a pending global entry behind.
  const value = await resolveAnonymousHomepageContext(readMetadata(), request, fallbackCountry);
  const expiresAt = startedAt + ttlMs;
  // Measure freshness from read START, not completion. A slow older read
  // must neither extend staleness nor overwrite a more recent snapshot.
  if (expiresAt > Date.now() && (entries.get(key)?.startedAt ?? -Infinity) <= startedAt) {
    while (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
    entries.set(key, { value: structuredClone(value), startedAt, expiresAt });
  }
  return value;
}
