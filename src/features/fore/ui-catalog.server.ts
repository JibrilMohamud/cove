import en from "./locales/en-US.json";
import es from "./locales/es-ES.json";
import fr from "./locales/fr-FR.json";
import de from "./locales/de-DE.json";
import ar from "./locales/ar-SA.json";

const catalogs: Record<string, Record<string, string>> = {
  "en-US": en,
  "es-ES": es,
  "fr-FR": fr,
  "de-DE": de,
  "ar-SA": ar,
};
// English source phrases and invariant labels need no duplicate wire value.
// These catalogs are immutable build inputs. Project only the requested
// language, rather than preparing all five during the first public request.
// The cache has at most one entry per bundled locale and contains no D1 data.
const selected = new Map<string, Record<string, string>>();
export function selectedUiCatalog(locale: string): Record<string, string> {
  const key = Object.hasOwn(catalogs, locale) ? locale : "en-US";
  let projection = selected.get(key);
  if (!projection) {
    projection = Object.fromEntries(
      Object.entries(catalogs[key]).filter(([source, value]) => source !== value),
    );
    selected.set(key, projection);
  }
  return projection;
}
