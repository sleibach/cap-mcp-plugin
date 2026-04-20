# bookshop-xsuaa — MCP sample behind an approuter, with XSUAA

Scaffolded via `cds init bookshop-xsuaa --add nodejs,sample,xsuaa,hana,mta,approuter`.
Wired up to the sibling `@gavdi/cap-mcp` plugin with the approuter topology
described in [`../../docs/approuter-integration.md`](../../docs/approuter-integration.md).

## Layout

- `srv/cat-service.cds`  — standard bookshop CatalogService
- `srv/mcp-annotations.cds` — MCP resource + wrap + tool annotations on Books and `submitOrder`
- `app/router/xs-app.json` — approuter routes for `/mcp` and `/.well-known/oauth-protected-resource`
- `mta.yaml` — XSUAA, HANA, approuter modules
- `xs-security.json` — XSUAA scopes and role templates
- `pack-and-build.sh` — bundles the local plugin and produces an MTA archive

## Local run

```sh
# From repo root, after npm install --legacy-peer-deps:
cd test/bookshop-xsuaa
cds watch
```

MCP endpoint: `POST http://localhost:4004/mcp` (auth = `mocked` in dev, so any
user goes through). The plugin registers resources for `Books`,
`ListOfBooks`, and a tool for `submitOrder`.

## Deploy to Cloud Foundry

The dependency `"@gavdi/cap-mcp": "file:../.."` cannot be installed from inside
the MTA archive, so use the helper script to pack the plugin and bundle it:

```sh
./pack-and-build.sh      # produces gen/*.mtar
cf login ...
cf deploy gen/*.mtar
```

Once deployed, the approuter enforces XSUAA login for `/mcp` and forwards the
JWT to the CAP backend. MCP clients discover
`/.well-known/oauth-protected-resource` at the approuter URL; the plugin
advertises the XSUAA issuer as the `authorization_servers` entry because
`cds.mcp.oauth.proxy` is `"disabled"`.

## Configuration reference

See the parent plugin's `package.json` `cds.mcp` block. Defaults chosen here:

| Key | Value | Purpose |
|-----|-------|---------|
| `auth` | `inherit` | Reuse CAP's `auth.kind` (xsuaa in `[production]`) |
| `base_path` | `/mcp` | MCP mount path |
| `trusted_proxies` | `true` | Honor `X-Forwarded-*` from the approuter |
| `oauth.proxy` | `disabled` | Let the approuter own the OAuth flow |
| `oauth.protected_resource` | `enabled` | Emit RFC 9728 metadata |
