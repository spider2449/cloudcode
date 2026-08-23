import { describe, it, expect } from "vitest";
import { createTodoTool, parseTodos, type TodoItem } from "../src/engine/tools/todo.js";

function memoryStore(initial: TodoItem[] = []) {
  let todos = initial;
  return {
    get: () => todos,
    set: (t: TodoItem[]) => { todos = t; }
  };
}

describe("parseTodos", () => {
  it("accepts a valid list", () => {
    const r = parseTodos([{ content: "a", status: "pending" }]);
    expect(r.error).toBeUndefined();
    expect(r.todos).toEqual([{ content: "a", status: "pending" }]);
  });
  it("rejects non-array input", () => {
    expect(parseTodos({}).error).toBeDefined();
    expect(parseTodos(undefined)).toEqual({ error: "todos must be an array" });
  });
  it("rejects empty or missing content and bad statuses", () => {
    expect(parseTodos([{ status: "pending" }]).error).toBeDefined();
    expect(parseTodos([{ content: "", status: "pending" }]).error).toBeDefined();
    expect(parseTodos([{ content: "a", status: "done" }]).error).toBeDefined();
  });
  it("rejects more than one in_progress", () => {
    const r = parseTodos([
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" }
    ]);
    expect(r.error).toContain("in_progress");
  });
  it("rejects duplicates and oversized lists", () => {
    expect(parseTodos([{ content: "a", status: "pending" }, { content: "a", status: "pending" }]).error).toBeDefined();
    expect(parseTodos(Array.from({ length: 51 }, (_, i) => ({ content: String(i), status: "pending" as const }))).error).toBeDefined();
  });
});

describe("TodoWrite tool", () => {
  it("stores a valid list and confirms with counts", async () => {
    const store = memoryStore();
    const tool = createTodoTool(store);
    const out = await tool.execute(
      { todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "completed" }] },
      { cwd: "/tmp" }
    );
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("2 todos");
    expect(out.content).toContain("1 in progress");
    expect(out.content).toContain("1 done");
    expect(store.get()).toHaveLength(2);
  });

  it("returns an error result for invalid lists without touching the store", async () => {
    const store = memoryStore();
    const tool = createTodoTool(store);
    const out = await tool.execute({ todos: [{ content: "", status: "pending" }] }, { cwd: "/tmp" });
    expect(out.isError).toBe(true);
    expect(store.get()).toEqual([]);
  });

  it("validates even without a store", async () => {
    const tool = createTodoTool();
    const ok = await tool.execute({ todos: [] }, { cwd: "/tmp" });
    expect(ok.isError).toBeUndefined();
    const bad = await tool.execute({ todos: "nope" }, { cwd: "/tmp" });
    expect(bad.isError).toBe(true);
  });
});
