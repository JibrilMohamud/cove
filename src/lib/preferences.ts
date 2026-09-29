import { useEffect, useState } from "react";

export type AppTheme = "system" | "light" | "dark" | "oled";
export type BlueLightMode = "off" | "auto" | "low" | "medium" | "high";
export type PageTurnStyle = "curl" | "slide" | "scroll";

export type AppPreferences = {
  theme: AppTheme;
  blueLight: BlueLightMode;
  readerFontSize: number;
  readerLineHeight: number;
  pageTurnStyle: PageTurnStyle;
};

const KEY = "fore:preferences:v2";
const EVENT = "fore:preferences-change";

export const defaultPreferences: AppPreferences = {
  theme: "dark",
  blueLight: "auto",
  readerFontSize: 19,
  readerLineHeight: 1.65,
  pageTurnStyle: "curl",
};

export function readPreferences(): AppPreferences {
  if (typeof window === "undefined") return defaultPreferences;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AppPreferences>;
    return { ...defaultPreferences, ...raw };
  } catch {
    return defaultPreferences;
  }
}

export function savePreferences(patch: Partial<AppPreferences>) {
  if (typeof window === "undefined") return defaultPreferences;
  const next = { ...readPreferences(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  return next;
}

export function resolveTheme(theme: AppTheme): Exclude<AppTheme, "system"> {
  if (theme !== "system") return theme;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveWarmth(mode: BlueLightMode): "off" | "low" | "medium" | "high" {
  if (mode !== "auto") return mode;
  const hour = new Date().getHours();
  return hour >= 21 || hour < 6 ? "medium" : "off";
}

export function applyPreferences(preferences: AppPreferences) {
  if (typeof document === "undefined") return;
  const theme = resolveTheme(preferences.theme);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.warmth = resolveWarmth(preferences.blueLight);
  root.classList.toggle("dark", theme === "dark" || theme === "oled");
  root.style.colorScheme = theme === "light" ? "light" : "dark";

  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.content = theme === "oled" ? "#000000" : theme === "dark" ? "#071426" : "#f7f5ef";
  }
}

export function useAppPreferences() {
  const [preferences, setPreferences] = useState<AppPreferences>(defaultPreferences);

  useEffect(() => {
    const update = () => {
      const next = readPreferences();
      setPreferences(next);
      applyPreferences(next);
    };
    update();

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const interval = window.setInterval(update, 60_000);
    media.addEventListener("change", update);
    window.addEventListener(EVENT, update);
    return () => {
      window.clearInterval(interval);
      media.removeEventListener("change", update);
      window.removeEventListener(EVENT, update);
    };
  }, []);

  const update = (patch: Partial<AppPreferences>) => {
    const next = savePreferences(patch);
    setPreferences(next);
    applyPreferences(next);
  };

  return { preferences, update };
}
