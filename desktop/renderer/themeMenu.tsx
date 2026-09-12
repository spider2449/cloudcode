import { useEffect, useRef, useState } from "react";
import { THEMES } from "../../src/ui/theme.js";
import { themeMenuItems } from "../../src/desktop/appMenu.js";
import { getConfirmedGuiTheme, previewGuiTheme } from "./themeState.js";

// Clamped arrow-key cursor for the theme list. Pure so node-based unit tests
// can cover the navigation without a DOM.
export function moveHighlight(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index + delta));
}

// Titlebar theme menu with the same semantics as the TUI /config picker:
// browsing (arrows, hover) previews immediately without saving, Enter
// persists through the backend (which broadcasts the theme event the chat
// pane applies), and Esc / click-outside reverts to the confirmed theme.
export function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // Snapshot at open time: the revert target stays fixed for the session
  // even if a theme event lands while the menu is open.
  const confirmedRef = useRef(getConfirmedGuiTheme());
  const items = themeMenuItems(Object.keys(THEMES), confirmedRef.current);

  function openMenu(): void {
    confirmedRef.current = getConfirmedGuiTheme();
    const at = items.findIndex(item => item.name === confirmedRef.current);
    setHighlight(at === -1 ? 0 : at);
    setOpen(true);
  }

  function closeMenu(revert: boolean): void {
    if (revert) previewGuiTheme(confirmedRef.current);
    setOpen(false);
  }

  function browse(index: number): void {
    setHighlight(index);
    previewGuiTheme(items[index]?.name ?? confirmedRef.current);
  }

  async function apply(name: string): Promise<void> {
    setOpen(false);
    await window.cloudcode.setTheme(name);
  }

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        closeMenu(true);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open ]);

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      browse(moveHighlight(highlight, 1, items.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      browse(moveHighlight(highlight, -1, items.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const name = items[highlight]?.name;
      if (name) void apply(name);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    }
  }

  return (
    <div className="theme-menu-wrap" ref={rootRef}>
      <button className="bare-button theme-button" title="Switch theme" aria-haspopup="listbox" aria-expanded={open} onClick={() => { if (open) closeMenu(true); else openMenu(); }}>
        Theme
      </button>
      {open && (
        <ul className="theme-menu" role="listbox" aria-label="Theme" tabIndex={0} ref={listRef} onKeyDown={onKeyDown}>
          {items.map((item, index) => (
            <li key={item.name} role="option" aria-selected={index === highlight}>
              <button
                className={index === highlight ? "active" : ""}
                onMouseEnter={() => { if (index !== highlight) browse(index); }}
                onClick={() => void apply(item.name)}
              >
                <span>{item.checked ? "●" : " "} {item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
