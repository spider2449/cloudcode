import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
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
  onRemove: (workspaceId: string) => void;
  canRemove: (workspaceId: string) => boolean;
}

interface PopupPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export function projectMenuPosition(
  anchor: { left: number; top: number; bottom: number; width: number },
  viewport: { width: number; height: number },
  count: number
): PopupPosition {
  const margin = 8;
  const gap = 6;
  const width = Math.max(0, Math.min(Math.max(anchor.width, 270), viewport.width - margin * 2));
  const desiredHeight = Math.min(360, count * 54 + 14);
  const belowSpace = Math.max(0, viewport.height - margin - anchor.bottom - gap);
  const aboveSpace = Math.max(0, anchor.top - gap - margin);
  const above = belowSpace < desiredHeight && aboveSpace > belowSpace;
  const maxHeight = Math.min(desiredHeight, above ? aboveSpace : belowSpace);
  return {
    left: Math.max(margin, Math.min(anchor.left, viewport.width - width - margin)),
    top: above ? anchor.top - gap - maxHeight : anchor.bottom + gap,
    width,
    maxHeight
  };
}

export function ProjectMenu({ workspaces, active, onSelect, onRemove, canRemove }: ProjectMenuProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [position, setPosition] = useState<PopupPosition>();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const revealHighlightRef = useRef(true);
  const removalRef = useRef<{ index: number; scrollTop: number } | undefined>(undefined);
  const countRef = useRef(workspaces.length);
  countRef.current = workspaces.length;

  function positionMenu(): void {
    const anchor = rootRef.current?.getBoundingClientRect();
    if (!anchor) return;
    setPosition(projectMenuPosition(anchor, { width: window.innerWidth, height: window.innerHeight }, countRef.current));
  }

  function openMenu(): void {
    revealHighlightRef.current = true;
    const current = workspaces.findIndex(workspace => workspace.id === active);
    setHighlight(current === -1 ? 0 : current);
    positionMenu();
    setOpen(true);
  }

  function closeMenu(): void {
    removalRef.current = undefined;
    setOpen(false);
  }

  function removeProject(workspaceId: string, index: number): void {
    revealHighlightRef.current = false;
    removalRef.current = { index, scrollTop: menuRef.current?.scrollTop ?? 0 };
    onRemove(workspaceId);
  }

  function selectHighlighted(): void {
    const workspace = workspaces[highlight];
    if (!workspace) return;
    onSelect(workspace.id);
    closeMenu();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape" && event.target instanceof HTMLElement && event.target.closest(".project-menu-remove")) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) revealHighlightRef.current = true;
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
    menuRef.current?.focus({ preventScroll: true });
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

  useLayoutEffect(() => {
    if (!open) return;
    if (workspaces.length === 0) { closeMenu(); return; }
    setHighlight(index => moveProjectHighlight(index, 0, workspaces.length));
    positionMenu();
    const removed = removalRef.current;
    removalRef.current = undefined;
    const menu = menuRef.current;
    if (removed && menu) {
      menu.scrollTop = removed.scrollTop;
      const row = menu.children[Math.min(removed.index, workspaces.length - 1)];
      row?.querySelector<HTMLButtonElement>(".project-menu-remove")?.focus({ preventScroll: true });
    }
  }, [open, workspaces.length]);

  useEffect(() => {
    if (open && revealHighlightRef.current) menuRef.current?.children[highlight]?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

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
          style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
          onKeyDown={onKeyDown}
        >
          {workspaces.map((workspace, index) => (
            <div className="project-menu-row" key={workspace.id}>
            <button
              className={index === highlight ? "project-menu-option active" : "project-menu-option"}
              type="button"
              role="option"
              aria-selected={workspace.id === active}
              onMouseEnter={() => { revealHighlightRef.current = false; setHighlight(index); }}
              onClick={() => { onSelect(workspace.id); closeMenu(); }}
            >
              <span className="project-menu-option-icon" aria-hidden="true">{workspace.kind === "multi" ? "▦" : "⌂"}</span>
              <span className="project-menu-option-copy">
                <strong>{workspace.name}</strong>
                <small>{workspace.repos.every(repo => repo.missing) ? "Directory unavailable" : workspace.kind === "multi" ? `${workspace.repos.length} repositories` : "Project"}</small>
              </span>
              <span className="project-menu-check" aria-hidden="true">{workspace.id === active ? "✓" : ""}</span>
            </button>
            <button className="project-menu-remove" type="button"
              title="Remove from project list" aria-label={`Remove ${workspace.name} from project list`}
              disabled={!canRemove(workspace.id)}
              onClick={() => removeProject(workspace.id, index)}>×</button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
