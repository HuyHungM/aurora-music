import { describe, expect, it } from "vitest";
import { buildQueryString } from "@/lib/api";

describe("buildQueryString", () => {
  it("builds a query string from defined values", () => {
    expect(buildQueryString({ a: 1, d: "x" })).toBe("?a=1&d=x");
  });

  it("skips undefined, null, and empty strings", () => {
    expect(buildQueryString({ a: 1, b: undefined, c: null, d: "" })).toBe("?a=1");
  });

  it("returns an empty string when there is nothing to encode", () => {
    expect(buildQueryString({})).toBe("");
    expect(buildQueryString({ a: undefined })).toBe("");
  });

  it("URL-encodes values", () => {
    expect(buildQueryString({ q: "two words" })).toBe("?q=two+words");
  });

  it("keeps booleans as strings", () => {
    expect(buildQueryString({ explicit: true })).toBe("?explicit=true");
  });
});