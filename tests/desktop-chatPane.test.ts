import { describe, expect, it } from "vitest";
import { describeSlashInput } from "../desktop/renderer/chatPane.js";

describe("slash input classification", () => {
  it("treats plain text as non-slash", () => {
    expect(describeSlashInput("hi")).toEqual({ kind: "plain" });
    expect(describeSlashInput("")).toEqual({ kind: "plain" });
    expect(describeSlashInput("github")).toEqual({ kind: "plain" });
  });
  it("completes command names while typing", () => {
    expect(describeSlashInput("/")).toEqual({ kind: "command", token: "/" });
    expect(describeSlashInput("/con")).toEqual({ kind: "command", token: "/con" });
  });
  it("jumps to argument options once the command name is exact", () => {
    expect(describeSlashInput("/config")).toEqual({ kind: "args", prefix: "/config " });
    expect(describeSlashInput("/theme")).toEqual({ kind: "args", prefix: "/theme " });
  });
  it("keeps completing arguments after the first space", () => {
    expect(describeSlashInput("/config th")).toEqual({ kind: "args", prefix: "/config th" });
    expect(describeSlashInput("/theme github")).toEqual({ kind: "args", prefix: "/theme github" });
  });
});
