"use client";

import { Moon, Sun, Monitor } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

type Theme = "light" | "dark" | "system";

const THEME_CHANGE_EVENT = "theme-change";

function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  return (localStorage.getItem("theme") as Theme) || "system";
}

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme) {
  const applied = theme === "system" ? getSystemTheme() : theme;
  document.documentElement.classList.toggle("dark", applied === "dark");
  localStorage.setItem("theme", theme);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

function subscribeToTheme(callback: () => void) {
  // Re-render on manual toggle
  window.addEventListener(THEME_CHANGE_EVENT, callback);
  // Re-render on OS-level color scheme change
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (getStoredTheme() === "system") {
      applyTheme("system");
    }
    callback();
  };
  mediaQuery.addEventListener("change", handler);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, callback);
    mediaQuery.removeEventListener("change", handler);
  };
}

function getSnapshot(): Theme {
  return getStoredTheme();
}

function getServerSnapshot(): Theme {
  return "system";
}

const ICON_PROPS = { className: "h-4 w-4", "aria-hidden": true as const, strokeWidth: 1.5 };

export function ThemeToggle() {
  const theme = useSyncExternalStore(
    subscribeToTheme,
    getSnapshot,
    getServerSnapshot
  );

  const cycleTheme = useCallback(() => {
    let next: Theme;
    if (theme === "system") next = "light";
    else if (theme === "light") next = "dark";
    else next = "system";
    applyTheme(next);
  }, [theme]);

  return (
    <Button variant="ghost" size="icon" onClick={cycleTheme}>
      {theme === "system" ? (
        <Monitor {...ICON_PROPS} />
      ) : theme === "dark" ? (
        <Moon {...ICON_PROPS} />
      ) : (
        <Sun {...ICON_PROPS} />
      )}
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
