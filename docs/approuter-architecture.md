# SAP Application Router — Architecture & Behavior Reference

> Version analysed: `@sap/approuter` 20.10.0
> Project entry point: `app/router/` → `node node_modules/@sap/approuter/approuter.js`

---

## Table of Contents

0. [Two-Service Deployment Architecture — HTML5 Repo vs. Work Zone](#0-two-service-deployment-architecture--html5-repo-vs-work-zone)
1. [What the Application Router Does](#1-what-the-application-router-does)
2. [Project Configuration (`xs-app.json`)](#2-project-configuration-xs-appjson)
3. [How `/cp.portal` Is Served — The Welcome File Mechanism](#3-how-cpportal-is-served--the-welcome-file-mechanism)
4. [The Routing Engine](#4-the-routing-engine)
5. [Full Request Lifecycle](#5-full-request-lifecycle)
6. [Authentication & Token Handling](#6-authentication--token-handling)
7. [Session Management](#7-session-management)
8. [Destination Service Integration](#8-destination-service-integration)
9. [HTML5 Application Repository Integration](#9-html5-application-repository-integration)
10. [Business Services Integration](#10-business-services-integration)
11. [Static Content & Templating](#11-static-content--templating)
12. [Security Features](#12-security-features)
13. [Library Folder Structure](#13-library-folder-structure)
14. [Known Gotchas & Surprises](#14-known-gotchas--surprises)

---

## 0. Two-Service Deployment Architecture — HTML5 Repo vs. Work Zone

This is the most important architectural concept to understand when looking at the MTA deployment.

### The two services do completely different things

| Service | BTP offering | Plan | What it stores | Deployed by |
|---------|-------------|------|----------------|-------------|
| `eam-html5-repo-host` | `html5-apps-repo` | `app-host` | UI5 app bundles (JS/HTML/CSS zip files) | `eam-app-deployer` |
| `eam-workzone-standard` | `build-workzone-standard` | `standard` | Site configuration (CommonDataModel.json) | `eam-workzone-standard-deployer` |

They are decoupled by design. The HTML5 repo is a pure asset CDN. Work Zone is a portal/navigation engine.

### What the CommonDataModel.json actually is

`app/workzone/portal-site/CommonDataModel.json` is **not an app**. It is a **site descriptor** — a structured JSON document that tells Work Zone:

- Which **catalogs** exist and which app visualization IDs belong to them
- Which **groups** (tile sections on the home page) exist and which tiles appear in each group
- What the **site** looks like (theme, features like search/personalization/language switcher, group ordering)

It references apps by `appId` + `vizId` pairs (e.g. `"appId": "changerequests"`, `"vizId": "changerequests-display"`). These IDs are defined in each app's own `manifest.json` (`sap.app.id` and `sap.ui5.routing`). The CDM does not contain any app code — only pointers.

### Why Work Zone needs a separate deployer

Work Zone (`/cp.portal`) has its own content management API. To register a site configuration bundle, you must `POST` the CDM to Work Zone's **content endpoint** — a REST API exposed by the Work Zone service instance. The deployer module does exactly this using the service key created with `content-endpoint: developer`:

```yaml
- name: eam-workzone-standard
  parameters:
    content-target: true
    service-key:
      config:
        content-endpoint: developer   # ← use the developer content API
      name: eam-workzone-standard-key
```

The `content-endpoint: developer` config tells the MTA deployer to use Work Zone's developer/bundle upload API rather than the admin UI. This is the programmatic way third-party MTA applications register their content with Work Zone.

### Why the workzone deployer also requires `eam-html5-repo-host` and `eam-app-deployer`

When Work Zone receives the CDM, it validates that the referenced `appId`s actually exist — it resolves them against the HTML5 Application Repository. If you deploy the CDM before the app bundles are in the HTML5 repo, Work Zone cannot resolve the app IDs and the deployment fails. That's why:

```yaml
deployed-after:
  - eam-app-deployer   # ← wait until app bundles are in the HTML5 repo first
```

The `eam-html5-repo-host` service key is also required so Work Zone knows which HTML5 repo host the apps live in (the CDM bundle import process includes this as context).

### The complete picture at runtime

```
User opens browser
  └─ GET /  →  302 /cp.portal  (approuter welcomeFile redirect)

GET /cp.portal  →  approuter catch-all  →  html5-apps-repo-rt
  └─ html5-apps-repo-rt serves Work Zone shell (index.html)

Work Zone shell boots in browser
  └─ Fetches CommonDataModel from Work Zone service
      └─ CDM describes: 2 groups, 1 catalog, 8 app tiles

User sees Launchpad home page (tiles)

User clicks "Change Requests" tile
  └─ Work Zone resolves navigation target for vizId "changerequests-display"
  └─ Loads app bundle from html5-apps-repo-rt:  /changerequests/index.html
  └─ App boots, calls  /odata/...  →  approuter  →  srv-api (CAP backend)
```

### Summary: what each service owns

```
eam-html5-repo-host        eam-workzone-standard
─────────────────────      ──────────────────────────
changerequests.zip         CommonDataModel.json
delegations.zip              ├─ catalogs  (what apps exist)
inspectionplanformula.zip    ├─ groups    (how tiles are arranged)
taskqueue.zip                └─ sites     (shell config, theme)
/cp.portal shell (*)

(*) /cp.portal itself is served by Work Zone's internal HTML5 repo,
    not by eam-html5-repo-host. Work Zone bundles its own shell app.
```

The HTML5 repo is the **warehouse**. Work Zone is the **storefront** — it decides what to show, in what layout, and uses the warehouse to fetch the actual goods when needed.

---

### How our app knows to use OUR Work Zone instance (and not another app's)

This is the question that seems mysterious until you understand two linking mechanisms working together.

#### Link 1 — `sap.cloud.service: "cp"` in the Work Zone service binding credentials

When `eam-workzone-standard` is bound to `eam-approuter`, CF injects its credentials into `VCAP_SERVICES`. Those credentials contain:

```json
{
  "sap.cloud.service": "cp",
  "html5-apps-repo": {
    "app_host_id": "<guid-of-workzone-internal-html5-host>"
  }
}
```

The approuter's dynamic routing engine parses the URL `/cp.portal`:
- First path segment = `cp.portal`
- Dot notation → prefix `cp`, app name `portal`

It then looks up a bound service whose `sap.cloud.service` (or alias) equals `cp` in VCAP_SERVICES. It finds `eam-workzone-standard`.

It extracts the `html5-apps-repo.app_host_id` from those credentials and sets the `x-app-host-id` header on the request it sends to the HTML5 repo runtime:

```
GET /cp.portal → HTML5 repo runtime
  x-app-host-id: <workzone-internal-host-guid>
```

The HTML5 repo runtime serves **only** content from that specific app host bucket. If another app in the same space bound a different Work Zone instance, it would have a different `app_host_id` → completely isolated.

#### Link 2 — The workzone deployer registers the HTML5 repo host with Work Zone

This is why `eam-workzone-standard-deployer` requires `eam-html5-repo-host`:

```yaml
- name: eam-workzone-standard-deployer
  requires:
    - name: eam-workzone-standard   # ← push CDM to this WZ instance
      parameters:
        content-target: true
    - name: eam-html5-repo-host     # ← tell WZ where our app bundles live
```

When the MTA deployer pushes the CDM bundle to Work Zone's content API, it includes the `app_host_id` from `eam-html5-repo-host`. Work Zone stores this association:

> "The apps referenced in bundle `eam-flp` (changerequests, delegations, …) are stored in HTML5 host `<eam-html5-repo-host-guid>`"

This is how Work Zone knows — when the launchpad shell resolves a navigation target for `appId: "changerequests"` — to fetch the app's manifest and bundle from the correct HTML5 repo host, not from a random other app's host.

This also explains the `deployed-after: eam-app-deployer` constraint: the apps must already be uploaded before the CDM is registered, so Work Zone can immediately validate that the referenced `appId`s actually exist in the stated host.

#### What about two apps in the same space / subaccount?

Work Zone Standard Edition is typically a **subaccount-level singleton** — one launchpad for the entire subaccount. Multiple apps may all deploy their CDM bundles to the SAME Work Zone instance.

In that case:
- Each CDM bundle has a **unique bundle ID** (`"id": "eam-flp"` for us) — Work Zone tracks content per bundle
- Work Zone **merges all bundles** into a single unified launchpad — tiles from all apps appear together
- Each bundle is independently updatable/removable without touching others
- Bundles are linked to their own HTML5 repo host (Link 2 above) — so even if two apps share one Work Zone instance, Work Zone fetches each app's bundles from the correct, isolated HTML5 repo host

This design is intentional: Work Zone Standard is meant to be the single unified company launchpad. Different applications contribute their tiles to it, rather than each maintaining a separate launchpad.

---

## 1. What the Application Router Does

The Application Router (`approuter`) is a **Node.js reverse proxy** that sits between the browser and all backend services in a SAP BTP application. It handles:

- **Authentication** — OIDC/OAuth2 login via XSUAA or IAS, JWT lifecycle management
- **Authorization** — Scope-based access control per route
- **Session management** — Server-side sessions so JWTs never reach the browser
- **Reverse proxying** — Routes to destinations, business services, and the HTML5 Application Repository
- **CSRF protection** — Per-session token validated on mutating requests
- **Multitenancy** — Tenant-aware configuration, token exchange, and service routing

The approuter is the **only entry point** into the application from the internet. Nothing is accessible unless a route explicitly permits it.

---

## 2. Project Configuration (`xs-app.json`)

**File:** `app/router/xs-app.json`

```json
{
  "welcomeFile": "/cp.portal",
  "routes": [
    {
      "source": "^/?odata/(.*)$",
      "target": "/odata/$1",
      "destination": "srv-api",
      "authenticationType": "xsuaa",
      "csrfProtection": true
    },
    {
      "source": "^/?service/(.*)$",
      "target": "/service/$1",
      "destination": "srv-api",
      "authenticationType": "xsuaa",
      "csrfProtection": true
    },
    {
      "source": "^/?ws/(.*)$",
      "target": "/ws/$1",
      "destination": "srv-api"
    },
    {
      "source": "^/user-api(.*)",
      "target": "$1",
      "service": "sap-approuter-userapi"
    },
    {
      "source": "^(.*)$",
      "service": "html5-apps-repo-rt",
      "authenticationType": "xsuaa",
      "target": "$1"
    },
    {
      "source": "^/adobe_authorize$",
      "target": "/srv/adobe_authorize",
      "destination": "srv-api",
      "authenticationType": "none",
      "csrfProtection": false
    }
  ]
}
```

### Route breakdown

| Route | Destination | Auth | Purpose |
|-------|------------|------|---------|
| `^/?odata/(.*)$` | `srv-api` destination | XSUAA + CSRF | CAP OData endpoints |
| `^/?service/(.*)$` | `srv-api` destination | XSUAA + CSRF | Custom CAP service endpoints |
| `^/?ws/(.*)$` | `srv-api` destination | none | WebSocket connections |
| `^/user-api(.*)` | built-in `sap-approuter-userapi` | inherited | User info API |
| `^(.*)$` | `html5-apps-repo-rt` service | XSUAA | Catch-all: UI5 apps, `/cp.portal` |
| `^/adobe_authorize$` | `srv-api` destination | none | Adobe Sign OAuth callback |

### ⚠️ Route ordering bug

The `adobe_authorize` route is defined **after** the catch-all `^(.*)$`. Because routes are matched in order (first match wins), `^(.*)$` will always match `/adobe_authorize` first and forward it to the HTML5 repo — the intended `srv-api` route is **unreachable**. This route must be moved before the catch-all.

---

## 3. How `/cp.portal` Is Served — The Welcome File Mechanism

### Step 1 — `welcomeFile` redirect

**Handler:** `lib/middleware/welcome-page-middleware.js`

When a request arrives with path `/` (or `/?...` query string), the approuter checks whether `welcomeFile` is set in the configuration. If it is, it responds with an **HTTP 302 redirect** to that path — in this project to `/cp.portal`.

Special cases handled in the redirect:
- `sap_idp` query parameter is preserved (dynamic identity provider selection)
- `x-forwarded-path` header is respected when behind an outer reverse proxy
- If the request contains `x-csrf-token: fetch`, no redirect is issued — the welcome page is served inline so the browser can collect a CSRF token via AJAX

### Step 2 — `/cp.portal` is NOT a built-in route

`/cp.portal` has no special meaning inside the approuter itself. After the redirect, the browser requests `/cp.portal`, which is simply processed through the normal route matching. In this project it falls through to the catch-all:

```json
{
  "source": "^(.*)$",
  "service": "html5-apps-repo-rt",
  "authenticationType": "xsuaa",
  "target": "$1"
}
```

### Step 3 — HTML5 Application Repository serves the Launchpad

The request is forwarded to the **HTML5 Application Repository runtime service** (`html5-apps-repo-rt`). This service is where SAP Work Zone / Launchpad Service stores and serves portal UIs.

`/cp.portal` is a **SAP standard portal application name** hosted in the HTML5 repo. It is the entry-point application of **SAP Work Zone Standard Edition** (formerly SAP Cloud Portal Service). When the approuter forwards the request to the HTML5 repo, the repo returns the Launchpad shell HTML, which in turn bootstraps the tile-based homepage.

**Complete flow:**

```
Browser GET /
  → 302 to /cp.portal         (welcomeFile redirect)
  → Browser GET /cp.portal
  → approuter: matches catch-all route
  → approuter exchanges XSUAA code/session → JWT
  → approuter forwards GET /cp.portal to html5-apps-repo-rt
  → HTML5 repo returns Launchpad shell (index.html)
  → Browser renders Work Zone Launchpad
```

### Why is it called `/cp.portal`?

The name is a legacy convention from SAP Cloud Portal Service: `cp` = Cloud Portal. Work Zone Standard Edition preserved the path for backwards compatibility with existing routing configurations.

---

## 4. The Routing Engine

### Route matching

Routes are compiled to RegExp at startup and tested against the request URL path in order. The **first match wins** — no fallthrough. Properties:

| Property | Type | Description |
|----------|------|-------------|
| `source` | RegExp string | Matched against URL path |
| `target` | string | Path rewrite rule; uses `$1`…`$N` for capture groups |
| `destination` | string | Named destination (in VCAP_SERVICES or Destination Service) |
| `service` | string | BTP service binding tag (e.g. `html5-apps-repo-rt`) |
| `localDir` | string | Serve static files from this directory on disk |
| `authenticationType` | `xsuaa` \| `ias` \| `basic` \| `none` | Auth requirement for this route |
| `scope` | string \| string[] | XSUAA scopes required to access the route |
| `csrfProtection` | boolean | Validate CSRF token on mutating requests (default `true`) |
| `httpMethods` | string[] | Restrict to specific verbs (default: all) |
| `replace` | object | Mustache template replacement config |
| `cacheControl` | string | Override `Cache-Control` header in response |

### Path rewriting

The `target` string is applied after capturing groups from `source`:

```
source: "^/?odata/(.*)$"   → URL: /odata/ChangeRequests
target: "/odata/$1"         → backend path: /odata/ChangeRequests
```

For dynamic destinations (`destination: "$1"`) the captured group becomes the destination name itself — used for tenant-specific routing.

### Dispatch after route match

Once a route is matched, the request is dispatched to one of three backends:

1. **`destination`** — HTTP proxy to a named backend URL; JWT added to Authorization header
2. **`service`** — Bound BTP service endpoint; credentials resolved from VCAP_SERVICES
3. **`localDir`** — Static file serving from disk with optional Mustache templating

---

## 5. Full Request Lifecycle

The approuter implements a Connect-compatible middleware stack initialised in `lib/bootstrap.js`. All requests pass through this pipeline:

```
 1. SAP Statistics / Logging        trace correlation IDs, latency markers
 2. Extension hooks (first)         custom pre-processing (extensibility API)
 3. Attach router config            per-tenant xs-app.json selection
 4. Zone info                       tenant/subdomain context
 5. Subscription middleware         multi-tenant subscription check
 6. CORS                            Cross-Origin Resource Sharing headers
 7. Session                         express-session; in-memory or Redis
 8. Passport initialize             authentication framework setup
 9. Welcome page                    redirect / to welcomeFile if configured
10. Path rewriting                  match route, rewrite URL, attach route metadata
11. Login middleware                redirect to IdP if no valid session
12. Login callback                  exchange OAuth code for JWT, persist to session
13. Logout                          central logout, backend logout coordination
14. JWT refresh                     proactively refresh expiring tokens
15. Authorization                   validate scopes from JWT against route requirements
16. CSRF token                      generate/validate CSRF token
17. Service token                   obtain client-credentials token for business services
18. Destination token               obtain token for destination-secured backends
19. Route response headers          apply route-level response header overrides
20. Static resource handler         serve localDir files with Mustache rendering
21. Backend request handler         proxy request to destination/service, pipe response
22. Extension hooks (last)          custom post-processing
23. Error handler                   catch-all; maps errors to HTTP status codes
```

---

## 6. Authentication & Token Handling

### Login flow (XSUAA, OAuth2 authorization code)

1. User hits a protected route without a valid session
2. Approuter redirects to XSUAA `/oauth/authorize?...` with `redirect_uri=/login/callback`
3. XSUAA authenticates the user (form login or SSO) and redirects back
4. Approuter's `/login/callback` exchanges the authorization code for a JWT access token
5. JWT is stored in the **server-side session** — never sent to the browser
6. Session cookie (`JSESSIONID` by default) is set on the response

### Token propagation to backends

The approuter injects tokens into outgoing backend requests based on route configuration:

- `destination` routes — the user's JWT (or an exchanged token) is sent as `Authorization: Bearer <token>`
- `forwardAuthToken: true` — explicitly forward the raw user JWT
- Business services — token is exchanged via XSUAA on-behalf-of grant

### JWT refresh

Before a JWT expires the approuter automatically refreshes it using the refresh token stored in the session. Refresh happens `JWT_REFRESH` milliseconds before expiration (default: 5 minutes). The session's active token is silently swapped; the browser sees nothing.

### Service-to-approuter token forwarding

Backend services can send a JWT via the `x-approuter-authorization` header instead of using a session cookie. The approuter validates and uses it for the request. Useful for mobile apps and machine-to-machine flows that cannot maintain cookies.

### IAS (Identity Authentication Service)

IAS is an alternative to XSUAA. The approuter supports OIDC-based login via IAS and the two can be used together. The `sap_idp` query parameter selects the identity provider dynamically at login time.

---

## 7. Session Management

### Default (in-memory)

Sessions are stored in the approuter process memory using `express-session`. Each session contains:

| Key | Content |
|-----|---------|
| JWT access token | Never exposed to client |
| Refresh token | Used for silent JWT refresh |
| XSUAA scopes | Cached to avoid JWT parse on every request |
| CSRF token | Per-session secret |
| Backend cookies | Session cookies from backends (intercepted, not forwarded to browser) |
| Business service tokens | Cached client-credential / on-behalf-of tokens |
| Custom user attributes | From IdP |

Timeout: 15 minutes of inactivity (configurable via `SESSION_TIMEOUT` env var).

### External session store (Redis)

For multi-instance deployments, session data can be stored in Redis to allow any instance to serve any user:

```json
// EXT_SESSION_MGT environment variable (stringified JSON)
{
  "instanceName": "my-redis",
  "storageType": "redis",
  "sessionSecret": "secret"
}
```

Sessions are compressed before storage (~50 KB each). Supports secret rotation via `EXT_SESSION_MGT_BACKUP`.

### Session stickiness

In Cloud Foundry, the `VCAP_ID` header from CF's GoRouter is used for session affinity — requests from the same user tend to reach the same approuter instance. When sticky routing is unavailable the Redis store ensures correctness.

---

## 8. Destination Service Integration

### Destination resolution order

1. `destinations` property in xs-app.json (static, local override)
2. `destinations` environment variable (JSON array)
3. SAP Destination Service (fetched at runtime from BTP)
4. Destinations provided by the HTML5 Application Repository

### Destination properties used by approuter

| Property | Description |
|----------|-------------|
| `url` | Base URL of the backend |
| `forwardAuthToken` | Add user JWT to request |
| `timeout` | Request timeout in ms (default 30 000) |
| `proxyType` | `OnPremise` triggers Connectivity Service routing |
| `setXForwardedHeaders` | Add `X-Forwarded-Host/Path/Proto` |
| `strictSSL` | TLS certificate validation (default `true`) |
| `logoutPath` / `logoutMethod` | Called during central logout with user's JWT |

### Dynamic destinations

Setting `destination: "*"` or `destination: "$1"` resolves the destination name at request time — from the hostname or a capture group. This is the pattern used for tenant-specific subdomain routing.

### On-Premise connectivity

When `proxyType: OnPremise` is set, traffic is tunnelled through the **SAP Connectivity Service** and Cloud Connector — no direct network path to the on-premise system is needed from the approuter.

---

## 9. HTML5 Application Repository Integration

### How it works

The HTML5 Application Repository is a BTP service that stores versioned UI5 application bundles. At runtime:

1. The approuter receives a request matching a route with `service: "html5-apps-repo-rt"`
2. It fetches the target app's own `xs-app.json` from the HTML5 repo
3. The app-level `xs-app.json` is evaluated for a second round of route matching within the app
4. The matched static asset is fetched from the repo and streamed back to the browser

### Application discovery & caching

The approuter queries the HTML5 repo for the list of available apps. Results are cached with a TTL controlled by the `HTML5_APPS_CACHE` environment variable (default: 300 seconds). In multi-tenant scenarios, the cache is keyed per tenant + SAP Cloud Service.

**Implication:** After deploying a new app version, users may see the old version for up to 5 minutes unless the cache is explicitly invalidated.

### Cache buster

URLs containing a `~<timestamp>~` segment (e.g. `/myapp~1712345678~/index.js`) trigger indefinite caching of static assets:

- The `~timestamp~` segment is stripped before forwarding to the HTML5 repo
- Response gets `Cache-Control: public, max-age=31536000`
- On each new deployment the MTA build tool generates a new timestamp → new URLs → fresh browser cache

### How `/cp.portal` fits

`/cp.portal` is the HTML5 app name of the Work Zone Launchpad shell. It is stored in the HTML5 Application Repository (or an internal SAP service that exposes itself via the same interface). The approuter's catch-all route forwards the request to the HTML5 repo, which looks up the `/cp.portal` app and returns it.

---

## 10. Business Services Integration

### Service binding

Business services (e.g. a CAP service bound to the approuter) are bound via `VCAP_SERVICES`. Their credentials include:

| Field | Description |
|-------|-------------|
| `sap.cloud.service` | Unique service identifier |
| `sap.cloud.service.alias` | Short URL prefix |
| `endpoints` | Named OData/REST endpoint URLs |
| `grant_type` | `user_token` (on-behalf-of) or `client_credentials` |
| `html5-apps-repo` | Host GUIDs for service-owned UI apps |

### Token exchange for business services

- **`user_token`** — approuter exchanges the user's JWT for a service-specific token (OAuth2 on-behalf-of / JWT bearer grant). The backend can identify the original user.
- **`client_credentials`** — approuter requests a service token with its own client credentials. The backend sees the approuter's identity, not the user's.

Exchanged tokens are cached in the session to avoid repeated XSUAA round-trips.

### Business service UI access

Business service UIs must be marked `"sap.app": { "dataSources": { ... } }` as public in `manifest.json`. They are accessed via URL prefix: `/<sap.cloud.service.alias>.<appname>/`. The approuter resolves the app host GUIDs from the service credentials and routes accordingly.

---

## 11. Static Content & Templating

Routes with `localDir` serve files directly from disk using `serve-static`. Optionally, files can be processed with Mustache templating:

```json
{
  "source": "^/web-pages/(.*)$",
  "localDir": "static-content",
  "replace": {
    "pathSuffixes": [".html", ".js"],
    "vars": ["API_URL"],
    "services": { "uaa": { "tag": "xsuaa" } }
  }
}
```

- `vars` — inject environment variable values as `{{API_URL}}`
- `services` — inject VCAP_SERVICES credential fields as `{{{uaa.url}}}`

**Security note:** Path traversal is blocked — the resolved file path is checked against `fs.realpath()` to ensure it stays within `localDir`.

---

## 12. Security Features

| Feature | Mechanism |
|---------|-----------|
| JWT never reaches browser | Stored server-side in session |
| CSRF protection | Per-session token; validated on POST/PUT/DELETE/PATCH |
| Scope authorization | JWT scopes checked against route `scope` config |
| Path traversal protection | `fs.realpath()` validation before serving static files |
| Clickjacking | Default `X-Frame-Options: SAMEORIGIN` |
| Secure cookies | `Secure` + `HttpOnly` flags; configurable `SameSite` |
| Backend cookie interception | Cookies from backends stored in session, not forwarded to browser |
| Allowlist service | `/whitelist/endpoint` prevents hostname spoofing in CORS |
| TLS | All backend calls default to strict TLS validation |
| Audit logging | Integrates with SAP Audit Logging service |
| ReDoS protection | Route source patterns are checked for catastrophic backtracking at startup |

---

## 13. Library Folder Structure

```
node_modules/@sap/approuter/
├── approuter.js                 Entry point; exposes Approuter class (EventEmitter)
├── lib/
│   ├── bootstrap.js             Builds and wires the middleware stack
│   ├── middleware/              46 middleware files (see below)
│   ├── configuration/           xs-app.json loading, validation, JSON schema
│   ├── backend-request/         HTTP agents, headers, options, CSRF
│   ├── backend-response/        Cookie jar handling
│   ├── passport/                XSUAA and IAS Passport.js strategies
│   ├── websockets/              WebSocket proxy support
│   ├── extensions/              Public extensibility API
│   ├── utils/                   37 utility modules (destinations, tokens, HTML5 repo, …)
│   └── connect/                 Minimal Express-compatible wrapper
└── schemas/                     JSON schemas for xs-app.json validation
```

### Key middleware files

| File | Responsibility |
|------|---------------|
| `welcome-page-middleware.js` | Redirect `/` to `welcomeFile` |
| `path-rewriting-middleware.js` | Route matching and URL rewriting |
| `login-middleware.js` | Detect unauthenticated sessions, trigger IdP redirect |
| `login-callback-middleware.js` | OAuth2 code → JWT exchange |
| `jwt-refresh-middleware.js` | Proactive token refresh |
| `authorization-middleware.js` | Scope validation |
| `xsrf-token-middleware.js` | CSRF token generation and validation |
| `service-token-middleware.js` | Client-credentials token for business services |
| `destination-token-middleware.js` | Token exchange for destination-secured backends |
| `static-resource-handler.js` | `localDir` serving with Mustache templating |
| `request-handler.js` | Core HTTP proxy: forward request, pipe response |
| `error-handler.js` | Catch-all error → HTTP status mapping |
| `cors-middleware.js` | CORS headers |
| `session-cookie-middleware.js` | Session cookie attributes |
| `circuit-breaker-middleware.js` | Fault tolerance for backend calls |

---

## 14. Known Gotchas & Surprises

### Route order is critical — first match wins

There is no fallthrough. A catch-all `^(.*)$` route must always be the last route. Any route placed after it is unreachable.

**This project has this bug for the `adobe_authorize` route** — see Section 2.

### Welcome file redirect always issues a 302

Even if the `welcomeFile` path itself resolves to a destination, the browser will receive a 302 first. This means two round-trips on the first visit. There is no option to serve inline.

### HTML5 app cache is invisible to you

If you deploy a new UI5 app version and users complain they still see the old version, the HTML5 app cache in the approuter (TTL: 5 min default) is the likely culprit. There is no admin endpoint to flush it; you either wait it out or restart the approuter instance.

### Backend session cookies are silently swallowed

If your CAP backend sets a `Set-Cookie` header, the approuter intercepts it and stores the cookie in the server-side session. The browser never receives it. This prevents cookie namespace collisions but can be confusing when debugging backend session state.

### CSRF `fetch` bypasses the welcome redirect

A request to `/` with `x-csrf-token: fetch` header is served inline (not redirected). This is intentional — UI5 apps need to fetch a CSRF token from the app root before submitting mutations.

### `forwardAuthToken` is route-level, not global

You must explicitly set `"forwardAuthToken": true` on a destination definition or route for the user's JWT to be forwarded. Forgetting it means the backend receives no Authorization header and requests arrive as unauthenticated.

### `$XSAPPNAME` in scope strings is replaced at startup

Route `scope` values like `"$XSAPPNAME.Approve"` are expanded to the real XSUAA `xsappname` value at configuration load time. If the XSUAA binding changes, the approuter must be restarted.

### No direct socket access to the approuter

WebSocket connections (`ws://`) are proxied but require a dedicated route without `authenticationType: xsuaa` (the WebSocket handshake cannot carry a session cookie the same way). In this project the `ws/` route has no authenticationType — the backend must handle its own upgrade security.

### External session management is opt-in and serialization is opaque

Without Redis, a second approuter instance cannot serve requests for sessions created by the first instance. In a scaled-out CF deployment this means sticky routing is mandatory, or you must configure external session management.

### IAS and XSUAA can coexist

A single approuter can authenticate via both XSUAA and IAS depending on the route. The `sap_idp` query parameter at login time controls which IdP is used, and the approuter stores the IdP choice in the session.

---

*Generated from analysis of `@sap/approuter` 20.10.0 and `app/router/xs-app.json` in this project.*
