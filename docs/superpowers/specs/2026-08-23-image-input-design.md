# Image Input Design

Date: 2026-08-23

## Goal

Let the model see images from two sources: the `Read` tool reading image files
from disk, and the user attaching a clipboard screenshot in the TUI via
`Ctrl+V`. Images flow through the message pipeline as first-class content
blocks, with graceful behavior on providers that lack vision support.

## Non-goals

- Drag-and-drop (raw terminals cannot detect it).
- A generic file-attachment system for arbitrary types.
- Image generation/output.
- Dimension validation (pixel width/height parsing is YAGNI; byte size is enforced).

## Image rules (enforced at both sources)

- Media types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`.
- Detection: file extension first, then **magic bytes** must confirm
  (`\x89PNG`, `\xFF\xD8\xFF`, `GIF87a`/`GIF89a`, `RIFF…WEBP`).
- Maximum size: **5 MB** of encoded bytes per image (Anthropic's limit).

## Components and placement

### Read tool reads images

`src/engine/tools/read.ts`: when the resolved path looks like an image
(extension check), read raw bytes, verify magic bytes and size; on success
return `{ content: "[image: <name>]", images: [{ mediaType, base64 }] }`.

`ToolOutput` (`src/engine/tools/types.ts`) gains an additive field:

```ts
images?: Array<{ mediaType: string; base64: string }>;
```

Existing tools are untouched. On magic-byte mismatch or oversize the tool
returns its normal text content with an explanatory error result.

### Message pipeline

- `src/engine/messages.ts`: `ContentBlock` gains
  `{ type: "image"; source: { type: "base64"; media_type: string; data: string } }`
  (Anthropic-native shape).
- `src/engine/loop.ts` (`runTool`): when a tool output carries images, the
  tool_result `content` becomes a block array — text part plus
  `{ type: "image", source: {...} }` blocks — instead of a plain string.
- `runTurn(userText, signal, images?)`: when images are attached, the user
  message is sent as content blocks (`image` blocks followed by the text)
  instead of a bare string.
- `src/engine/api.ts`: no change (blocks pass through verbatim to Anthropic).
- `src/engine/openaiApi.ts`: maps `image` blocks to OpenAI vision content
  parts (`{ type: "image_url", image_url: { url: "data:<mediaType>;base64,<data>" } }`)
  wherever Anthropic-shaped content appears. Providers without vision support
  surface their API error through the existing per-turn boundary.

### TUI clipboard attach

- `Ctrl+V` while idle triggers a platform command that writes the clipboard
  image (if any) to a temp PNG:
  - win32: PowerShell `Get-Clipboard -Format Image` + System.Drawing save
  - darwin: `osascript` writing `clipboard as «class PNGf»`
  - linux: `xclip -selection clipboard -t image/png -o`
- No image / command failure → transcript notice only; never an error state.
- With an image: it becomes a pending attachment and the input box shows
  `[image N]`. Further presses append more attachments. Submitting sends all
  pending attachments with the prompt text, then clears them. Pressing `Esc`
  to clear the input also clears pending attachments.
- Placement: key handling in `src/ui/keyRouter.ts`, clipboard capture in a new
  `src/ui/clipboard.ts` (agent-of-the-terminal layer, no engine imports),
  pending-attachment state owned by the existing input controller in
  `nativeApp.ts`.

### Persistence

Attached and read images are part of the conversation history and persist in
the session JSONL like all other content blocks. The 5 MB per-image cap bounds
growth; no extra format changes are needed since blocks are stored verbatim.

## Error handling

All within existing boundaries: Read validation errors are normal `is_error`
tool results; clipboard capture failures are notices; provider vision errors
surface through the per-turn boundary. No new try/catch beyond the clipboard
command execution, which must not crash the TUI.

## Testing

- **Magic bytes/type detection**: valid PNG/JPEG/GIF/WebP headers; mismatched
  extension vs content; oversized rejection.
- **runTool assembly**: tool output with images produces a block-array
  tool_result; without images, unchanged string content.
- **runTurn with images**: user message becomes blocks with the image first;
  without images, plain string (regression).
- **openaiApi mapping**: Anthropic-style image block converts to the OpenAI
  data-URL part.
- **keyRouter**: Ctrl+V in idle state invokes the capture hook; streaming
  state ignores it. Clipboard command failures produce a notice, not a crash.
