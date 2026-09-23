# Treg API Gateway

Engram can proxy [Treg's](https://treg.to) external API catalog, letting clients that only connect
to Engram discover and call 3,600+ external APIs without a separate Treg MCP connector.

## Setup

Set these environment variables on Railway (or your host):

| Variable | Required | Default | Description |
|---|---|---|---|
| `TREG_TOKEN` | Yes | — | Your Treg API token |
| `TREG_BASE_URL` | No | `https://treg.to` | Treg API base URL |
| `TREG_ORG_ID` | For balance | — | Treg org ID (per-org tokens bake this in) |
| `TREG_MAX_USD_PER_CALL` | No | `0.01` | Maximum cost per `tool_call` |

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

```
Agent: I need to look up company info for "acme.com"

1. tool_search("enrich company by domain")
   → Returns: company-enrichment-v1 @ $0.002/call, reliability 98%

2. tool_get("company-enrichment-v1")
   → Returns: params { domain: string }, price $0.002, full response schema

3. tool_call("company-enrichment-v1", { domain: "acme.com" }, 0.002)
   → Returns: { data: { name: "Acme Corp", employees: 500, ... }, usd_charged: 0.002 }
```

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
