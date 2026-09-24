# Treg API Gateway

Engram can proxy [Treg's](https://treg.to) external API catalog, letting clients that only connect
to Engram discover and call 3,600+ external APIs without a separate Treg MCP connector.

## Setup

Set these environment variables on Railway (or your host):

| Variable | Required | Default | Description |
|---|---|---|---|
| `TREG_TOKEN` | Yes | — | Your Treg API token |
| `TREG_BASE_URL` | No | `https://treg.to` | Treg API base URL |
| `TREG_ORG_ID` | For balance | — | Treg org ID **or team slug** (per-org tokens bake this in) |
| `TREG_MAX_USD_PER_CALL` | No | `0.01` | Maximum cost per `tool_call` |

> **Tip**: `TREG_ORG_ID` accepts either a numeric org ID (e.g. `12345`) or a team slug
> (e.g. `harold-builds`). When a slug is provided, Engram resolves it to the numeric ID
> by calling `GET /orgs` and caches the result for the server lifetime.

When `TREG_TOKEN` is unset, the Treg tools are hidden from the MCP surface entirely — matching
how `brain_capture` is hidden when the Curator is off.

## MCP Tools

### `tool_search` (read scope)
Search Treg's catalog by describing the task you want to do.

```json
{
  "query": "reverse geocode coordinates",
  "limit": 10
}
```

Returns endpoints with `endpoint_id`, `provider`, `name`, `usd_per_call`, `reliability`, and
`no_key_needed`. Always check the price before calling.

### `tool_get` (read scope)
Get full details for an endpoint before calling it.

```json
{
  "endpoint_id": "geocoding-reverse-v1"
}
```

Returns the full parameter schema, response schema, and exact price. If the price exceeds
`TREG_MAX_USD_PER_CALL`, the response includes a warning.

### `tool_call` (write scope)
Call an endpoint through Treg. **This costs money.**

```json
{
  "endpoint_id": "geocoding-reverse-v1",
  "params": { "lat": 40.7128, "lon": -74.006 },
  "estimated_usd": 0.0005
}
```

- Calls exceeding `TREG_MAX_USD_PER_CALL` are refused with a clear error
- Pass `estimated_usd` (from `tool_get`) to enforce the spending cap
- Returns `data`, `call_id`, and `usd_charged`

#### HTTP Method Selection

The HTTP method (GET, POST, etc.) is automatically determined from the catalog in this priority order:

1. **Top-level `method` field** — Preferred source (e.g., `"method": "GET"`)
2. **Parsed from `call_template`** — Fallback if method field is missing (e.g., `--method GET`)
3. **Default to POST** — Last resort for backward compatibility

- **GET endpoints** (like Diffbot): `params` are sent as a query string
- **POST endpoints** (like AnyAPI): `params` are sent as a JSON body

This is automatic — you don't need to specify the method. If you need to override it (e.g., for
an endpoint with incorrect catalog metadata), pass `method`:

```json
{
  "endpoint_id": "some-endpoint",
  "params": { "url": "https://example.com" },
  "method": "GET"
}
```

Valid methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.

### `tool_balance` (write scope)
Check the Treg account balance.

```json
{}
```

Returns `balance_usd` and `currency`. Write-scope because it reveals spending information.

## Scope Rules

Matches Engram's existing patterns:

| Scope | Can see | Rationale |
|---|---|---|
| `read` | `tool_search`, `tool_get` | Discovery only, no cost |
| `write` | All four tools | Can spend money or reveal balance |

A read-only token cannot even see `tool_call` or `tool_balance` — matching how read-only tokens
cannot see `brain_write` or `brain_delete`.

## Example Agent Flow

### POST endpoint (most endpoints)

```
Agent: I need to look up company info for "acme.com"

1. tool_search("enrich company by domain")
   → Returns: company-enrichment-v1 @ $0.002/call, reliability 98%

2. tool_get("company-enrichment-v1")
   → Returns: params { domain: string }, price $0.002, call_template with --method POST

3. tool_call("company-enrichment-v1", { domain: "acme.com" }, 0.002)
   → Sends: POST /call/company-enrichment-v1 with JSON body { domain: "acme.com" }
   → Returns: { data: { name: "Acme Corp", employees: 500, ... }, usd_charged: 0.002 }
```

### GET endpoint (like Diffbot)

```
Agent: I need to extract the article from https://example.com/article

1. tool_search("extract article from url")
   → Returns: diffbot.x.extract-article @ $0.001/call

2. tool_get("diffbot.x.extract-article")
   → Returns: params { url: string }, method: "GET" in catalog metadata

3. tool_call("diffbot.x.extract-article", { url: "https://example.com/article" }, 0.001)
   → Sends: GET /call/diffbot.x.extract-article?url=https://example.com/article
   → Returns: { data: { title: "...", text: "...", ... }, usd_charged: 0.001 }
```

The HTTP method is auto-detected from the catalog's `method` field — you don't need to specify it.

## Spending Cap

The `TREG_MAX_USD_PER_CALL` cap (default $0.01) prevents accidental expensive calls:

- `tool_call` refuses requests where `estimated_usd` exceeds the cap
- `tool_get` warns when an endpoint's price exceeds the cap
- Error messages tell the agent to get human approval or ask the operator to raise the cap

To raise the cap:
```bash
# Railway → Variables
TREG_MAX_USD_PER_CALL=0.10  # Allow up to $0.10 per call
```

## Logging

Treg calls are logged for ops visibility:

```
[treg] search ok
[treg] get endpoint=geocoding-reverse-v1 ok
[treg] call endpoint=geocoding-reverse-v1 usd=0.0005 ok
[treg] call endpoint=expensive-v1 usd=0.5000 fail: exceeds the cap
```

Logs include endpoint ID and cost estimate, but never the Treg token or request/response bodies.

## Security

- The `TREG_TOKEN` is used server-side only — never exposed in MCP responses
- Token is not stored in the vault or in any client-accessible location
- Spending is gated by both scope (`write` required) and cost cap (`TREG_MAX_USD_PER_CALL`)
- Balance visibility requires `write` scope (reveals spending information)
