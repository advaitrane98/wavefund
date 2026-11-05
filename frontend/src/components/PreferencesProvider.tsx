"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Theme = "dark" | "light";
export type DataMode = "mock" | "onchain";

const THEME_KEY = "wavefund:theme";
const DATA_KEY = "wavefund:data-mode";

type Preferences = {
  theme: Theme;
  toggleTheme: () => void;
  dataMode: DataMode;
  setDataMode: (mode: DataMode) => void;
};

const PreferencesContext = createContext<Preferences | null>(null);

export function PreferencesProvider({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [theme, setTheme] = useState<Theme>("dark");
  const [dataMode, setDataModeState] = useState<DataMode>("mock");

  // Read saved preferences once on mount (the inline script already set data-theme).
  useEffect(() => {
    const savedTheme = window.localStorage.getItem(THEME_KEY);
    if (savedTheme === "light" || savedTheme === "dark") setTheme(savedTheme);
    const savedMode = window.localStorage.getItem(DATA_KEY);
    if (savedMode === "mock" || savedMode === "onchain") {
      setDataModeState(savedMode);
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      window.localStorage.setItem(THEME_KEY, next);
      return next;
    });
  }, []);

  const setDataMode = useCallback((mode: DataMode) => {
    setDataModeState(mode);
    window.localStorage.setItem(DATA_KEY, mode);
  }, []);

  const value = useMemo(
    () => ({ theme, toggleTheme, dataMode, setDataMode }),
    [theme, toggleTheme, dataMode, setDataMode],
  );

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): Preferences {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error("usePreferences must be used inside PreferencesProvider");
  return ctx;
}
