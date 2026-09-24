import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import {
  extractMethodFromTemplate,
  normalizeHttpMethod,
  clearEndpointMethodCache,
  TREG_MAX_USD_PER_CALL,
} from "./treg";

/**
 * Tests for Treg HTTP method handling.
 *
 * The key issue being fixed: GET endpoints that need query params (like Diffbot)
 * were incorrectly called with POST + JSON body because the old code inferred
 * method from "has body". Now we read the method from the catalog's top-level
 * `method` field first, falling back to `call_template` parsing.
 */

describe("extractMethodFromTemplate", () => {
  test("extracts GET method from call_template", () => {
    const template = 'treg call diffbot.x.extract-article --method GET --url "https://..."';
    expect(extractMethodFromTemplate(template)).toBe("GET");
  });

  test("extracts POST method from call_template", () => {
    const template = 'treg call anyapi.web.scrape --method POST --body \'{"url":"..."}\'';
    expect(extractMethodFromTemplate(template)).toBe("POST");
  });

  test("extracts PUT method from call_template", () => {
    const template = "treg call some.api.update --method PUT --body '{}'";
    expect(extractMethodFromTemplate(template)).toBe("PUT");
  });

  test("extracts PATCH method from call_template", () => {
    const template = "treg call some.api.patch --method PATCH --body '{}'";
    expect(extractMethodFromTemplate(template)).toBe("PATCH");
  });

  test("extracts DELETE method from call_template", () => {
    const template = "treg call some.api.delete --method DELETE";
    expect(extractMethodFromTemplate(template)).toBe("DELETE");
  });

  test("handles lowercase method in template", () => {
    const template = "treg call endpoint --method get";
    expect(extractMethodFromTemplate(template)).toBe("GET");
  });

  test("returns undefined for template without method flag", () => {
    const template = "treg call endpoint --url 'https://...'";
    expect(extractMethodFromTemplate(template)).toBeUndefined();
  });

  test("returns undefined for undefined input", () => {
    expect(extractMethodFromTemplate(undefined)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(extractMethodFromTemplate("")).toBeUndefined();
  });

  test("returns undefined for invalid method", () => {
    const template = "treg call endpoint --method INVALID";
    expect(extractMethodFromTemplate(template)).toBeUndefined();
  });

  test("handles method at end of template", () => {
    const template = "treg call endpoint --url 'https://...' --method GET";
    expect(extractMethodFromTemplate(template)).toBe("GET");
  });

  test("handles extra whitespace around method", () => {
    const template = "treg call endpoint --method   GET";
    expect(extractMethodFromTemplate(template)).toBe("GET");
  });
});

describe("normalizeHttpMethod", () => {
  test("normalizes valid GET method", () => {
    expect(normalizeHttpMethod("GET")).toBe("GET");
    expect(normalizeHttpMethod("get")).toBe("GET");
    expect(normalizeHttpMethod("Get")).toBe("GET");
  });

  test("normalizes valid POST method", () => {
    expect(normalizeHttpMethod("POST")).toBe("POST");
    expect(normalizeHttpMethod("post")).toBe("POST");
  });

  test("normalizes valid PUT method", () => {
    expect(normalizeHttpMethod("PUT")).toBe("PUT");
    expect(normalizeHttpMethod("put")).toBe("PUT");
  });

  test("normalizes valid PATCH method", () => {
    expect(normalizeHttpMethod("PATCH")).toBe("PATCH");
    expect(normalizeHttpMethod("patch")).toBe("PATCH");
  });

  test("normalizes valid DELETE method", () => {
    expect(normalizeHttpMethod("DELETE")).toBe("DELETE");
    expect(normalizeHttpMethod("delete")).toBe("DELETE");
  });

  test("returns undefined for invalid methods", () => {
    expect(normalizeHttpMethod("INVALID")).toBeUndefined();
    expect(normalizeHttpMethod("HEAD")).toBeUndefined();
    expect(normalizeHttpMethod("OPTIONS")).toBeUndefined();
  });

  test("returns undefined for empty/null/undefined input", () => {
    expect(normalizeHttpMethod("")).toBeUndefined();
    expect(normalizeHttpMethod(null)).toBeUndefined();
    expect(normalizeHttpMethod(undefined)).toBeUndefined();
  });
});

describe("clearEndpointMethodCache", () => {
  beforeEach(() => {
    clearEndpointMethodCache();
  });

  test("clears cache without throwing", () => {
    expect(() => clearEndpointMethodCache()).not.toThrow();
  });
});

describe("Treg price cap", () => {
  test("TREG_MAX_USD_PER_CALL is a positive number", () => {
    expect(TREG_MAX_USD_PER_CALL).toBeGreaterThan(0);
  });

  test("TREG_MAX_USD_PER_CALL defaults to 0.01", () => {
    expect(TREG_MAX_USD_PER_CALL).toBe(0.01);
  });
});

/**
 * Integration tests for HTTP method selection require mocking fetch.
 * These tests verify that:
 * 1. GET endpoints pass params as query string
 * 2. POST endpoints pass params as JSON body
 * 3. Method override works correctly
 *
 * Since these require network mocking, they're in a separate describe block
 * that can be skipped in environments without fetch mocking support.
 */
describe("HTTP method selection behavior", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[];

  beforeEach(() => {
    clearEndpointMethodCache();
    fetchCalls = [];
    originalFetch = globalThis.fetch;

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, options: init ?? {} });

      if (url.includes("/catalog/endpoints/")) {
        // Diffbot-style catalog: method field at top level, call_template uses --query (no --method)
        if (url.includes("diffbot.x.extract-article")) {
          return new Response(
            JSON.stringify({
              id: "diffbot.x.extract-article",
              provider: "diffbot",
              name: "Extract Article",
              method: "GET",
              call_template: "treg call diffbot.x.extract-article --query url=https://...",
              cost: { usd: 0.001196 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: "test-endpoint",
            provider: "test",
            name: "Test",
            call_template: url.includes("get-endpoint")
              ? "treg call get-endpoint --method GET"
              : "treg call post-endpoint --method POST",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/call/")) {
        return new Response(JSON.stringify({ data: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    }) as typeof globalThis.fetch;
  });

  test.skipIf(!process.env.TREG_TOKEN)("GET endpoint: params sent as query string, not body", async () => {
    const { call } = await import("./treg");

    await call("get-endpoint", { url: "https://example.com", timeout: 30 });

    const callRequest = fetchCalls.find((c) => c.url.includes("/call/get-endpoint"));
    expect(callRequest).toBeDefined();
    expect(callRequest!.options.method).toBe("GET");
    expect(callRequest!.url).toContain("url=https");
    expect(callRequest!.url).toContain("timeout=30");
    expect(callRequest!.options.body).toBeUndefined();
  });

  test.skipIf(!process.env.TREG_TOKEN)("Diffbot-shaped catalog: uses top-level method field, not call_template", async () => {
    // This test verifies the fix for PR #8's incomplete implementation.
    // Diffbot's catalog returns:
    //   - method: "GET" (top-level field)
    //   - call_template: "treg call ... --query url=..." (no --method flag)
    // The old code only parsed call_template and fell back to POST.
    // The fix prefers the top-level `method` field.
    const { call } = await import("./treg");

    await call("diffbot.x.extract-article", { url: "https://example.com/article" });

    const callRequest = fetchCalls.find((c) => c.url.includes("/call/diffbot.x.extract-article"));
    expect(callRequest).toBeDefined();
    // Should use GET from the top-level method field, not POST (the default when call_template has no --method)
    expect(callRequest!.options.method).toBe("GET");
    // Params should be in query string, not body
    expect(callRequest!.url).toContain("url=https");
    expect(callRequest!.options.body).toBeUndefined();
  });

  test.skipIf(!process.env.TREG_TOKEN)("POST endpoint: params sent as JSON body", async () => {
    const { call } = await import("./treg");

    await call("post-endpoint", { url: "https://example.com", data: { key: "value" } });

    const callRequest = fetchCalls.find((c) => c.url.includes("/call/post-endpoint"));
    expect(callRequest).toBeDefined();
    expect(callRequest!.options.method).toBe("POST");
    expect(callRequest!.options.body).toBeDefined();
    expect(JSON.parse(callRequest!.options.body as string)).toEqual({
      url: "https://example.com",
      data: { key: "value" },
    });
  });

  test.skipIf(!process.env.TREG_TOKEN)("method override bypasses catalog lookup", async () => {
    const { call } = await import("./treg");

    await call("some-endpoint", { param: "value" }, { method: "DELETE" });

    const callRequest = fetchCalls.find((c) => c.url.includes("/call/some-endpoint"));
    expect(callRequest).toBeDefined();
    expect(callRequest!.options.method).toBe("DELETE");
    const catalogRequest = fetchCalls.find((c) => c.url.includes("/catalog/endpoints/some-endpoint"));
    expect(catalogRequest).toBeUndefined();
  });

  test.skipIf(!process.env.TREG_TOKEN)("empty params work for GET endpoints", async () => {
    const { call } = await import("./treg");

    await call("get-endpoint", {});

    const callRequest = fetchCalls.find((c) => c.url.includes("/call/get-endpoint"));
    expect(callRequest).toBeDefined();
    expect(callRequest!.options.method).toBe("GET");
    expect(callRequest!.options.body).toBeUndefined();
  });

  test.skipIf(!process.env.TREG_TOKEN)("empty params work for POST endpoints", async () => {
    const { call } = await import("./treg");

    await call("post-endpoint", {});

    const callRequest = fetchCalls.find((c) => c.url.includes("/call/post-endpoint"));
    expect(callRequest).toBeDefined();
    expect(callRequest!.options.method).toBe("POST");
    expect(callRequest!.options.body).toBeUndefined();
  });

  test("call refuses when estimated_usd exceeds cap", async () => {
    const { call, TREG_MAX_USD_PER_CALL } = await import("./treg");
    const highCost = TREG_MAX_USD_PER_CALL + 1;

    await expect(call("test-endpoint", {}, { estimatedUsd: highCost })).rejects.toThrow(
      /exceeds the cap|TREG_MAX_USD_PER_CALL/i,
    );
  });

  test("backward compat: number arg still works as estimatedUsd", async () => {
    const { call, TREG_MAX_USD_PER_CALL } = await import("./treg");
    const highCost = TREG_MAX_USD_PER_CALL + 1;

    await expect(call("test-endpoint", {}, highCost)).rejects.toThrow(/exceeds the cap|TREG_MAX_USD_PER_CALL/i);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
});
