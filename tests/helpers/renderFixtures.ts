import type { BottomState } from "../../src/ui/term/render.js";
import { THEMES } from "../../src/ui/theme.js";

// Shared InlineRenderer test fixtures (render.test.ts,
// render-simple.test.ts).
export const theme = THEMES.dark;
export const size = { rows: 24, columns: 80 };

function emptyInputRender() {
  return {
    borderRows: ["╭─╮", "╰─╯"], contentRows: ["> █"], menuRows: [], hintRow: null,
    totalRows: 3, cursorRow: 0, cursorColumn: 2
  };
}

export function baseBottom(overrides: Partial<BottomState> = {}): BottomState {
  return {
    overlay: "none",
    streaming: false,
    streamingText: "",
    thinkingText: "",
    activeTool: undefined,
    compactPct: undefined,
    queuedRows: [],
    inputRender: emptyInputRender(),
    overlayRows: [],
    statusBarProps: { provider: "anthropic", mode: "default", cwd: "/repo" },
    workIndFrame: 0,
    workStartedAt: 0,
    ...overrides
  };
}

// With emptyInputRender's 2 border + 1 content rows plus the status bar,
// the footer is 4 lines tall, so the scroll region for a 24-row viewport
// is rows 1..20 and the footer occupies rows 21..24.
const FOOTER_HEIGHT = 4;
export const SCROLL_BOTTOM = size.rows - FOOTER_HEIGHT; // 20
