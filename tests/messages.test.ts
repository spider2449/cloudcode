
import { todosMessage } from "../src/engine/messages.js";

describe("todosMessage", () => {
  it("builds a todos broadcast message", () => {
    expect(todosMessage([{ content: "x", status: "completed" }])).toEqual({
      type: "todos",
      todos: [{ content: "x", status: "completed" }]
    });
  });
});
