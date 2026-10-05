import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import {
  call,
  extractMethodFromTemplate,
  normalizeHttpMethod,
  clearEndpointMethodCache,
  TREG_MAX_USD_PER_CALL,
  type TregConfig,
} from "./treg";
import { spentToday } from "./treg-config";

/**
 * Tests for Treg HTTP method handling and spend enforcement.
 *
 * The key issue being fixed for methods: GET endpoints that need query params (like Diffbot)
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

function cfg(over: Partial<TregConfig> = {}): TregConfig {
  return {
    token: "test-token",
    baseUrl: "https://treg.test",
    orgId: "",
    perCallCapUsd: 1,
    dailyCapUsd: 100,
    // Unique per test: the ledger is a file shared by the whole run.
    ledgerKey: `test-ws-${crypto.randomUUID()}`,
    source: "workspace",
    ...over,
  };
}

interface FakeEndpoint {
  price?: number;
  method?: string;
  template?: string;
  callStatus?: number;
  callBody?: unknown;
}

/**
 * Integration tests with a mocked fetch: HTTP method selection, plus the spend enforcement
 * (authoritative catalog price, per-call cap, daily cap with reserve / settle / refund).
 */
describe("Treg calls (mocked fetch)", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[];
  let endpoints: Record<string, FakeEndpoint>;

  beforeEach(() => {
    clearEndpointMethodCache();
    fetchCalls = [];
    endpoints = {
      "get-endpoint": { template: "treg call get-endpoint --method GET" },
      "post-endpoint": { template: "treg call post-endpoint --method POST" },
      "diffbot.x.extract-article": {
        method: "GET",
        template: "treg call diffbot.x.extract-article --query url=https://...",
        price: 0.001196,
      },
    };
    originalFetch = globalThis.fetch;

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, options: init ?? {} });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

      const cat = url.match(/\/catalog\/endpoints\/([^?]+)/);
      if (cat) {
        const id = decodeURIComponent(cat[1]);
        const e = endpoints[id];
        if (!e) return json({ id, provider: "test", name: id }); // priceless, methodless
        return json({
          id,
          provider: "test",
          name: id,
          method: e.method,
          call_template: e.template,
          cost: e.price === undefined ? undefined : { usd: e.price },
        });
      }

      const callM = url.match(/\/call\/([^?]+)/);
      if (callM) {
        const e = endpoints[decodeURIComponent(callM[1])] ?? {};
        return json(e.callBody ?? { data: "ok" }, e.callStatus ?? 200);
      }

      return new Response("Not Found", { status: 404 });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("GET endpoint: params sent as query string, not body", async () => {
    await call(cfg(), "get-endpoint", { url: "https://example.com", timeout: 30 });

    const callRequest = fetchCalls.find((c) => c.url.includes("/call/get-endpoint"));
    expect(callRequest).toBeDefined();
    expect(callRequest!.options.method).toBe("GET");
    expect(callRequest!.url).toContain("url=https");
    expect(callRequest!.url).toContain("timeout=30");
    expect(callRequest!.options.body).toBeUndefined();
  });

  test("Diffbot-shaped catalog: uses top-level method field, not call_template", async () => {
    await call(cfg(), "diffbot.x.extract-article", { url: "https://example.com/article" });

    const callRequest = fetchCalls.find((c) => c.url.includes("/call/diffbot.x.extract-article"));
    expect(callRequest).toBeDefined();
    expect(callRequest!.options.method).toBe("GET");
    expect(callRequest!.url).toContain("url=https");
    expect(callRequest!.options.body).toBeUndefined();
  });

  test("POST endpoint: params sent as JSON body", async () => {
    await call(cfg(), "post-endpoint", { url: "https://example.com", data: { key: "value" } });

    const callRequest = fetchCalls.find((c) => c.url.includes("/call/post-endpoint"));
    expect(callRequest).toBeDefined();
    expect(callRequest!.options.method).toBe("POST");
    expect(JSON.parse(callRequest!.options.body as string)).toEqual({
      url: "https://example.com",
      data: { key: "value" },
    });
  });

  test("method override wins over the catalog's method (the catalog is still read for the price)", async () => {
    await call(cfg(), "some-endpoint", { param: "value" }, { method: "DELETE" });

    const callRequest = fetchCalls.find((c) => c.url.includes("/call/some-endpoint"));
    expect(callRequest!.options.method).toBe("DELETE");
    expect(fetchCalls.some((c) => c.url.includes("/catalog/endpoints/some-endpoint"))).toBe(true);
  });

  test("empty params work for GET and POST endpoints", async () => {
    await call(cfg(), "get-endpoint", {});
    await call(cfg(), "post-endpoint", {});

    const get = fetchCalls.find((c) => c.url.includes("/call/get-endpoint"));
    const post = fetchCalls.find((c) => c.url.includes("/call/post-endpoint"));
    expect(get!.options.method).toBe("GET");
    expect(get!.options.body).toBeUndefined();
    expect(post!.options.method).toBe("POST");
    expect(post!.options.body).toBeUndefined();
  });

  test("sends the config's own token and base URL", async () => {
    await call(cfg({ token: "ws-secret", baseUrl: "https://other.treg" }), "get-endpoint", {});
    const callRequest = fetchCalls.find((c) => c.url.includes("/call/get-endpoint"))!;
    expect(callRequest.url.startsWith("https://other.treg/")).toBe(true);
    expect((callRequest.options.headers as Record<string, string>)["X-Treg-Token"]).toBe("ws-secret");
  });

  test("a config with no token is refused", async () => {
    await expect(call(cfg({ token: "" }), "get-endpoint", {})).rejects.toThrow(/not configured/i);
  });

  // ── spend enforcement ──────────────────────────────────────────────────────

  test("call refuses when estimated_usd exceeds the per-call cap (before any network call)", async () => {
    const c = cfg({ perCallCapUsd: TREG_MAX_USD_PER_CALL });
    await expect(call(c, "test-endpoint", {}, { estimatedUsd: TREG_MAX_USD_PER_CALL + 1 })).rejects.toThrow(
      /exceeds the cap|TREG_MAX_USD_PER_CALL/i,
    );
    expect(fetchCalls.length).toBe(0);
  });

  test("backward compat: a bare number still works as estimatedUsd", async () => {
    await expect(call(cfg({ perCallCapUsd: 0.01 }), "test-endpoint", {}, 5)).rejects.toThrow(/exceeds the cap/i);
  });

  test("the catalog price beats a low or omitted estimate", async () => {
    endpoints["pricey"] = { price: 0.5 };
    const c = cfg({ perCallCapUsd: 0.01 });

    // Agent understates the cost...
    await expect(call(c, "pricey", {}, { estimatedUsd: 0.0001 })).rejects.toThrow(/exceeds the cap/i);
    // ...or omits it entirely (previously this skipped the cap altogether).
    await expect(call(c, "pricey", {})).rejects.toThrow(/exceeds the cap/i);
    expect(fetchCalls.some((x) => x.url.includes("/call/pricey"))).toBe(false);
  });

  test("daily cap: refuses once today's spend plus the call would exceed it", async () => {
    endpoints["cheap"] = { price: 0.002 };
    const c = cfg({ perCallCapUsd: 0.01, dailyCapUsd: 0.003 });

    await call(c, "cheap", {});
    expect(spentToday(c.ledgerKey)).toBeCloseTo(0.002, 6);
    await expect(call(c, "cheap", {})).rejects.toThrow(/daily cap/i);
    expect(spentToday(c.ledgerKey)).toBeCloseTo(0.002, 6);
  });

  test("a failed call is not charged (the reservation is given back)", async () => {
    endpoints["flaky"] = { price: 0.004, callStatus: 500, callBody: { error: "boom" } };
    const c = cfg({ perCallCapUsd: 0.01 });

    await expect(call(c, "flaky", {})).rejects.toThrow(/boom/);
    expect(spentToday(c.ledgerKey)).toBe(0);
  });

  test("the ledger settles to the charge Treg reports", async () => {
    endpoints["metered"] = { price: 0.004, callBody: { data: "x", cost_usd: 0.0005, call_id: "c-1" } };
    const c = cfg({ perCallCapUsd: 0.01 });

    const res = await call(c, "metered", {});
    expect(res.cost_usd).toBeCloseTo(0.0005, 6);
    expect(res.call_id).toBe("c-1");
    expect(spentToday(c.ledgerKey)).toBeCloseTo(0.0005, 6);
  });

  test("spend is tracked per workspace, not shared", async () => {
    endpoints["cheap"] = { price: 0.002 };
    const a = cfg({ perCallCapUsd: 0.01, dailyCapUsd: 0.003 });
    const b = cfg({ perCallCapUsd: 0.01, dailyCapUsd: 0.003 });

    await call(a, "cheap", {});
    await call(b, "cheap", {}); // b's budget is untouched by a's spend
    expect(spentToday(a.ledgerKey)).toBeCloseTo(0.002, 6);
    expect(spentToday(b.ledgerKey)).toBeCloseTo(0.002, 6);
  });

  test("an unreadable catalog price refuses the call unless estimate AND method are given", async () => {
    globalThis.fetch = mock(async () => new Response("down", { status: 503 })) as typeof globalThis.fetch;
    await expect(call(cfg(), "x", {})).rejects.toThrow(/could not read the catalog price/i);
    await expect(call(cfg(), "x", {}, { estimatedUsd: 0.001 })).rejects.toThrow(/could not read the catalog price/i);
  });
});
