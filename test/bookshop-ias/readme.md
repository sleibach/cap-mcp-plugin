# bookshop-ias — MCP sample behind an approuter, with IAS

Scaffolded via `cds init bookshop-ias --add nodejs,sample,ias,hana,mta,approuter`.
Wired up to the sibling `cap-mcp-plugin` package with the approuter topology
described in [`../../docs/approuter-integration.md`](../../docs/approuter-integration.md).

The MTA uses `credential-type: X509_GENERATED` (mTLS) between the approuter
and the CAP backend, and enables `xsuaa-cross-consumption: true` on the IAS
instance so XSUAA tokens are accepted as well (exercised by the plugin's
IAS validation path).

## Layout

- `srv/cat-service.cds`  — standard bookshop CatalogService
- `srv/mcp-annotations.cds` — MCP resource + wrap + tool annotations on Books and `submitOrder`
- `app/router/xs-app.json` — approuter routes for `/mcp` and `/.well-known/oauth-protected-resource`
- `mta.yaml` — IAS, HANA, approuter modules (mTLS between approuter and srv)
- `pack-and-build.sh` — bundles the local plugin and produces an MTA archive

## Local run

```sh
# From repo root, after npm install --legacy-peer-deps:
cd test/bookshop-ias
cds watch
```

MCP endpoint: `POST http://localhost:4004/mcp` (auth = `mocked` in dev, so any
user goes through).

## Deploy to Cloud Foundry

```sh
./pack-and-build.sh      # produces gen/*.mtar
cf login ...
cf deploy gen/*.mtar
```

The approuter enforces IAS login for `/mcp` and forwards the JWT. MCP clients
discover `/.well-known/oauth-protected-resource` on the approuter; the plugin
advertises the IAS issuer as the `authorization_servers` entry because
`cds.mcp.oauth.proxy` is `"disabled"`.

## Configuration reference

| Key | Value | Purpose |
|-----|-------|---------|
| `auth` | `inherit` | Reuse CAP's `auth.kind` (ias in `[production]`) |
| `base_path` | `/mcp` | MCP mount path |
| `trusted_proxies` | `true` | Honor `X-Forwarded-*` from the approuter |
| `oauth.proxy` | `disabled` | Let the approuter own the OAuth flow |
| `oauth.protected_resource` | `enabled` | Emit RFC 9728 metadata |
