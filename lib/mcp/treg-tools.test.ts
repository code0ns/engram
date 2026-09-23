import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";

/**
 * Treg MCP tools tests
 *
 * Tests that the MCP tool handlers correctly wrap the Treg API client
 * and return appropriate responses.
 */

// Sample response shapes
const MOCK_SEARCH_RESPONSE = {
  results: [
    {
      id: "tikhub.tiktok.user.profile",
      name: "TikTok User Profile",
      provider: "tikhub",
      description: "Get TikTok user profile",
      cost: { usd: 0.001, type: "per_call", unit: "call" },
      observed: { ok_rate: 0.98, sample_size: 1234, median_ms: 450, last_ok: "2026-09-22T12:00:00Z" },
    },
  ],
  total: 1,
  hints: "Use tool_get with the endpoint id.",
};

const MOCK_ENDPOINT_RESPONSE = {
  id: "tikhub.tiktok.user.profile",
  name: "TikTok User Profile",
  provider: "tikhub",
  description: "Get TikTok user profile",
  method: "GET",
  parameters: [{ name: "uniqueId", in: "query", required: true }],
  cost: { usd: 0.001, type: "per_call" },
  observed: { ok_rate: 0.98 },
  siblings: [],
  call_template: 'curl "https://treg.to/call/..."',
};

const MOCK_CALL_DATA = { user: { uniqueId: "tiktok" } };

const MOCK_BALANCE_RESPONSE = {
  balance_micro: 950000,
  balance_usd: 0.95,
  holds_micro: 0,
  holds_usd: 0,
  available_micro: 950000,
  available_usd: 0.95,
  org_id: 123,
  org_name: "Test Team",
};

let originalFetch: typeof fetch;
let originalEnv: NodeJS.ProcessEnv;

describe("Treg MCP tools", () => {
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

  describe("tool_search", () => {
    test("returns search results with flattened fields", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify(MOCK_SEARCH_RESPONSE), { status: 200 });
      }) as typeof fetch;

      const { TREG_TOOL_MAP } = await import("./treg-tools");
      const handler = TREG_TOOL_MAP.get("tool_search")!.handler;
      const result = (await handler({ query: "tiktok profile" })) as {
        results: Array<{ id: string; cost_usd: number; ok_rate: number }>;
        hints: string;
      };

      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe("tikhub.tiktok.user.profile");
      expect(result.results[0].cost_usd).toBe(0.001);
      expect(result.results[0].ok_rate).toBe(0.98);
      expect(result.hints).toContain("tool_get");
    });

    test("returns error when not configured", async () => {
      process.env.TREG_TOKEN = "";

      const { TREG_TOOL_MAP } = await import("./treg-tools");
      const handler = TREG_TOOL_MAP.get("tool_search")!.handler;
      const result = (await handler({ query: "test" })) as { error: string };

      expect(result.error).toContain("not configured");
    });
  });

  describe("tool_get", () => {
    test("returns endpoint details with hints", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify(MOCK_ENDPOINT_RESPONSE), { status: 200 });
      }) as typeof fetch;

      const { TREG_TOOL_MAP } = await import("./treg-tools");
      const handler = TREG_TOOL_MAP.get("tool_get")!.handler;
      const result = (await handler({ endpoint_id: "tikhub.tiktok.user.profile" })) as {
        id: string;
        parameters: unknown[];
        hints: string;
      };

      expect(result.id).toBe("tikhub.tiktok.user.profile");
      expect(result.parameters).toHaveLength(1);
      expect(result.hints).toContain("tool_call");
    });
  });

  describe("tool_call", () => {
    test("returns call result with cost metadata", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify(MOCK_CALL_DATA), {
          status: 200,
          headers: {
            "X-Treg-Cost-Micro": "1000",
            "X-Treg-Call-Id": "call-abc-123",
          },
        });
      }) as typeof fetch;

      const { TREG_TOOL_MAP } = await import("./treg-tools");
      const handler = TREG_TOOL_MAP.get("tool_call")!.handler;
      const result = (await handler({
        endpoint_id: "tikhub.tiktok.user.profile",
        query: { uniqueId: "tiktok" },
      })) as { data: unknown; cost_usd: number; call_id: string };

      expect(result.data).toEqual(MOCK_CALL_DATA);
      expect(result.cost_usd).toBe(0.001);
      expect(result.call_id).toBe("call-abc-123");
    });

    test("passes idempotency key", async () => {
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof fetch;

      const { TREG_TOOL_MAP } = await import("./treg-tools");
      const handler = TREG_TOOL_MAP.get("tool_call")!.handler;
      await handler({
        endpoint_id: "test.endpoint",
        idempotency_key: "my-key-123",
      });

      expect((capturedInit?.headers as Record<string, string>)?.["Idempotency-Key"]).toBe("my-key-123");
    });

    test("passes max_cost_usd", async () => {
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof fetch;

      const { TREG_TOOL_MAP } = await import("./treg-tools");
      const handler = TREG_TOOL_MAP.get("tool_call")!.handler;
      await handler({
        endpoint_id: "test.endpoint",
        max_cost_usd: 0.5,
      });

      expect((capturedInit?.headers as Record<string, string>)?.["X-Treg-Route-Max-Cost"]).toBe("0.5");
    });
  });

  describe("tool_balance", () => {
    test("returns balance info", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify(MOCK_BALANCE_RESPONSE), { status: 200 });
      }) as typeof fetch;

      const { TREG_TOOL_MAP } = await import("./treg-tools");
      const handler = TREG_TOOL_MAP.get("tool_balance")!.handler;
      const result = (await handler({})) as { balance_micro: number; balance_usd: number; org_name: string };

      expect(result.balance_micro).toBe(950000);
      expect(result.balance_usd).toBe(0.95);
      expect(result.org_name).toBe("Test Team");
    });
  });

  describe("visibleTregTools", () => {
    test("returns empty array when not configured", async () => {
      process.env.TREG_TOKEN = "";

      const { visibleTregTools } = await import("./treg-tools");
      expect(visibleTregTools()).toHaveLength(0);
    });

    test("returns all tools when configured", async () => {
      process.env.TREG_TOKEN = "test-token";

      const { visibleTregTools, TREG_TOOLS } = await import("./treg-tools");
      expect(visibleTregTools()).toHaveLength(TREG_TOOLS.length);
    });
  });

  describe("tool metadata", () => {
    test("all tools have name, description and inputSchema", async () => {
      const { TREG_TOOLS } = await import("./treg-tools");

      for (const tool of TREG_TOOLS) {
        expect(tool.name).toMatch(/^tool_/);
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema).toBeTruthy();
        expect(typeof tool.handler).toBe("function");
      }
    });

    test("tool names are unique", async () => {
      const { TREG_TOOLS, TREG_TOOL_MAP } = await import("./treg-tools");
      expect(TREG_TOOL_MAP.size).toBe(TREG_TOOLS.length);
    });
  });
});
