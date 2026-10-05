# Treg API Gateway

Engram can proxy [Treg's](https://treg.to) external API catalog, letting clients that only connect
to Engram discover and call 2,600+ external APIs without a separate Treg MCP connector.

## Setup

Credentials and limits are **per workspace**, falling back to server-wide defaults.

**1. Server defaults (Railway → Variables, or your host's env):**

| Variable | Required | Default | Description |
|---|---|---|---|
| `TREG_TOKEN` | For the shared fallback | — | Treg API token used by any workspace without its own |
| `TREG_BASE_URL` | No | `https://treg.to` | Treg API base URL |
| `TREG_ORG_ID` | For balance | — | Treg org ID **or team slug** (per-org tokens bake this in) |
| `TREG_MAX_USD_PER_CALL` | No | `0.01` | Default maximum cost of one `tool_call` |
| `TREG_MAX_USD_PER_DAY` | No | `1.00` | Default maximum spend per workspace per UTC day |

> **Tip**: `TREG_ORG_ID` accepts either a numeric org ID (e.g. `12345`) or a team slug
> (e.g. `harold-builds`). When a slug is provided, Engram resolves it to the numeric ID
> by calling `GET /orgs` and caches the result per credential.

**2. Per workspace (admins only):** *Access → Workspaces → ⚙ settings → Tool budget (Treg)*. Set the
workspace's own token, org, per-call cap and daily cap. Anything left blank uses the server default
above. This is what separates one client's Treg wallet and limits from another's.

If a workspace has no token of its own and `TREG_TOKEN` is unset, the Treg tools are hidden from
that workspace's MCP surface entirely — matching how `brain_capture` is hidden when the Curator is off.

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

Returns the full parameter schema, response schema, and exact price, plus a hint with this
workspace's caps and how much of today's budget is left. If the price exceeds a cap, the hint warns.

### `tool_call` (write scope)
Call an endpoint through Treg. **This costs money.**

```json
{
  "endpoint_id": "geocoding-reverse-v1",
  "params": { "lat": 40.7128, "lon": -74.006 },
  "estimated_usd": 0.0005
}
```

- `estimated_usd` is advisory. The server enforces the **catalog price** (the larger of the two)
- Refused when that price exceeds the workspace's per-call cap, or when today's spend plus this call
  would exceed its daily cap
- Spend is reserved before the request and settled to the real charge afterwards; a failed call is
  not charged
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
Check the Treg account balance for the workspace's token.

```json
{}
```

Returns `balance_usd`, `currency`, plus `spent_today_usd` and `daily_cap_usd`. Write-scope because it
reveals spending information.

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

## Spending Caps

Two caps apply to every workspace, both enforced on the server:

| Cap | Default | Meaning |
|---|---|---|
| Per call | `$0.01` | A single call whose price is above this is refused |
| Per day | `$1.00` | Calls are refused once today's (UTC) spend plus the call would exceed this |

The price used is the larger of the agent's `estimated_usd` and the **catalog's own price**, so an
agent cannot get past a cap by omitting or understating the estimate. If the catalog price can't be
read, the call is refused (pass both `estimated_usd` and `method` to proceed deliberately).

To change them: *Access → Workspaces → ⚙ settings* (admins), or set the server-wide defaults:
```bash
# Railway → Variables
TREG_MAX_USD_PER_CALL=0.10   # allow up to $0.10 per call
TREG_MAX_USD_PER_DAY=5       # allow up to $5/day per workspace
```

Spend is tracked per workspace in `treg-ledger.json` under `ENGRAM_DATA_DIR` (35 days kept).

## Logging

Treg calls are logged for ops visibility:

```
[treg] search ws=ws-acme ok
[treg] get ws=ws-acme endpoint=geocoding-reverse-v1 ok
[treg] call ws=ws-acme endpoint=geocoding-reverse-v1 usd=0.0005 ok
[treg] call ws=ws-acme endpoint=expensive-v1 usd=0.5000 fail: exceeds the cap
```

Logs include workspace, endpoint ID and cost, but never the Treg token or request/response bodies.

## Security

- Tokens are used server-side only — never exposed in MCP responses or returned to the browser
  (the dashboard only learns *whether* a token is set)
- A token set from the dashboard is stored encrypted (keyed off `AUTH_SECRET`) in `treg.json`
  under `ENGRAM_DATA_DIR`, never in a vault repo
- Changing a workspace's token or limits is admin-only
- Spending is gated by scope (`write` required), the per-call cap and the daily cap
- Balance visibility requires `write` scope (reveals spending information)
