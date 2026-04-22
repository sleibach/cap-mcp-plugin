## CAP MCP Plugin

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE.md)

A CAP (SAP Cloud Application Programming) plugin that generates a Model Context Protocol (MCP) server from your CDS model. Annotated entities become MCP resources, functions and actions become tools, and services can expose reusable prompt templates.

## Credits

This plugin is based on the excellent [`@gavdi/cap-mcp`](https://www.npmjs.com/package/@gavdi/cap-mcp) plugin by [Gavdi Labs](https://github.com/gavdilabs/cap-mcp-plugin). The annotation model, entity-to-resource generation, tool wrapping, and prompt templates all originate from that project. Full credit for the original design and implementation goes to the Gavdi Labs team and the contributors of the upstream repository.

This repository is an independent development line that extends the original with additional work around OAuth, IAS integration, approuter deployment, and related enterprise-auth concerns. Upstream and this fork are maintained separately; if you want the canonical, vendor-supported plugin, use the upstream.

This line is **not** intended for pull requests back into Gavdi’s repo. On GitHub the repository may still be registered as a **fork**, which causes compare/merge suggestions from the upstream network until you detach it (one-time, on github.com): **[Settings → General](https://github.com/sleibach/cap-mcp-plugin/settings)** → scroll to **Danger Zone** → **Leave fork network** and confirm with the repository name. Your local clone should only list **`origin`** (`git remote -v`); do not add an `upstream` remote unless you explicitly want to track Gavdi’s branch.

For protocol details, see the [MCP specification](https://modelcontextprotocol.io).

## Features

- Expose CDS entities as MCP resources with OData v4 query support (`$filter`, `$orderby`, `$top`, `$skip`, `$select`).
- Expose CDS functions and actions as MCP tools — both unbound (service-level) and bound (entity-level).
- Wrap entities as CRUD-style tools (`query`, `get`, optional `create` / `update`) for LLM tool-use.
- Declare reusable prompt templates.
- Request user confirmation or parameter input before tool execution (elicitation).
- Filter sensitive fields from MCP output via `@mcp.omit`.
- Enrich schemas for AI agents via `@mcp.hint` on elements and parameters.
- Auth modes: `inherit` (use CAP's configured auth — `mocked`, `basic`, `jwt`, `xsuaa`, `ias`) or `none`.
- Built-in OAuth proxy with RFC 9728 protected-resource metadata and DCR emulation for IAS.

## Requirements

- Node.js 18+
- `@sap/cds` 9+
- `express` 4+

## Install

There is **no npm registry package yet**. Install straight from GitHub:

```bash
npm install github:sleibach/cap-mcp-plugin
```

(Optionally pin a branch or tag: `github:sleibach/cap-mcp-plugin#main` or `#v1.3.0` once you publish tags.)

The plugin follows CAP’s standard plugin architecture and is picked up automatically once it is listed in your app’s `dependencies`.

## Configure

Add an `mcp` block under `cds` in `package.json`:

```json
{
  "cds": {
    "mcp": {
      "name": "my-bookshop-mcp",
      "auth": "inherit",
      "wrap_entities_to_actions": false,
      "wrap_entity_modes": ["query", "get"],
      "instructions": "MCP server instructions for agents"
    }
  }
}
```

## Annotate your services

```cds
// srv/catalog-service.cds
service CatalogService {

  @mcp: {
    name: 'books',
    description: 'Book catalog with search and filtering',
    resource: ['filter', 'orderby', 'select', 'top', 'skip']
  }
  entity Books as projection on my.Books;

  annotate CatalogService.Books with @mcp.wrap: {
    tools: true,
    modes: ['query', 'get'],
    hint: 'Use for read-only lookups of books'
  };

  @mcp: {
    name: 'get-book-recommendations',
    description: 'Get personalized book recommendations',
    tool: true
  }
  function getRecommendations(genre: String, limit: Integer) returns array of String;
}
```

## Run

```bash
cds serve
```

Endpoints:

- MCP: `http://localhost:4004/mcp`
- Health: `http://localhost:4004/mcp/health`

## Annotation reference

### Resources (`@mcp.resource`)

```cds
service CatalogService {

  @readonly
  @mcp: {
    name       : 'books',
    description: 'Book data list',
    resource   : ['filter', 'orderby', 'select', 'skip', 'top']
  }
  entity Books as projection on my.Books;

  // Enable all OData query options
  @mcp: {
    name       : 'authors',
    description: 'Author data list',
    resource   : true
  }
  entity Authors as projection on my.Authors;

  // Static top-100 list (no query options)
  @mcp: {
    name       : 'genres',
    description: 'Book genre list',
    resource   : []
  }
  entity Genres as projection on my.Genres;
}
```

### Entity wrappers (`@mcp.wrap`)

When `wrap_entities_to_actions` is enabled globally, or a specific entity is annotated with `@mcp.wrap.tools: true`, each entity is also exposed as a set of tools:

- If the entity has `@mcp.name` on its resource block, wrapper tools use **`{name}_query`**, **`{name}_get`**, etc. (keeps IDs short—many MCP clients limit **tool `name` to 64 characters**; long service + entity names alone can exceed that).
- Otherwise the legacy pattern: `<Service>_<Entity>_query`, `<Service>_<Entity>_get`, …

```cds
annotate CatalogService.Books with @mcp.wrap: {
  tools: true,
  modes: ['query', 'get', 'create', 'update'],
  hint : 'Use for read and write demo operations'
};
```

Available modes:

- `query` — list/search rows (supports `top`, `skip`, `select`, `where`, `orderby`, `q`, `expand`, `return`, `aggregate`, `explain`).
- `get` — read a single row by key(s).
- `create` — insert a new active row.
- `update` — patch an active row by key(s).
- `delete` — remove a row by key(s).
- `draft-new` — create a pending draft (registers automatically on `@odata.draft.enabled` / `@fiori.draft.enabled` roots).
- `draft-edit` — start editing an existing active row (creates a draft copy).
- `draft-patch` — apply field changes to an existing draft.
- `draft-activate` — publish the pending draft to the active row.
- `draft-discard` — drop the pending draft without touching the active row.
- `draft-upsert` — one-shot: creates a draft and immediately activates it in a single transaction (use when all required fields are known up front).

### Draft lifecycle

For draft-enabled roots (annotated with `@odata.draft.enabled` or `@fiori.draft.enabled`), the wrapper:

- **Auto-registers** the five `draft-*` tools listed above alongside the CRUD tools — no need to list them explicitly in `@mcp.wrap.modes`.
- **Short-circuits active-row `create`, `update`, and `delete`** with a `DRAFT_REQUIRED` error that names the relevant `draft-new` / `draft-edit` / `draft-patch` / `draft-activate` / `draft-discard` tools. This replaces the opaque CAP runtime error that surfaces when a caller tries to bypass the draft pipeline, and — crucially — it sidesteps synchronous `@assert.target` FK validation on `create`. The Fiori draft runtime defers those checks until activation, so an FK pointing at a remote / S/4 value-help source that can't be resolved synchronously still lets the draft land.
  - **Exception:** entities annotated with `@odata.draft.bypass` (or the whole service with `cds.env.fiori.bypass_draft: true`) continue to accept direct active-row `create`/`update`/`delete`, matching CAP's own bypass semantics. The `draft-*` tools remain available for callers that prefer the lifecycle.
- **Extends `get` and `query`** with an optional `IsActiveEntity` parameter:
  - `get` defaults to `true` (reads the active row). Pass `false` to read the draft sibling.
  - `query` returns both active and draft rows when omitted; pass `true` or `false` to narrow the result.
- **Surfaces draft admin fields** (`HasActiveEntity`, `HasDraftEntity`, `DraftAdministrativeData`) on read responses so the LLM can reason about locks and pending edits.

Typical round-trip:

```jsonc
// 1. Create a draft
tools/call { "name": "books_draft-new", "arguments": { "ID": 42, "title": "Draft Title" } }
// 2. Patch fields on the draft
tools/call { "name": "books_draft-patch", "arguments": { "ID": 42, "stock": 5 } }
// 3. Publish to the active row
tools/call { "name": "books_draft-activate", "arguments": { "ID": 42 } }

// Edit an existing active row:
tools/call { "name": "books_draft-edit", "arguments": { "ID": 42 } }
// ... then draft-patch + draft-activate, or draft-discard to throw away.

// One-shot create + activate (single transaction, single principal):
tools/call { "name": "books_draft-upsert", "arguments": { "ID": 43, "title": "Atomic Insert", "stock": 7 } }
```

#### `draft-upsert`: one-shot for stateless MCP callers

Each MCP tool call is a standalone HTTP request. If the authenticated principal drifts
between the request that opened the draft (`draft-new`) and the request that publishes it
(`draft-activate`) — for example because the MCP bearer token resolves to a different
`cds.context.user.id` than the one that held the lock — the second call fails with
`DRAFT_LOCKED`, even though the caller is the same human.

`draft-upsert` sidesteps this entirely: the NEW and SAVE events run on the **same
`svc.tx({user}, …)` callback**, so the `InProcessByUser` written by NEW is guaranteed to
match the principal at SAVE time. If SAVE fails (e.g. an un-filled `@mandatory` field),
the transaction rolls back and no orphan draft is left behind.

Use it when:
- The LLM already has all required fields up front (no iterative `draft-patch` needed).
- You want a single atomic unit of work in the audit log.
- You're running behind stateless MCP plumbing and want to rule out cross-call principal drift.

Use the discrete `draft-new` / `draft-patch` / `draft-activate` trio when the caller
legitimately needs to inspect the pending draft between turns, or when `draft-edit` on an
existing active row is the entry point.

#### Composite-key associations

Associations with more than one target key (e.g. `technicalObject : Association to TechnicalObject`
where `TechnicalObject` is keyed on `(TechnicalObject, ObjectType)`) are surfaced as **one flat
parameter per generated FK column** on `create`, `update`, `draft-new`, and `draft-patch`. The
naming follows CAP's on-disk convention, `{propName}_{targetKey}`:

```jsonc
tools/call {
  "name": "change-requests_draft-new",
  "arguments": {
    "ID": "…",
    "title": "…",
    "technicalObject_TechnicalObject": "7500008",
    "technicalObject_ObjectType": "E"
  }
}
```

Single-key associations degenerate to the familiar `{propName}_ID` form. Supplying only a
subset of the FK columns produces `ASSERT_DATA_TYPE` — the error now includes a hint pointing
at the missing FK columns.

#### `@mandatory` and activation-time validation

`@mandatory` and `@assert.*` constraints on draft-enabled roots are **deferred to activation**:
`draft-new` / `draft-patch` accept partial payloads, and the validation pipeline runs when
`draft-activate` calls `SAVE`. A violation returns `DRAFT_ACTIVATE_FAILED` with the offending
field name in the message; the draft row survives so the caller can `draft-patch` the fix and
re-activate.

#### Locking semantics

CAP stores the draft holder in `DraftAdministrativeData.InProcessByUser`, scoped to the
authenticated principal. When a second caller (different bearer token or mocked user) tries to
`draft-patch` / `draft-activate` a draft that another user owns, the plugin returns
`DRAFT_LOCKED` with the holder's id in the message. Locks expire after
`cds.env.drafts.cancellationTimeout` minutes (default: 15); `draft-discard` by the holder
releases them immediately. MCP clients sharing the same bearer token share the principal, so
draft-new → draft-patch in the same session is always the same user.

Enable `DEBUG=mcp cds watch` to get a one-line trace per draft operation
(`[draft-<op>] entity=<x> keys=<y> user=<z>`) for on-call diagnostics.

**Diagnosing `DRAFT_LOCKED` when the holder isn't you:**

1. The error message already names both identities: `(held by <holder>) (you are '<caller>')`.
   If those two ids differ, you know immediately that CAP's lock check is
   working correctly — the human you expected isn't the principal CAP resolved.
2. Call `cap_whoami` (always registered, no annotation needed) for a full
   principal snapshot: id, roles, tenant, `is_privileged`, `is_anonymous`, and
   a plain-English diagnosis line. This is the fastest way to confirm whether
   MCP is running as `anonymous`, `system`, or a different SSO account than
   the Fiori UI.
3. For continuous tracing during a repro, run the server with
   `DEBUG=mcp cds watch`. Every tool invocation writes one line:
   `[draft-<op>] caller id='…' privileged=… anonymous=… tenant='…' roles=[…]`,
   plus the per-operation `[draft-<op>] entity=… keys=… user=…` trace for
   full draft-path visibility.

#### Error-code reference

| Code                     | When it's raised                                                     | Next step                                                                 |
|--------------------------|----------------------------------------------------------------------|---------------------------------------------------------------------------|
| `DRAFT_REQUIRED`         | Active-row `create`/`update`/`delete` on a non-bypass draft root     | Switch to the `draft-*` tool named in the error message.                  |
| `DRAFT_LOCKED`           | Another user currently holds the draft                               | Retry as that user, wait for the lock to expire, or coordinate discard.   |
| `DRAFT_ALREADY_EXISTS`   | `draft-new` on a row that already has a draft sibling                | Use `draft-edit` / `draft-patch` on the existing draft.                   |
| `DRAFT_VALIDATION_FAILED`| `@assert.*` violation during `draft-new` / `draft-patch`             | Correct the field values and retry.                                       |
| `DRAFT_ACTIVATE_FAILED`  | `@mandatory` / `@assert.*` violation during `draft-activate`         | `draft-patch` the missing / invalid field, then activate again.           |
| `DRAFT_UPSERT_FAILED`    | NEW or SAVE failed inside `draft-upsert` (transaction rolled back)   | Fix the offending field named in the message and retry `draft-upsert`.    |
| `ASSERT_DATA_TYPE`       | Payload shape mismatches CSN (e.g. missing composite-FK column)      | Check every generated FK column and structured element is supplied.       |

See the [CAP Fiori draft handling docs](https://cap.cloud.sap/docs/advanced/fiori#draft-support) for concept background.

### Tools (`@mcp.tool`)

CDS operations annotated with `@mcp.tool: true` become MCP tools. Both **unbound** (service-level) and **bound** (entity-level) operations are supported, and the distinction between `action` and `function` is preserved — either kind can be exposed. Parameter schemas are derived automatically from the CDS signature; input/output types (scalars, structured types, `array of ...`) flow through unchanged, and `@mcp.hint` on parameters enriches the schema shown to the LLM.

```cds
// Service-level (unbound) function
@mcp: {
  name       : 'get-author',
  description: 'Gets the desired author',
  tool       : true
}
function getAuthor(input: String) returns String;

// Service-level (unbound) action with a structured return type
@mcp: {
  name       : 'submit-order',
  description: 'Submits a new order',
  tool       : true
}
action submitOrder(cart: ManyCartItems) returns Order;

// Entity-level (bound) function — invoked against a specific Books row
extend projection Books with actions {
  @mcp: {
    name       : 'get-stock',
    description: 'Retrieves stock from a given book',
    tool       : true
  }
  function getStock() returns Integer;

  // Entity-level (bound) action
  @mcp: {
    name       : 'reorder',
    description: 'Triggers a reorder for the given book',
    tool       : true
  }
  action reorder(quantity: Integer) returns Boolean;
}
```

Bound operations automatically receive the entity's key(s) as additional tool parameters so the caller can target a specific row. The plugin picks them up regardless of whether the parent entity itself carries `@mcp` annotations — a bound tool on an un-annotated entity is still registered.

Tools can request user interaction before execution via `elicit`:

```cds
@mcp: {
  name       : 'book-recommendation',
  description: 'Get a random book recommendation',
  tool       : true,
  elicit     : ['confirm']            // yes/no prompt
}
function getBookRecommendation() returns String;

@mcp: {
  name       : 'get-author',
  description: 'Gets the desired author',
  tool       : true,
  elicit     : ['input']              // parameter form
}
function getAuthor(id: String) returns String;

@mcp: {
  name       : 'books-by-author',
  description: 'Gets a list of books made by the author',
  tool       : true,
  elicit     : ['input', 'confirm']   // form + confirmation
}
function getBooksByAuthor(authorName: String) returns array of String;
```

Elicitation is only available for direct tools; entity-wrapper tools do not support it.

### Field hints (`@mcp.hint`)

Attach descriptions to entity properties, action parameters, and complex-type fields to improve the schema seen by the LLM:

```cds
entity Books {
  key ID    : Integer @mcp.hint: 'Must be a unique number not already in the system';
      title : String;
      stock : Integer @mcp.hint: 'The amount of books currently on store shelves';
}

@mcp: {
  name: 'books-by-author', description: '...', tool: true
}
function getBooksByAuthor(
  authorName : String @mcp.hint: 'Full name of the author you want to get the books of'
) returns array of String;
```

Hints flow into:

- Resource field descriptions
- Parameter schemas of direct tools and entity wrappers
- Array element descriptions (applied to items, not the array)

Good hints are specific: state constraints, formats, and business meaning rather than restating the field name.

### Omitting fields (`@mcp.omit`)

```cds
entity Books {
  key ID            : Integer;
      title         : String;
      stock         : Integer;
      secretMessage : String  @mcp.omit;   // hidden from MCP output
}
```

`@mcp.omit` filters MCP output only. Omitted fields can still be supplied as inputs on create / update operations and remain queryable in the underlying CAP service. Combine with `@Core.Computed` to make a field neither output nor writable.

### Expand & deep reads (`@mcp.expand`)

Query and get tools accept an OData v4 `$expand` parameter with subquery options (`$select`, `$filter`, `$top`, `$skip`, `$orderby`, nested `$expand`). Without an explicit `expand`, every Composition on the entity is included automatically, so the LLM sees "parts of me" in one call instead of a scalar-plus-FK skeleton.

```jsonc
// tools/call arguments for <Service>_<Entity>_query and _get
{
  "expand": "address,identifiers($top=5;$filter=scheme eq 'GLN')"
}
```

- Pass `""` (empty string) to opt out at call time — the response drops back to scalars + foreign keys only.
- Pass a full OData `$expand` string to override what is returned. The parser is schema-aware: it rejects unknown navigation properties and `$select` columns that don't exist on the target.
- Only **Compositions** are auto-included. **Associations** stay opt-in — they frequently lead to very large graphs and shouldn't be pulled implicitly.

Per-entity override with `@mcp.expand` (accepted values: `'compositions'`, `'none'`, `'all'`):

```cds
// Large entity that you do NOT want auto-expanded
annotate AdminService.Orders with @mcp.expand: 'none';

// Entity where you want associations included too
annotate AdminService.PartnerProfiles with @mcp.expand: 'all';
```

Runtime-wide configuration (also settable via `CDS_MCP_EXPAND_MAX_DEPTH` / `CDS_MCP_EXPAND_MAX_BREADTH` env vars):

```json
{
  "cds": {
    "mcp": {
      "expand": {
        "default": "compositions",
        "max_depth": 3,
        "max_breadth": 20
      }
    }
  }
}
```

`max_depth` caps how deeply nested `$expand` can go (e.g. `nav($expand=child($expand=grandchild))` is depth 3). `max_breadth` caps how many sibling nav props may appear at any one level. Both are validated during parse, so an over-broad request fails before any SQL is generated.

### Prompt templates (`@mcp.prompts`)

```cds
annotate CatalogService with @mcp.prompts: [{
  name       : 'give-me-book-abstract',
  title      : 'Book Abstract',
  description: 'Gives an abstract of a book based on the title',
  template   : 'Search the internet and give me an abstract of the book {{book-id}}',
  role       : 'user',
  inputs     : [{ key: 'book-id', type: 'String' }]
}];
```

## Configuration reference

```json
{
  "cds": {
    "mcp": {
      "name": "my-mcp-server",
      "version": "1.0.0",
      "auth": "inherit",
      "instructions": "MCP server instructions for agents",
      "capabilities": {
        "resources": { "listChanged": true, "subscribe": false },
        "tools":     { "listChanged": true },
        "prompts":   { "listChanged": true }
      }
    }
  }
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | package.json `name` | MCP server name |
| `version` | string | package.json `version` | MCP server version |
| `auth` | `"inherit"` \| `"none"` | `"inherit"` | Authentication mode |
| `instructions` | string | `null` | Server-level instructions surfaced to agents |
| `public_url` | string | derived | Canonical external base URL advertised in OAuth metadata. Set when running behind an approuter on a different FQDN. |
| `base_path` | string | `"/mcp"` | Mount path exposed to MCP clients; used as `resource` in `oauth-protected-resource` metadata. |
| `trusted_proxies` | boolean | `false` | Honor `X-Forwarded-Host/Proto/Prefix` when building absolute URLs. Enable when fronted by an approuter. |
| `oauth.proxy` | `"enabled"` \| `"disabled"` | `"enabled"` | Expose `/oauth/*` and `/.well-known/oauth-authorization-server` on the CAP backend. Disable when an upstream approuter handles OAuth. |
| `oauth.protected_resource` | `"enabled"` \| `"disabled"` | `"enabled"` | Register the RFC 9728 `/.well-known/oauth-protected-resource` metadata endpoint. |
| `session_store.kind` | `"db"` \| `"memory"` \| `"stateless"` | `"db"` when a DB binding exists, else `"memory"` | Where MCP session state lives. `"db"` persists session IDs in a CAP entity; `"stateless"` issues no session IDs and handles every POST with a fresh transport (multi-instance safe, zero persistence); `"memory"` uses a per-process Map. See [Session store](#session-store). |
| `session_store.entity` | string | `"cap.mcp.Sessions"` | CSN entity injected programmatically for `"db"` kind. Override only on name clashes. |
| `session_store.local_cache_ttl_ms` | number | `600000` | How long a rehydrated transport is kept in the per-instance cache before it is dropped and re-fetched from the DB on the next request. |
| `capabilities.resources.listChanged` | boolean | `true` | Resource list-change notifications |
| `capabilities.resources.subscribe` | boolean | `false` | Resource subscriptions |
| `capabilities.tools.listChanged` | boolean | `true` | Tool list-change notifications |
| `capabilities.prompts.listChanged` | boolean | `true` | Prompt list-change notifications |

## Session store

MCP is session-oriented: the client sends `initialize`, receives an `Mcp-Session-Id`, then sends every subsequent request with that header. Deployments with multiple app instances behind a round-robin load balancer need the session to be visible from every instance (`initialize` lands on instance A, a later `tools/call` lands on instance B → otherwise `Invalid session ID`).

The plugin persists sessions in a CAP entity by default. When a DB binding is configured, `session_store.kind` resolves to `"db"` automatically — no extra flag needed. The injected `cap.mcp.Sessions` entity is created by your app's normal `cds deploy`.

Requirements for the DB-backed store:

- A database binding (`cds.env.requires.db`) — sqlite, HANA, Postgres, etc.
- `cds deploy` (or your app's deploy step) is run so the injected `cap.mcp.Sessions` table is created. The entity is added programmatically on `cds.on('loaded')`; no `.cds` file changes needed.
- `MCP_ENABLE_JSON=true` (the default). DB-backed sessions rely on JSON-response mode because SSE streams cannot be handed off between instances.

Behavior:

- A fresh `initialize` inserts a row with the generated session ID.
- Subsequent requests routed to an instance that hasn't seen the session rehydrate a transport locally (cheap; transport state is purely in-memory) and update `last_access` in the DB.
- A global reaper on every instance deletes rows older than `CDS_MCP_SESSION_TTL_MS` (default 30 minutes).
- `DELETE /mcp` removes the row so no instance can rehydrate a torn-down session.

### Stateless mode (no DB, multi-instance safe)

When your MCP tools are pure CRUD/RPC and you don't need server-initiated notifications (`notifications/tools/list_changed`, subscriptions, progress updates, etc.), set `session_store.kind = "stateless"`. The plugin then:

- Configures the SDK transport with `sessionIdGenerator: undefined` — no `Mcp-Session-Id` is issued or expected.
- Builds a fresh server+transport per POST, handles the request, and discards both.
- Returns 400 on `GET /mcp` (SSE streams) and `DELETE /mcp` (nothing to close).

This matches the "tool-server without subscriptions" pattern: requests are independent, horizontal scaling is trivial, blue/green deployments and restarts carry no session risk. Stateless needs no DB binding, so it's a good choice when you run multiple instances without wanting to take on a DB dependency.

```json
{
  "cds": {
    "mcp": {
      "session_store": { "kind": "stateless" }
    }
  }
}
```

### Opting out: in-memory store

Set `session_store.kind = "memory"` to keep sessions in a per-process Map. This is appropriate for single-instance deployments, local development, or any topology with sticky routing. When no DB binding exists and the kind is unspecified, the plugin falls back to `"memory"` automatically.

```json
{
  "cds": {
    "mcp": {
      "session_store": { "kind": "memory" }
    }
  }
}
```

Explicit `kind: "db"` without a DB binding is a configuration error and the plugin fails fast at startup. The same applies to `kind: "stateless"` with `MCP_ENABLE_JSON=false`, because SSE is incompatible with per-request transports.

## Authentication

### `inherit` (default)

Uses CAP's configured authentication — any of `mocked`, `basic`, `jwt`, `xsuaa`, or `ias`:

```json
{
  "cds": {
    "mcp":      { "auth": "inherit" },
    "requires": { "auth": { "kind": "xsuaa" } }
  }
}
```

Flow for OAuth-backed deployments (XSUAA, IAS):

1. Client connects to `/mcp` without a token.
2. Backend returns `401` with `WWW-Authenticate: Bearer resource_metadata=…`.
3. Client fetches `/.well-known/oauth-protected-resource`, then the advertised `oauth-authorization-server` metadata.
4. Client performs the OAuth authorization-code flow (DCR, authorize, token exchange). For IAS the plugin emulates DCR using the pre-bound `clientid` since IAS does not implement RFC 7591.
5. Client re-issues the MCP request with `Authorization: Bearer <token>`.

### `none`

Disables authentication. Use only in development:

```json
{ "cds": { "mcp": { "auth": "none" } } }
```

### Behind an approuter

See [docs/approuter-integration.md](./docs/approuter-integration.md) for the full deployment recipe, including managed approuter route declarations, XSUAA + IAS coexistence, and multi-tenancy notes. The approuter-side architecture is covered in [docs/approuter-architecture.md](./docs/approuter-architecture.md).

## Development and testing

- `npm test` — full Jest suite.
- `npm run test:unit` / `npm run test:integration` — scoped runs.
- `npm run test:coverage` — coverage report.
- `npm run mock` — start the demo CAP app in `test/demo/`.
- `npm run inspect` — launch the official [MCP Inspector](https://github.com/modelcontextprotocol/inspector) and connect it to `http://localhost:4004/mcp`.

The `bruno/` directory contains a [Bruno](https://www.usebruno.com/) collection with HTTP requests for the MCP endpoint for manual exploration.

Enable verbose logs:

```json
{ "cds": { "log": { "levels": { "mcp": "debug" } } } }
```

Further reading: [docs/entity-tools.md](./docs/entity-tools.md).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `cds serve` starts but `/mcp` 404s | Port conflict on 4004, or the plugin was not picked up — confirm `cap-mcp-plugin` is in `dependencies`. |
| `401` on every MCP call with `auth: "inherit"` | Upstream CAP auth is misconfigured or missing credentials. Check `cds.requires.auth`. |
| MCP client rejects auth server as "does not support dynamic client registration" (IAS) | `oauth.proxy` is `"disabled"` — the client is being pointed straight at IAS, which does not support DCR. Set `oauth.proxy: "enabled"` so the plugin emulates DCR. |
| Annotations ignored | Verify spelling and casing (`resource`, `tool`, `prompts`) and that the annotated service is loaded. |
| Dynamic query parameters must all be supplied | Known `@modelcontextprotocol/sdk` RFC template-string limitation; provide every declared parameter. |

## Limitations

- Dynamic resource queries must supply all declared query parameters (SDK limitation).
- Elicitation is supported for direct tools only, not entity wrappers.
- Each MCP client opens its own session; monitor memory when running many concurrent clients.

## Contributing

Issues and pull requests are welcome at [sleibach/cap-mcp-plugin](https://github.com/sleibach/cap-mcp-plugin).

## License

Apache-2.0. See [LICENSE.md](./LICENSE.md).
