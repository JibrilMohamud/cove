// Catalogs are selected on the server and travel with the locale context.
// Keeping this formatter independent prevents every language entering startup JS.
export function translateUi(
  catalog: Record<string, string> | undefined,
  source: string,
  values: Record<string, string | number> = {},
) {
  const message = catalog?.[source] ?? (source === "Primary" ? "Primary navigation" : source);
  // Substitutions are React text, never HTML. Callers pass complete sentences so
  // translators can reorder values rather than assembling English fragments.
  return message.replace(/\{(\w+)\}/g, (token, key: string) =>
    values[key] === undefined ? token : String(values[key]),
  );
}
