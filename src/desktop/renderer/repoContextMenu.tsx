export interface RepoMenuItem {
  id: string;
  label: string;
}

// v1 has one entry; future entries (copy path, collapse) are appended here
// so the component and wiring never change.
export function buildRepoMenuItems(repoName: string): RepoMenuItem[] {
  return [{ id: "new-session", label: `New session in ${repoName}` }];
}

// Keep the fixed-position menu inside the viewport by flipping left/up when
// the cursor is within one menu size of the edge.
export function clampMenuPosition(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = 200,
  menuHeight = 120,
): { left: number; top: number } {
  const left = x + menuWidth > viewportWidth ? Math.max(0, x - menuWidth) : x;
  const top = y + menuHeight > viewportHeight ? Math.max(0, y - menuHeight) : y;
  return { left, top };
}
