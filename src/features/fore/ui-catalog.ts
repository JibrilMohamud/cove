import en from "./locales/en-US.json";
import es from "./locales/es-ES.json";
import fr from "./locales/fr-FR.json";
import de from "./locales/de-DE.json";
import ar from "./locales/ar-SA.json";

export const uiCatalogs: Record<string, Record<string, string>> = {
  "en-US": en,
  "es-ES": es,
  "fr-FR": fr,
  "de-DE": de,
  "ar-SA": ar,
};
export function translateUi(
  locale: string,
  source: string,
  values: Record<string, string | number> = {},
) {
  const message = uiCatalogs[locale]?.[source] ?? source;
  // Substitutions are React text, never HTML. Callers pass complete sentences so
  // translators can reorder values rather than assembling English fragments.
  return message.replace(/\{(\w+)\}/g, (token, key: string) =>
    values[key] === undefined ? token : String(values[key]),
  );
}
