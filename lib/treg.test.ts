import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";

/**
 * Treg API client tests
 *
 * These tests mock fetch to verify the client sends correct requests to treg.to
 * and correctly parses responses.
 */

// Sample response shapes from the real Treg API (based on treg.to/openapi.json)
const MOCK_SEARCH_RESPONSE = {
  results: [
    {
      id: "tikhub.tiktok.user.profile",
      name: "TikTok User Profile",
      provider: "tikhub",
      description: "Get TikTok user profile by uniqueId",
      cost: { usd: 0.001, type: "per_call", unit: "call" },
      observed: { ok_rate: 0.98, sample_size: 1234, median_ms: 450, last_ok: "2026-09-22T12:00:00Z" },
    },
    {
      id: "moz.links.backlinks",
      name: "Moz Backlinks",
      provider: "moz",
      description: "Get backlinks for a domain",
      cost: { usd: 0.0025, type: "per_result", unit: "row" },
      observed: { ok_rate: 0.95, sample_size: 890, median_ms: 1200, last_ok: "2026-09-22T11:30:00Z" },
    },
  ],
  total: 2,
  hints: "Use tool_get with the endpoint id to see full parameters.",
};

const MOCK_ENDPOINT_RESPONSE = {
  id: "tikhub.tiktok.user.profile",
  name: "TikTok User Profile",
  provider: "tikhub",
  description: "Get TikTok user profile by uniqueId",
  method: "GET",
  path: "/user/profile",
  parameters: [
    { name: "uniqueId", in: "query", required: true, schema: { type: "string" }, description: "TikTok username" },
  ],
  cost: { usd: 0.001, type: "per_call", unit: "call", price_source: "provider" },
  observed: { ok_rate: 0.98, sample_size: 1234, median_ms: 450, last_ok: "2026-09-22T12:00:00Z" },
  siblings: [{ id: "apify.tiktok.user", provider: "apify", cost_usd: 0.002, ok_rate: 0.96 }],
  call_template: 'curl "https://treg.to/call/tikhub.tiktok.user.profile?uniqueId=tiktok" -H "X-Treg-Token: $TREG_TOKEN"',
  example_response: { user: { uniqueId: "tiktok", nickname: "TikTok", followerCount: 1000000 } },
  strict_query: true,
};

const MOCK_CALL_RESPONSE = {
  user: { uniqueId: "tiktok", nickname: "TikTok", followerCount: 1000000 },
};

const MOCK_BALANCE_RESPONSE = {
  balance_micro: 950000,
  balance_usd: 0.95,
  holds_micro: 50000,
  holds_usd: 0.05,
  available_micro: 900000,
  available_usd: 0.9,
  org_id: 123,
  org_name: "Test Team",
};

const MOCK_ME_RESPONSE = {
  user_id: 1,
  email: "test@example.com",
  org_id: 123,
  org_name: "Test Team",
  role: "member",
};

// Store original fetch and env
let originalFetch: typeof fetch;
let originalEnv: NodeJS.ProcessEnv;

