import type { ToolDef } from "./types.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem { content: string; status: TodoStatus }

/** Session-owned storage for the current checklist. */
export interface TodoStore {
  get(): TodoItem[];
  set(todos: TodoItem[]): void;
}

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];
const MAX_TODOS = 50;

export function parseTodos(value: unknown): { todos?: TodoItem[]; error?: string } {
  if (!Array.isArray(value)) return { error: "todos must be an array" };
  if (value.length > MAX_TODOS) return { error: `too many todos (max ${MAX_TODOS})` };
  const todos: TodoItem[] = [];
  for (const raw of value) {
    const entry = raw as { content?: unknown; status?: unknown };
    if (typeof entry.content !== "string" || entry.content.trim() === "") {
      return { error: "every todo needs a non-empty content string" };
    }
    if (!STATUSES.includes(entry.status as TodoStatus)) {
      return { error: `status must be one of: ${STATUSES.join(", ")}` };
    }
    todos.push({ content: entry.content.trim(), status: entry.status as TodoStatus });
  }
  const inProgress = todos.filter(t => t.status === "in_progress").length;
  if (inProgress > 1) {
    return { error: `at most one todo may be in_progress (found ${inProgress})` };
  }
  const seen = new Set<string>();
  for (const t of todos) {
    if (seen.has(t.content)) return { error: `duplicate todo content: "${t.content}"` };
    seen.add(t.content);
  }
  return { todos };
}

export function createTodoTool(store?: TodoStore): ToolDef {
  return {
    name: "TodoWrite",
    description:
      "Replace the task checklist for this session. Use it to track multi-step work: " +
      "mark one item in_progress while working on it, completed when finished.",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete checklist, replacing any previous list",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: [...STATUSES] }
            },
            required: ["content", "status"]
          }
        }
      },
      required: ["todos"]
    },
    async execute(input) {
      const parsed = parseTodos(input.todos);
      if (parsed.error || !parsed.todos) {
        return { content: `Invalid todos: ${parsed.error ?? "unknown error"}`, isError: true };
      }
      const todos = parsed.todos;
      store?.set(todos);
      const inProgress = todos.filter(t => t.status === "in_progress").length;
      const done = todos.filter(t => t.status === "completed").length;
      const summary = `${todos.length} todo${todos.length === 1 ? "" : "s"} (${inProgress} in progress, ${done} done)`;
      return { content: todos.length === 0 ? "Checklist cleared." : summary };
    }
  };
}
