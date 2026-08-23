import { describe, expect, it, vi } from "vitest";
import {
  NetworkPolicy, NetworkPolicyError, bashNetworkStatus, decideNetwork,
  effectiveNetworkMode, isLoopbackHost, isLoopbackUrl, providerEndpoint
} from "../src/agent/networkPolicy.js";

describe("network policy", () => {
  it("recognizes loopback hosts without accepting lookalikes", () => {
    for (const host of ["localhost", "api.localhost", "127.0.0.1", "127.99.3.4", "::1", "::ffff:127.0.0.1"])
      expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ["localhost.example.com", "128.0.0.1", "example.com", "127.0.0.999"])
      expect(isLoopbackHost(host), host).toBe(false);
    expect(isLoopbackUrl("http://[::1]:8080/v1")).toBe(true);
  });

  it("allows only loopback providers in strict mode", () => {
    expect(decideNetwork("offlineStrict", { capability: "provider", destination: "http://127.0.0.1:8080" }).allowed).toBe(true);
    expect(decideNetwork("offlineStrict", { capability: "provider", destination: "https://api.anthropic.com" }))
      .toMatchObject({ allowed: false, reason: "nonLoopbackProvider", destinationHost: "api.anthropic.com" });
  });

  it("providerOnly permits its selected provider and denies other egress", () => {
    expect(decideNetwork("providerOnly", { capability: "provider", destination: "https://api.example/v1" }, "https://api.example" ).allowed).toBe(true);
    expect(decideNetwork("providerOnly", { capability: "provider", destination: "https://other.example" }, "https://api.example"))
      .toMatchObject({ allowed: false, reason: "notSelectedProvider" });
    expect(decideNetwork("providerOnly", { capability: "update", destination: "https://registry.npmjs.org" }))
      .toMatchObject({ allowed: false, reason: "capabilityDenied" });
  });

  it("records decisions and throws a typed denial", () => {
    const record = vi.fn();
    const policy = new NetworkPolicy("providerOnly", "https://provider.test", { record });
    expect(() => policy.require({ capability: "skillRepo", destination: "https://github.com/a/b" }))
      .toThrow(NetworkPolicyError);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, destinationHost: "github.com" }));
  });

  it("resolves defaults, narrowing, and invocation-only unrestricted mode", () => {
    expect(effectiveNetworkMode(undefined, undefined)).toBe("providerOnly");
    expect(effectiveNetworkMode("providerOnly", "offlineStrict")).toBe("offlineStrict");
    expect(effectiveNetworkMode("providerOnly", "unrestricted")).toBe("unrestricted");
    expect(() => effectiveNetworkMode("offlineStrict", "providerOnly")).toThrow(/cannot widen/);
  });

  it("classifies Bash containment and provider defaults", () => {
    expect(bashNetworkStatus("offlineStrict", false)).toEqual({ available: false, description: "disabled" });
    expect(bashNetworkStatus("offlineStrict", true)).toEqual({ available: true, description: "contained" });
    expect(bashNetworkStatus("providerOnly", false)).toEqual({ available: true, description: "uncontained" });
    expect(providerEndpoint({})).toBe("https://api.anthropic.com");
  });
});

describe("webFetch capability", () => {
  const request = { capability: "webFetch", destination: "https://example.com/docs" };

  it("is denied under offlineStrict", () => {
    expect(decideNetwork("offlineStrict", request).allowed).toBe(false);
  });
  it("is denied under providerOnly", () => {
    expect(decideNetwork("providerOnly", request).allowed).toBe(false);
  });
  it("is allowed under unrestricted", () => {
    expect(decideNetwork("unrestricted", request).allowed).toBe(true);
  });
});
