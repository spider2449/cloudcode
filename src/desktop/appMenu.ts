// Pure menu data for the desktop titlebar Theme menu. Kept free of Electron
// and DOM imports so node-based unit tests can cover it: the renderer maps
// the items onto dropdown options (highlight previews, Enter persists via a
// theme-set line to the backend, which emits the theme chat event that
// confirms the choice).
export interface ThemeMenuItem {
  label: string;
  name: string;
  checked: boolean;
}

// Sorted for a stable menu order; the checked item mirrors the saved theme
// (or nothing when the saved name is unknown, e.g. a removed custom theme).
export function themeMenuItems(themeNames: string[], current: string): ThemeMenuItem[] {
  return [...themeNames].sort().map(name => ({ label: name, name, checked: name === current }));
}

// Validates a theme-set request payload without throwing: menu clicks always
// carry known names, anything else is rejected by the caller with an error
// event instead of crashing the backend stdin loop.
export function resolveMenuThemeName(name: unknown, themeNames: string[]): string | undefined {
  return typeof name === "string" && themeNames.includes(name) ? name : undefined;
}
