"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { THEME_COLORS, getServerThemeSnapshot, getThemeSnapshot, setTheme, subscribeTheme } from "./theme";

/** Dark / light switch, the same control as the one in the advaitsi.com header. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getServerThemeSnapshot);
  const isLight = theme === "light";
  const label = isLight ? "Switch to dark theme" : "Switch to light theme";

  useEffect(() => {
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", THEME_COLORS[theme]));
  }, [theme]);

  return (
    <button type="button" className={`adv-theme-toggle ${className}`} onClick={() => setTheme(isLight ? "dark" : "light")} aria-label={label} title={label}>
      {isLight ? <Moon size={17} /> : <Sun size={17} />}
    </button>
  );
}
