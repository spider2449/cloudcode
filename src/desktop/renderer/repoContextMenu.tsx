import { useEffect, useRef } from "react";

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

export function RepoContextMenu(props: {
  x: number;
  y: number;
  repoName: string;
  items: RepoMenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pos = clampMenuPosition(props.x, props.y, window.innerWidth, window.innerHeight);
  const { onClose, onSelect } = props;
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const onScroll = (): void => onClose();
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);
  return (
    <div ref={rootRef} className="repo-context-menu" role="menu" aria-label={`Actions for ${props.repoName}`} style={{ left: pos.left, top: pos.top }}>
      {props.items.map(item => (
        <button key={item.id} role="menuitem" onClick={() => onSelect(item.id)}>
          <span>＋</span> {item.label}
        </button>
      ))}
    </div>
  );
}
