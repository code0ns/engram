# Treg Integration

Engram includes a proxy to [Treg](https://treg.to), a tool catalog that gives agents access to
3,600+ external endpoints across 90 providers — SEO and SERP data, backlinks, social and trends,
people and company enrichment, ads, scraping, image and video generation — all through a unified
API with a single token.

When configured, Engram exposes four MCP tools: `tool_search`, `tool_get`, `tool_call`, and
`tool_balance`.

## Configuration

Set these environment variables (or add them to `.env.local`):

| Variable | Required | Description |
|----------|----------|-------------|
| `TREG_TOKEN` | Yes | Your Treg API token. Get one at [treg.to](https://treg.to) |
| `TREG_BASE_URL` | No | API base URL (default: `https://treg.to`) |
| `TREG_ORG_ID` | No | Org ID for balance queries. Auto-detected from token if omitted |
| `TREG_MAX_USD_PER_CALL` | No | Max cost per `tool_call` in USD (default: `1.0`) |

Without `TREG_TOKEN`, the Treg tools are hidden from agents.

## Tools

### tool_search

Search the Treg catalog for endpoints by what you want to DO.

```
tool_search({ query: "backlinks for a domain", limit: 10 })
```

Returns matching endpoints with:
- `id` — use this in `tool_get` and `tool_call`
- `name`, `provider`, `description`
- `cost_usd`, `cost_type`, `cost_unit` — what it costs
- `ok_rate`, `sample_size`, `median_ms`, `last_ok` — observed reliability

### tool_get

Get full details about one catalog endpoint.

```
tool_get({ endpoint_id: "moz.links.backlinks" })
```

Returns everything you need to call it:
- `parameters` — what to send
- `request_body` — body schema if applicable
- `cost` — pricing details
- `siblings` — alternative providers for the same capability (for price/reliability comparison)
- `call_template` — paste-ready curl command
- `example_response` — what comes back

### tool_call

Call a catalog endpoint or team tool.

```
tool_call({
  endpoint_id: "tikhub.tiktok.user.profile",
  query: { uniqueId: "tiktok" }
})
```

Options:
- `method` — HTTP method (default: GET if no body, POST if body)
- `query` — query parameters as `{ key: value }`
- `body` — JSON request body
- `idempotency_key` — for safe retries (same key = same response, no double charge)
- `max_cost_usd` — override the per-call spend cap

Response includes:
- `data` — the upstream response (verbatim from the provider)
- `cost_usd` — what was charged
- `call_id` — for support/audit
- `cached` — true if served from cache (10% cost)
- `replayed` — true if idempotent replay (no charge)

### tool_balance

Check the team's prepaid Treg balance.

```
tool_balance({})
```

Returns:
- `balance_micro`, `balance_usd` — current balance
- `holds_micro`, `holds_usd` — in-flight holds (pending async tasks)
- `available_micro`, `available_usd` — what's actually spendable
- `org_id`, `org_name` — which team

## Spend Control

The `TREG_MAX_USD_PER_CALL` environment variable sets a hard ceiling per call. Any `tool_call`
that would exceed this is refused with HTTP 402 before it reaches the provider — nothing is
charged.

Agents can override this per-call with `max_cost_usd`, but only downward (they can set a lower
cap, not raise it above the env limit).

## Auth Header

Engram uses the `X-Treg-Token` header for authentication, which is the preferred method per
Treg's documentation. The token is sent with every request to the Treg API.

If you have a per-org token (created via `treg org create` or the dashboard), it already
includes the org context. Identity tokens require `TREG_ORG_ID` or will auto-detect from
`/auth/me`.

## Real API Endpoints

Engram proxies to these real Treg routes at `https://treg.to`:

| Operation | Treg Route |
|-----------|------------|
| Catalog search | `GET /catalog/search?q=<query>&limit=<n>` |
| Catalog get | `GET /catalog/endpoints/{endpoint_id}` |
| Call | `{METHOD} /call/{endpoint_id}` |
| Balance | `GET /orgs/{org_id}/balance` |
| Auth/me | `GET /auth/me` |

For full API documentation, see:
- [treg.to/llms.txt](https://treg.to/llms.txt) — the agent-readable docs
- [treg.to/openapi.json](https://treg.to/openapi.json) — OpenAPI spec
- [treg.to/docs](https://treg.to/docs) — human docs

## Getting a Token

1. Visit [treg.to](https://treg.to) and sign up (GitHub or email)
2. Create or join a team
3. Go to Settings → API Keys and create a key
4. Set it as `TREG_TOKEN` in your Engram environment

New verified accounts receive $1.00 free credit once. Catalog search is free; calls to
external endpoints are billed per-call (fractions of a cent for most lookups).
