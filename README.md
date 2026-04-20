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
- Expose CDS functions and actions as MCP tools.
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

```bash
npm install cap-mcp-plugin
```

The plugin follows CAP's standard plugin architecture and is picked up automatically.

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

- `<Service>_<Entity>_query`
- `<Service>_<Entity>_get`
- `<Service>_<Entity>_create` (if enabled)
- `<Service>_<Entity>_update` (if enabled)

```cds
annotate CatalogService.Books with @mcp.wrap: {
  tools: true,
  modes: ['query', 'get', 'create', 'update'],
  hint : 'Use for read and write demo operations'
};
```

### Tools (`@mcp.tool`)

```cds
// Service-level function
@mcp: {
  name       : 'get-author',
  description: 'Gets the desired author',
  tool       : true
}
function getAuthor(input: String) returns String;

// Entity-level action
extend projection Books with actions {
  @mcp: {
    name       : 'get-stock',
    description: 'Retrieves stock from a given book',
    tool       : true
  }
  function getStock() returns Integer;
}
```

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
| `capabilities.resources.listChanged` | boolean | `true` | Resource list-change notifications |
| `capabilities.resources.subscribe` | boolean | `false` | Resource subscriptions |
| `capabilities.tools.listChanged` | boolean | `true` | Tool list-change notifications |
| `capabilities.prompts.listChanged` | boolean | `true` | Prompt list-change notifications |

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
