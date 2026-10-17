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
const selected = Object.fromEntries(
  Object.entries(catalogs).map(([locale, catalog]) => [
    locale,
    Object.fromEntries(Object.entries(catalog).filter(([source, value]) => source !== value)),
  ]),
);
export function selectedUiCatalog(locale: string): Record<string, string> {
  return selected[locale] ?? selected["en-US"];
}
