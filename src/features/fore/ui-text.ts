import { createElement, Fragment, useCallback, type ReactNode } from "react";
import { useStorefrontLocale } from "./localization";
import { translateUi } from "./ui-catalog";
export { translateUi, uiCatalogs } from "./ui-catalog";
export function useUiText() {
  const { locale } = useStorefrontLocale();
  return useCallback(
    (source: string, values?: Record<string, string | number>) =>
      translateUi(locale, source, values),
    [locale],
  );
}

// React slots let translators reorder linked phrases without accepting HTML.
export function UiText({ source, values }: { source: string; values: Record<string, ReactNode> }) {
  const ui = useUiText();
  return createElement(
    Fragment,
    null,
    ...ui(source)
      .split(/(\{\w+\})/g)
      .map((part, index) => {
        const key = /^\{(\w+)\}$/.exec(part)?.[1];
        return createElement(
          Fragment,
          { key: index },
          key && Object.hasOwn(values, key) ? values[key] : part,
        );
      }),
  );
}
