import { describe, it, expect } from "vitest";
import {
  STATUS_LINE_ITEMS,
  DEFAULT_STATUS_LINE_ITEMS,
  STATUS_LINE_LABELS,
  normalizeStatusLineItems,
  canonicalOrder,
} from "../src/statusLineItems.js";

describe("status line item registry", () => {
  it("exposes labels for every registered item", () => {
    for (const item of STATUS_LINE_ITEMS) expect(STATUS_LINE_LABELS[item]).toBeTruthy();
  });

  it("defaults to model/mode/branch/tokens", () => {
    expect(DEFAULT_STATUS_LINE_ITEMS).toEqual(["model", "mode", "branch", "tokens"]);
  });
});

describe("normalizeStatusLineItems", () => {
  it("returns undefined for non-arrays", () => {
    expect(normalizeStatusLineItems("model")).toBeUndefined();
    expect(normalizeStatusLineItems({})).toBeUndefined();
    expect(normalizeStatusLineItems(undefined)).toBeUndefined();
  });

  it("keeps known IDs in user order and drops unknown ones", () => {
    expect(normalizeStatusLineItems(["cost", "bogus", "mode"])).toEqual(["cost", "mode"]);
  });

  it("removes duplicates while keeping first occurrence order", () => {
    expect(normalizeStatusLineItems(["cwd", "cost", "cwd"])).toEqual(["cwd", "cost"]);
  });

  it("treats an empty array as a valid explicit-empty choice", () => {
    expect(normalizeStatusLineItems([])).toEqual([]);
  });
});

describe("canonicalOrder", () => {
  it("lists enabled items in registry order regardless of insertion order", () => {
    expect(canonicalOrder(new Set(["cost", "model"]))).toEqual(["model", "cost"]);
  });
});
