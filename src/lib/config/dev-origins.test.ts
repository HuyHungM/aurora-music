import { describe, expect, it } from "vitest";

import {
  DEV_ORIGIN_OVERRIDE_ENV_VAR,
  detectInterfaceHostnames,
  getAllowedDevOrigins,
  normalizeDevOriginEntry,
  parseDevOriginOverride,
  resolveAllowedDevOrigins,
} from "@/lib/config/dev-origins";

describe("normalizeDevOriginEntry", () => {
  it("reduces a pasted origin URL to the hostname Next matches", () => {
    // Next compares `URL#hostname` of the `Origin` header: scheme, port, path
    // and query are all ignored, so the entry must arrive in that shape.
    expect(normalizeDevOriginEntry("http://192.168.1.32:3000/")).toBe(
      "192.168.1.32",
    );
    expect(normalizeDevOriginEntry("HTTPS://Aurora.Lan:3000/search?q=x")).toBe(
      "aurora.lan",
    );
    expect(normalizeDevOriginEntry("  192.168.1.32:3000  ")).toBe(
      "192.168.1.32",
    );
  });

  it("keeps IPv6 bracketed, matching URL#hostname", () => {
    expect(normalizeDevOriginEntry("[::1]:3000")).toBe("[::1]");
    expect(normalizeDevOriginEntry("::1")).toBe("[::1]");
    expect(normalizeDevOriginEntry("fd7a:115c:a1e0::4")).toBe(
      "[fd7a:115c:a1e0::4]",
    );
  });

  it("drops entries that are not a single unambiguous hostname", () => {
    for (const input of [
      "",
      "   ",
      "http://",
      "/path",
      "host:not-a-port",
      "two hosts",
      "host:70000:extra",
    ]) {
      expect(normalizeDevOriginEntry(input)).toBeNull();
    }
  });

  it("refuses a bare wildcard but keeps a scoped subdomain pattern", () => {
    // A bare `*` would opt every host that can reach the dev port into its
    // internal endpoints - the allowlist exists to prevent exactly that.
    expect(normalizeDevOriginEntry("*")).toBeNull();
    expect(normalizeDevOriginEntry("**")).toBeNull();
    expect(normalizeDevOriginEntry("*.*")).toBeNull();
    expect(normalizeDevOriginEntry("*.tunnel.example.com")).toBe(
      "*.tunnel.example.com",
    );
  });

  it("rejects hostnames that cannot be an Origin host", () => {
    expect(normalizeDevOriginEntry("not a host!")).toBeNull();
    expect(normalizeDevOriginEntry("-leading.hyphen")).toBeNull();
  });
});

describe("parseDevOriginOverride", () => {
  it("accepts comma and whitespace separated lists and deduplicates", () => {
    expect(
      parseDevOriginOverride(
        "192.168.1.32:3000, 100.70.150.45\n192.168.1.32,",
      ),
    ).toEqual(["192.168.1.32", "100.70.150.45"]);
  });

  it("ignores invalid tokens instead of widening the list", () => {
    expect(parseDevOriginOverride("*, 192.168.1.32")).toEqual([
      "192.168.1.32",
    ]);
    expect(parseDevOriginOverride(undefined)).toEqual([]);
    expect(parseDevOriginOverride("")).toEqual([]);
  });
});

describe("detectInterfaceHostnames", () => {
  const interfaces = {
    Ethernet: [
      { address: "192.168.1.32", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
    "tailscale0": [
      { address: "100.70.150.45", family: "IPv4", internal: false },
    ],
    lo: [
      { address: "127.0.0.1", family: "IPv4", internal: true },
      { address: "::1", family: "IPv6", internal: true },
    ],
    "docker0": [
      { address: "172.17.0.1", family: "IPv4", internal: false },
    ],
  };

  it("returns routable interface addresses, sorted and deduplicated", () => {
    expect(detectInterfaceHostnames(interfaces)).toEqual([
      "100.70.150.45",
      "172.17.0.1",
      "192.168.1.32",
    ]);
  });

  it("handles the numeric family encoding of older Node releases", () => {
    expect(
      detectInterfaceHostnames({
        eth0: [{ address: "10.0.0.7", family: 4, internal: false }],
      }),
    ).toEqual(["10.0.0.7"]);
  });

  it("skips IPv6 link-local addresses, which need a zone id", () => {
    expect(
      detectInterfaceHostnames({
        eth0: [{ address: "fe80::abcd", family: "IPv6", internal: false }],
      }),
    ).toEqual([]);
  });
});

describe("resolveAllowedDevOrigins", () => {
  it("always covers loopback, which Next does not allow by itself", () => {
    expect(resolveAllowedDevOrigins({ interfaces: {} })).toEqual([
      "localhost",
      "127.0.0.1",
      "[::1]",
    ]);
  });

  it("appends detected LAN hostnames without duplicates", () => {
    const result = resolveAllowedDevOrigins({
      interfaces: {
        eth0: [
          { address: "192.168.1.32", family: "IPv4", internal: false },
          { address: "127.0.0.1", family: "IPv4", internal: true },
        ],
      },
    });
    expect(result).toEqual(["localhost", "127.0.0.1", "[::1]", "192.168.1.32"]);
  });

  it("lets an explicit override replace interface detection", () => {
    const result = resolveAllowedDevOrigins({
      override: "100.70.150.45",
      interfaces: { eth0: [{ address: "192.168.1.32", family: "IPv4", internal: false }] },
    });
    expect(result).toEqual(["localhost", "127.0.0.1", "[::1]", "100.70.150.45"]);
  });

  it("honours an empty override as 'loopback only'", () => {
    expect(
      resolveAllowedDevOrigins({
        override: "",
        interfaces: { eth0: [{ address: "192.168.1.32", family: "IPv4", internal: false }] },
      }),
    ).toEqual(["localhost", "127.0.0.1", "[::1]"]);
  });
});

describe("getAllowedDevOrigins", () => {
  it("is empty outside development so production config is untouched", () => {
    expect(getAllowedDevOrigins({ NODE_ENV: "production" })).toEqual([]);
    expect(getAllowedDevOrigins({ NODE_ENV: "test" })).toEqual([]);
    expect(getAllowedDevOrigins({})).toEqual([]);
  });

  it("reads the override from the documented variable in development", () => {
    const result = getAllowedDevOrigins({
      NODE_ENV: "development",
      [DEV_ORIGIN_OVERRIDE_ENV_VAR]: "192.168.1.32",
    });
    expect(result).toEqual([
      "localhost",
      "127.0.0.1",
      "[::1]",
      "192.168.1.32",
    ]);
  });
});