describe("Treg API client", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    process.env.TREG_TOKEN = "test-token-123";
    process.env.TREG_BASE_URL = "https://treg.to";
    process.env.TREG_ORG_ID = "123";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  describe("catalogSearch", () => {
    test("sends correct request to /catalog/search", async () => {
      let capturedUrl: string | undefined;
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = input.toString();
        capturedInit = init;
        return new Response(JSON.stringify(MOCK_SEARCH_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      // Import after mocking to get the mocked env
      const { catalogSearch } = await import("./treg");
      const result = await catalogSearch("tiktok profile", 10);

      expect(capturedUrl).toBe("https://treg.to/catalog/search?q=tiktok+profile&limit=10");
      expect(capturedInit?.method).toBe("GET");
      expect((capturedInit?.headers as Record<string, string>)?.["X-Treg-Token"]).toBe("test-token-123");
      expect(result.results).toHaveLength(2);
      expect(result.results[0].id).toBe("tikhub.tiktok.user.profile");
    });

    test("handles default limit", async () => {
      let capturedUrl: string | undefined;

      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        capturedUrl = input.toString();
        return new Response(JSON.stringify(MOCK_SEARCH_RESPONSE), { status: 200 });
      }) as typeof fetch;

      const { catalogSearch } = await import("./treg");
      await catalogSearch("backlinks");

      expect(capturedUrl).toContain("limit=25");
    });
  });

  describe("catalogGet", () => {
    test("sends correct request to /catalog/endpoints/{id}", async () => {
      let capturedUrl: string | undefined;

      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        capturedUrl = input.toString();
        return new Response(JSON.stringify(MOCK_ENDPOINT_RESPONSE), { status: 200 });
      }) as typeof fetch;

      const { catalogGet } = await import("./treg");
      const result = await catalogGet("tikhub.tiktok.user.profile");

      expect(capturedUrl).toBe("https://treg.to/catalog/endpoints/tikhub.tiktok.user.profile");
      expect(result.id).toBe("tikhub.tiktok.user.profile");
      expect(result.parameters).toHaveLength(1);
      expect(result.siblings).toHaveLength(1);
    });

    test("URL-encodes endpoint ID", async () => {
      let capturedUrl: string | undefined;

      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        capturedUrl = input.toString();
        return new Response(JSON.stringify(MOCK_ENDPOINT_RESPONSE), { status: 200 });
      }) as typeof fetch;

      const { catalogGet } = await import("./treg");
      await catalogGet("some/weird.id");

      expect(capturedUrl).toBe("https://treg.to/catalog/endpoints/some%2Fweird.id");
    });
  });

  describe("call", () => {
    test("sends GET request by default", async () => {
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify(MOCK_CALL_RESPONSE), {
          status: 200,
          headers: {
            "X-Treg-Cost-Micro": "1000",
            "X-Treg-Call-Id": "call-123",
          },
        });
      }) as typeof fetch;

      const { call } = await import("./treg");
      const result = await call("tikhub.tiktok.user.profile", { query: { uniqueId: "tiktok" } });

      expect(capturedInit?.method).toBe("GET");
      expect(result.data).toEqual(MOCK_CALL_RESPONSE);
      expect(result.cost_usd).toBe(0.001);
      expect(result.call_id).toBe("call-123");
    });

    test("sends POST request when body is provided", async () => {
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof fetch;

      const { call } = await import("./treg");
      await call("some.endpoint", { body: { foo: "bar" } });

      expect(capturedInit?.method).toBe("POST");
      expect(capturedInit?.body).toBe('{"foo":"bar"}');
    });

    test("includes max cost header", async () => {
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof fetch;

      const { call } = await import("./treg");
      await call("some.endpoint", { maxCostUsd: 0.5 });

      expect((capturedInit?.headers as Record<string, string>)?.["X-Treg-Route-Max-Cost"]).toBe("0.5");
    });

    test("includes idempotency key when provided", async () => {
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof fetch;

      const { call } = await import("./treg");
      await call("some.endpoint", { idempotencyKey: "retry-key-123" });

      expect((capturedInit?.headers as Record<string, string>)?.["Idempotency-Key"]).toBe("retry-key-123");
    });

    test("parses cache and replay headers", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: {
            "X-Treg-Cache": "hit",
            "X-Treg-Idempotent-Replay": "true",
          },
        });
      }) as typeof fetch;

      const { call } = await import("./treg");
      const result = await call("some.endpoint");

      expect(result.cached).toBe(true);
      expect(result.replayed).toBe(true);
    });
  });

  describe("getBalance", () => {
    test("sends correct request to /orgs/{org_id}/balance", async () => {
      let capturedUrl: string | undefined;

      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        capturedUrl = input.toString();
        return new Response(JSON.stringify(MOCK_BALANCE_RESPONSE), { status: 200 });
      }) as typeof fetch;

      const { getBalance } = await import("./treg");
      const result = await getBalance();

      expect(capturedUrl).toBe("https://treg.to/orgs/123/balance");
      expect(result.balance_micro).toBe(950000);
      expect(result.balance_usd).toBe(0.95);
    });

    test("fetches org_id from /auth/me when not configured", async () => {
      process.env.TREG_ORG_ID = "";
      const urls: string[] = [];

      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        const url = input.toString();
        urls.push(url);
        if (url.includes("/auth/me")) {
          return new Response(JSON.stringify(MOCK_ME_RESPONSE), { status: 200 });
        }
        return new Response(JSON.stringify(MOCK_BALANCE_RESPONSE), { status: 200 });
      }) as typeof fetch;

      const { getBalance } = await import("./treg");
      await getBalance();

      expect(urls).toContain("https://treg.to/auth/me");
      expect(urls.some((u) => u.includes("/orgs/123/balance"))).toBe(true);
    });
  });

  describe("error handling", () => {
    test("throws TregApiError on non-2xx response", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });
      }) as typeof fetch;

      const { catalogGet, TregApiError } = await import("./treg");

      try {
        await catalogGet("nonexistent.endpoint");
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect(e).toBeInstanceOf(TregApiError);
        expect((e as InstanceType<typeof TregApiError>).status).toBe(404);
        expect((e as InstanceType<typeof TregApiError>).detail).toBe("Not found");
      }
    });

    test("handles 402 out of balance error", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            error: "insufficient_balance",
            balance_micro: 500,
            estimated_cost_micro: 1000,
            topup_url: "https://treg.to/billing",
          }),
          { status: 402 },
        );
      }) as typeof fetch;

      const { call, TregApiError } = await import("./treg");

      try {
        await call("expensive.endpoint");
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(TregApiError);
        expect((e as InstanceType<typeof TregApiError>).status).toBe(402);
      }
    });
  });
});

describe("Treg configuration", () => {
  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("isTregConfigured returns false without token", async () => {
    process.env.TREG_TOKEN = "";
    // Re-import to pick up new env
    const mod = await import("./treg");
    // Force re-evaluation by checking the exported constant
    expect(mod.TREG_TOKEN || mod.isTregConfigured()).toBeFalsy();
  });

  test("default base URL is https://treg.to", async () => {
    delete process.env.TREG_BASE_URL;
    const mod = await import("./treg");
    expect(mod.TREG_BASE_URL).toBe("https://treg.to");
  });

  test("default max USD per call is 1.0", async () => {
    delete process.env.TREG_MAX_USD_PER_CALL;
    const mod = await import("./treg");
    expect(mod.TREG_MAX_USD_PER_CALL).toBe(1.0);
  });
});
