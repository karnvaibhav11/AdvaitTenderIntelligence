export type Theme = "light" | "dark";

/** Same key and mechanism as advaitsi.com, so a visitor's choice is recognised across the two. */
export const THEME_STORAGE_KEY = "advait-theme";
export const THEME_COLORS: Record<Theme, string> = { dark: "#04060d", light: "#f3f6fb" };

/** Runs before first paint so the page never flashes the wrong theme. Dark is the AdvaitSI default until the user chooses. */
export const themeInitScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});document.documentElement.dataset.theme=t==="light"?"light":"dark"}catch(e){document.documentElement.dataset.theme="dark"}})()`;

const listeners = new Set<() => void>();

export function getThemeSnapshot(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function getServerThemeSnapshot(): Theme {
  return "dark";
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage can be blocked; the choice still applies for this page view */
  }
  document.documentElement.dataset.theme = theme;
  listeners.forEach((l) => l());
}

export function subscribeTheme(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== THEME_STORAGE_KEY) return;
    document.documentElement.dataset.theme = e.newValue === "light" ? "light" : "dark";
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}
