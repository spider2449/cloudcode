import { requireString } from "./ipcContract.js";
import type { Suggestion } from "../commands/completion.js";

export const MAX_CHAT_ID_LENGTH = 200;
export const MAX_CHAT_TEXT_LENGTH = 200_000;
export const MAX_CHAT_CWD_LENGTH = 4096;

// Thinking deltas are intentionally not forwarded (renderer shows final text; see `toChatEvents` in the engine-wiring task).
// user_text is user turn replay for history; live user messages are echoed locally by the renderer.
export const CHAT_EVENT_TYPES = ["text_delta", "tool_use", "tool_result", "notice", "error", "permission_request", "user_text", "complete", "new_session", "session_id", "done"] as const;
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

export interface ChatSendRequest {
  // Per-request correlation id (not the session id).
  id: string;
  sessionId?: string;
  text: string;
}

export interface ChatEvent {
  id: string;
  type: ChatEventType;
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  // Suggestion list for "complete" events (input-box autocomplete).
  items?: Suggestion[];
  // Backend session id carried by "session_id" events so the GUI can adopt
  // an anonymous conversation once it has content.
  sessionId?: string;
}

export function requireChatId(value: unknown): string {
  const id = requireString(value, "chat id");
  if (id.length > MAX_CHAT_ID_LENGTH || /[\0\r\n]/.test(id)) throw new Error("Invalid chat id.");
  return id;
}
export function requireChatText(value: unknown): string {
  const text = requireString(value, "chat text");
  if (text.length > MAX_CHAT_TEXT_LENGTH) throw new Error("Invalid chat text.");
  return text;
}

// Optional workspace directory for a request. Undefined means the caller has
// no workspace (the backend falls back to its own working directory).
export function requireChatCwd(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const cwd = requireString(value, "chat workspace");
  if (cwd.length > MAX_CHAT_CWD_LENGTH || cwd.includes("\0")) throw new Error("Invalid chat workspace.");
  return cwd;
}

// Optional persisted session id to resume. Undefined starts (or reuses) the
// backend's anonymous session for the workspace.
export function requireChatSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requireChatId(value);
}
