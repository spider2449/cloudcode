import React, { createContext, useContext, type ReactNode } from "react";
import { THEMES, type Theme } from "./theme.js";

const ThemeContext = createContext<Theme>(THEMES.dark);

export function ThemeProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
