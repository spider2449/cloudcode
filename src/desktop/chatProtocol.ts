import { requireString } from "./ipcContract.js";

export const MAX_CHAT_ID_LENGTH = 200;
export const MAX_CHAT_TEXT_LENGTH = 200_000;

// Thinking deltas are intentionally not forwarded (renderer shows final text; see `toChatEvents` in the engine-wiring task).
// user_text is user turn replay for history; live user messages are echoed locally by the renderer.
export const CHAT_EVENT_TYPES = ["text_delta", "tool_use", "tool_result", "notice", "error", "permission_request", "user_text", "done"] as const;
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
