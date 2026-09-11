import { SessionFile } from "../engine/sessions.js";
import { fromApiMessages } from "./chatEvents.js";
import { requireChatSessionId, type ChatEvent } from "./chatProtocol.js";

// History replay for the desktop GUI backend. A missing session id means a
// brand-new conversation with no stored transcript, so it resolves to an
// empty event list instead of an error. Truly malformed ids still throw and
// let the caller emit error + done.
export function loadHistoryEvents(replyId: string, sessionId: unknown): ChatEvent[] {
  const historySession = requireChatSessionId(sessionId);
  if (historySession === undefined) return [];
  const entries = SessionFile.load(historySession);
  return fromApiMessages(
    replyId,
    entries as Array<{ role?: string; content?: unknown; type?: string }>
  );
}
