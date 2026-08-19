import { describe, expect, it, vi } from "vitest";
import { TaskUiController } from "../src/ui/taskController.js";

describe("TaskUiController", () => {
  it("delivers the initial prompt once and closes planning on the first result", () => {
    const onSessionId = vi.fn();
    const onPlanningComplete = vi.fn();
    const controller = new TaskUiController({
      initialPrompt: "plan", planning: true, onSessionId, onPlanningComplete
    });
    controller.sessionStarted("session-1");
    expect(controller.takeInitialPrompt()).toBe("plan");
    expect(controller.takeInitialPrompt()).toBeUndefined();
    controller.handleMessage({ type: "result", subtype: "success", duration_ms: 1 }, vi.fn());
    controller.handleMessage({ type: "result", subtype: "success", duration_ms: 1 }, vi.fn());
    expect(onSessionId).toHaveBeenCalledWith("session-1");
    expect(onPlanningComplete).toHaveBeenCalledOnce();
    expect(onPlanningComplete).toHaveBeenCalledWith("session-1");
  });

  it("surfaces planning transition failures without throwing", () => {
    const onError = vi.fn();
    const controller = new TaskUiController({
      planning: true, onPlanningComplete: () => { throw new Error("plan missing"); }
    });
    expect(() => controller.handleMessage(
      { type: "result", subtype: "error_during_execution", result: "provider failed" }, onError
    )).not.toThrow();
    expect(onError).toHaveBeenCalledWith("plan missing");
  });

  it("reports a read-only worker result once without entering planning", () => {
    const onTurnComplete = vi.fn();
    const controller = new TaskUiController({ planning: false, onTurnComplete });
    controller.sessionStarted("worker-session");
    controller.handleMessage({ type: "result", subtype: "success", duration_ms: 1 }, vi.fn());
    controller.handleMessage({ type: "result", subtype: "success", duration_ms: 1 }, vi.fn());
    expect(onTurnComplete).toHaveBeenCalledOnce();
    expect(onTurnComplete).toHaveBeenCalledWith("worker-session");
  });
});
