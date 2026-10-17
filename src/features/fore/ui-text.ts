import { createElement, Fragment, useCallback, type ReactNode } from "react";
import { useStorefrontLocale } from "./localization";
import { translateUi } from "./ui-catalog";
export { translateUi } from "./ui-catalog";
export function useUiText() {
  const { uiMessages } = useStorefrontLocale();
  return useCallback(
    (source: string, values?: Record<string, string | number>) =>
      translateUi(uiMessages, source, values),
    [uiMessages],
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
