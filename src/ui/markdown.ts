import { Marked } from "marked";
import type { Tokens } from "marked";
import { wrapText } from "./layout.js";
import { stringWidth } from "./width.js";
import type { Theme } from "./theme.js";
import { renderHeading, renderHr, renderBlockquote, renderCodeBlock } from "./markdown/block.js";
import { renderInline, renderLink } from "./markdown/inline.js";
import { columnWidths, renderTable } from "./markdown/table.js";

// Bullets by nesting depth; ordered lists keep their source numbers.
const BULLETS = ["• ", "◦ ", "▪ "];

function plainLen(s: string): number {
  return stringWidth(s.replace(/\x1b\[[0-9;]*m/g, ""));
}

// marked's escape pass turns source quotes/angle brackets into entities;
// terminals need the literal characters back.
const ENTITY_RE = /&(quot|amp|lt|gt|apos|#x?[0-9a-f]+);/gi;
const ENTITIES: Record<string, string> = {
  quot: '"', amp: "&", lt: "<", gt: ">", apos: "'"
};

function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (raw, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? raw;
    const hex = name[1] === "x" || name[1] === "X";
    const cp = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isNaN(cp) ? raw : String.fromCodePoint(cp);
  });
}

export function renderMarkdown(text: string, width = 80, theme?: Theme): string {
  try {
    const w = Math.max(20, width);
    // Columns already consumed by enclosing list markers; every block wraps
    // to w minus this so nested rows never overflow once their indent is
    // prefixed. A fresh Marked instance per call keeps this state local
    // (the global marked.use() cache this replaces leaked across calls).
    let indent = 0;
    const availW = () => Math.max(8, w - indent);
    const md = new Marked({ gfm: true });
    let listDepth = 0;
    // marked's default renderers each terminate with "\n\n"; it adds no
    // separators between blocks itself, so every block override here ends
    // the same way. Inline output is entity-decoded because marked's text
    // pass escapes source characters like quotes.
    md.use({
      renderer: {
        heading({ tokens, depth }: Tokens.Heading): string {
          return (
            renderHeading(decodeEntities(this.parser.parseInline(tokens)), depth, availW(), theme) + "\n\n"
          );
        },
        paragraph({ tokens }: Tokens.Paragraph): string {
          return wrapText(decodeEntities(this.parser.parseInline(tokens)), availW()).join("\n") + "\n\n";
        },
        hr(): string {
          return renderHr(availW(), theme) + "\n\n";
        },
        blockquote({ tokens }: Tokens.Blockquote): string {
          const inner = this.parser.parse(tokens).replace(/\n+$/, "");
          const lines = inner.split("\n").filter((l) => l.trim() !== "");
          return (lines.length > 0 ? renderBlockquote(lines, availW(), theme) : "") + "\n\n";
        },
        code({ text, lang }: Tokens.Code): string {
          return renderCodeBlock(text.replace(/\n$/, ""), lang, availW(), theme) + "\n\n";
        },
        list(token: Tokens.List): string {
          const bullet = BULLETS[Math.min(listDepth, BULLETS.length - 1)];
          listDepth++;
          try {
            const out = token.items.map((item, i) => {
              // GFM allows a non-numeric start ("start" is string | number).
              const marker = token.ordered ? `${(Number(token.start) || 1) + i}. ` : bullet;
              const task = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
              const markerLen = stringWidth(marker) + (task ? stringWidth(task) : 0);
              const pad = " ".repeat(markerLen);
              indent += markerLen;
              let body: string;
              try {
                body = this.parser.parse(item.tokens).replace(/\n+$/, "");
              } finally {
                indent -= markerLen;
              }
              // Blank rows between loose-item paragraphs collapse so nested
              // blocks sit tight under their parent item.
              const lines = body.split("\n").filter((l) => l.trim() !== "");
              if (lines.length === 0) return (marker + task).trimEnd();
              return lines
                .map((l, j) => (j === 0 ? marker + task + l : pad + l))
                .join("\n");
            }).join("\n");
            return out + "\n\n";
          } finally {
            listDepth--;
          }
        },
        table(token: Tokens.Table): string {
          const cell = (c: Tokens.TableCell) => decodeEntities(this.parser.parseInline(c.tokens));
          const header = token.header.map(cell);
          const rows = token.rows.map((r) => r.map(cell));
          const widths = columnWidths(
            header.map(plainLen),
            rows.map((r) => r.map(plainLen)),
            availW()
          );
          return renderTable(header, rows, widths, theme) + "\n\n";
        },
        html({ text }: Tokens.HTML | Tokens.Tag): string {
          return decodeEntities(text.replace(/<[^>]*>/g, "")) + "\n\n";
        },
        space(): string {
          return "";
        },
        codespan({ text }: Tokens.Codespan): string {
          return renderInline("codespan", decodeEntities(text), theme);
        },
        strong({ tokens }: Tokens.Strong): string {
          return renderInline("strong", decodeEntities(this.parser.parseInline(tokens)), theme);
        },
        em({ tokens }: Tokens.Em): string {
          return renderInline("em", decodeEntities(this.parser.parseInline(tokens)), theme);
        },
        del({ tokens }: Tokens.Del): string {
          return renderInline("del", decodeEntities(this.parser.parseInline(tokens)), theme);
        },
        link({ href, tokens }: Tokens.Link): string {
          return renderLink(decodeEntities(this.parser.parseInline(tokens)), href ?? "", theme);
        },
        image({ href, text }: Tokens.Image): string {
          return renderLink(`[${decodeEntities(text)}]`, href ?? "", theme);
        }
      }
    });
    const out = md.parse(text, { async: false }) as string;
    return out.replace(/\n+$/, "");
  } catch {
    return text;
  }
}
