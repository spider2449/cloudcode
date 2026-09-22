import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { Workspace } from "./bridge.js";

// Keep keyboard navigation bounded to the rendered project list.
export function moveProjectHighlight(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index + delta));
}

interface ProjectMenuProps {
  workspaces: Workspace[];
  active: string | undefined;
  onSelect: (workspaceId: string) => void;
}

interface PopupPosition {
  left: number;
  top: number;
  width: number;
}

export function ProjectMenu({ workspaces, active, onSelect }: ProjectMenuProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [position, setPosition] = useState<PopupPosition>();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  function positionMenu(): void {
    const anchor = rootRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const width = Math.min(Math.max(anchor.width, 270), window.innerWidth - 16);
    const estimatedHeight = Math.min(360, workspaces.length * 54 + 12);
    const left = Math.min(anchor.left, Math.max(8, window.innerWidth - width - 8));
    const below = anchor.bottom + 6;
    const top = below + estimatedHeight <= window.innerHeight - 8
      ? below
      : Math.max(8, anchor.top - estimatedHeight - 6);
    setPosition({ left, top, width });
  }

  function openMenu(): void {
    const current = workspaces.findIndex(workspace => workspace.id === active);
    setHighlight(current === -1 ? 0 : current);
    positionMenu();
    setOpen(true);
  }

  function closeMenu(): void {
    setOpen(false);
  }

  function selectHighlighted(): void {
    const workspace = workspaces[highlight];
    if (!workspace) return;
    onSelect(workspace.id);
    closeMenu();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight(index => moveProjectHighlight(index, 1, workspaces.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(index => moveProjectHighlight(index, -1, workspaces.length));
    } else if (event.key === "Home") {
      event.preventDefault();
      setHighlight(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHighlight(Math.max(0, workspaces.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectHighlighted();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
  }

  useEffect(() => {
    if (!open) return;
    menuRef.current?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) closeMenu();
    };
    const onViewportChange = (): void => positionMenu();
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open]);

  return (
    <div className="project-menu-control" ref={rootRef}>
      <span className="project-menu-icon" aria-hidden="true">⌘</span>
      <button
        className="project-menu-trigger"
        type="button"
        title="Switch project"
        aria-label="Active project"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={workspaces.length === 0}
        onClick={() => { if (open) closeMenu(); else openMenu(); }}
      >
        <span className="project-menu-label">{workspaces.find(workspace => workspace.id === active)?.name ?? "No project"}</span>
        <span className="project-menu-chevron" aria-hidden="true">⌄</span>
      </button>
      {open && position && createPortal(
        <div
          className="project-menu-popup"
          role="listbox"
          aria-label="Projects"
          tabIndex={0}
          ref={menuRef}
          style={{ left: position.left, top: position.top, width: position.width }}
          onKeyDown={onKeyDown}
        >
          {workspaces.map((workspace, index) => (
            <button
              key={workspace.id}
              className={index === highlight ? "project-menu-option active" : "project-menu-option"}
              type="button"
              role="option"
              aria-selected={workspace.id === active}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => { onSelect(workspace.id); closeMenu(); }}
            >
              <span className="project-menu-option-icon" aria-hidden="true">{workspace.kind === "multi" ? "▦" : "⌂"}</span>
              <span className="project-menu-option-copy">
                <strong>{workspace.name}</strong>
                <small>{workspace.kind === "multi" ? `${workspace.repos.length} repositories` : "Project"}</small>
              </span>
              <span className="project-menu-check" aria-hidden="true">{workspace.id === active ? "✓" : ""}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
