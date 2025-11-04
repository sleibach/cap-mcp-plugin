"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAuthEnabled = isAuthEnabled;
exports.getAccessRights = getAccessRights;
exports.registerAuthMiddleware = registerAuthMiddleware;
exports.hasToolOperationAccess = hasToolOperationAccess;
exports.getWrapAccesses = getWrapAccesses;
exports.useMockAuth = useMockAuth;
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const factory_1 = require("./factory");
const xsuaa_service_1 = require("./xsuaa-service");
const ias_service_1 = require("./ias-service");
const handlers_1 = require("./handlers");
const logger_1 = require("../logger");
/**
 * @fileoverview Authentication utilities for MCP-CAP integration.
 *
 * This module provides utilities for integrating CAP authentication with MCP servers.
 * It supports all standard CAP authentication types and provides functions for:
 * - Determining authentication status
 * - Managing user access rights
 * - Registering authentication middleware
 *
 * Supported CAP authentication types:
 * - 'dummy': No authentication (privileged access)
 * - 'mocked': Mock users with predefined credentials
 * - 'basic': HTTP Basic Authentication
 * - 'jwt': Generic JWT token validation
 * - 'xsuaa': SAP BTP XSUAA OAuth2/JWT authentication
 * - 'ias': SAP Identity Authentication Service
 * - Custom string types for user-defined authentication strategies
 *
 * Access CAP auth configuration via: cds.env.requires.auth.kind
 */
/* @ts-ignore */
const cds = global.cds || require("@sap/cds"); // This is a work around for missing cds context
/**
 * Determines whether authentication is enabled for the MCP plugin.
 *
 * This function checks the plugin configuration to determine if authentication
 * should be enforced. When authentication is disabled ('none'), the plugin
 * operates with privileged access. For security reasons, this function defaults
 * to enabling authentication unless explicitly disabled.
 *
 * @param configEnabled - The MCP authentication configuration type
 * @returns true if authentication is enabled, false if disabled
 *
 * @example
 * ```typescript
 * const authEnabled = isAuthEnabled('inherit'); // true
 * const noAuth = isAuthEnabled('none');         // false
 * ```
 *
 * @since 1.0.0
 */
function isAuthEnabled(configEnabled) {
    if (configEnabled === "none")
        return false;
    return true; // For now this will always default to true, as we do not want to falsely give access
}
/**
 * Retrieves the appropriate user context for CAP service operations.
 *
 * This function returns the correct user context based on whether authentication
 * is enabled. When authentication is enabled, it uses the current authenticated
 * user from the CAP context. When disabled, it provides privileged access.
 *
 * The returned User object is used for:
 * - Authorization checks in CAP services
 * - Audit logging and traceability
 * - Row-level security and data filtering
 *
 * @param authEnabled - Whether authentication is currently enabled
 * @returns CAP User object with appropriate access rights
 *
 * @example
 * ```typescript
 * const user = getAccessRights(true);  // Returns cds.context.user
 * const admin = getAccessRights(false); // Returns cds.User.privileged
 *
 * // Use in CAP service calls
 * const result = await service.tx({ user }).run(query);
 * ```
 *
 * @throws {Error} When authentication is enabled but no user context exists
 * @since 1.0.0
 */
function getAccessRights(authEnabled) {
    return authEnabled ? cds.context.user : cds.User.privileged;
}
/**
 * Registers comprehensive authentication middleware for MCP endpoints.
 *
 * This function sets up the complete authentication middleware chain for MCP endpoints.
 * It integrates with CAP's authentication system by:
 *
 * 1. Applying all CAP 'before' middleware (including auth middleware)
 * 2. Adding error handling for authentication failures
 * 3. Adding MCP-specific authentication validation
 *
 * The middleware chain handles all CAP authentication types automatically and
 * converts authentication errors to JSON-RPC 2.0 compliant responses.
 *
 * Middleware execution order:
 * 1. CAP middleware chain (authentication, logging, etc.)
 * 2. Authentication error handler
 * 3. MCP authentication validator
 *
 * @param expressApp - Express application instance to register middleware on
 *
 * @example
 * ```typescript
 * const app = express();
 * registerAuthMiddleware(app);
 *
 * // Now all /mcp routes are protected with CAP authentication
 * app.post('/mcp', mcpHandler);
 * ```
 *
 * @throws {Error} When CAP middleware chain is not properly initialized
 * @since 1.0.0
 */
function registerAuthMiddleware(expressApp) {
    const middlewares = cds.middlewares.before; // No types exists for this part of the CDS library
    // Build array of auth middleware to apply
    const authMiddleware = []; // Required any as a workaround for untyped cds middleware
    // Add CAP middleware
    middlewares.forEach((mw) => {
        const process = mw.factory();
        if (process && process.length > 0) {
            authMiddleware.push(process);
        }
    });
    // Add MCP auth middleware
    authMiddleware.push((0, factory_1.errorHandlerFactory)());
    authMiddleware.push((0, factory_1.authHandlerFactory)());
    // If we require OAuth then we should also apply for that
    configureOAuthProxy(expressApp);
    // Apply auth middleware to all /mcp routes EXCEPT health
    expressApp?.use(/^\/mcp(?!\/health).*/, ...authMiddleware);
}
/**
 * Configures OAuth proxy middleware for enterprise authentication scenarios.
 *
 * This function sets up a proxy OAuth provider that integrates with SAP BTP
 * authentication services (XSUAA/IAS) to enable MCP clients to authenticate
 * through standard OAuth2 flows. The proxy handles:
 *
 * - OAuth2 authorization and token endpoints
 * - Access token verification and validation
 * - Client credential management
 * - Integration with CAP authentication configuration
 *
 * The OAuth proxy is only configured for enterprise authentication types
 * (jwt, xsuaa, ias) and skips configuration for basic auth types.
 *
 * @param expressApp - Express application instance to register OAuth routes on
 *
 * @throws {Error} When required OAuth credentials are missing or invalid
 *
 * @example
 * ```typescript
 * // Automatically called by registerAuthMiddleware()
 * // Requires CAP auth configuration:
 * // cds.env.requires.auth = {
 * //   kind: 'xsuaa',
 * //   credentials: {
 * //     clientid: 'your-client-id',
 * //     clientsecret: 'your-client-secret',
 * //     url: 'https://your-tenant.authentication.sap.hana.ondemand.com'
 * //   }
 * // }
 * ```
 *
 * @internal This function is called internally by registerAuthMiddleware()
 * @since 1.0.0
 */
function configureOAuthProxy(expressApp) {
    const config = cds.env.requires.auth;
    const kind = config.kind;
    const credentials = config.credentials;
    // PRESERVE existing logic - skip OAuth proxy for basic auth types
    if (kind === "dummy" || kind === "mocked" || kind === "basic")
        return;
    // PRESERVE existing validation
    if (!credentials ||
        !credentials.clientid ||
        (!credentials.clientsecret && kind !== "ias") ||
        !credentials.url) {
        throw new Error("Invalid security credentials");
    }
    registerOAuthEndpoints(expressApp, credentials, kind);
}
/**
 * Determines the correct protocol (HTTP/HTTPS) for URL construction.
 * Accounts for reverse proxy headers and production environment defaults.
 *
 * @param req - Express request object
 * @returns Protocol string ('http' or 'https')
 */
function getProtocol(req) {
    // Check for reverse proxy header first (most reliable)
    if (req.headers["x-forwarded-proto"]) {
        return req.headers["x-forwarded-proto"];
    }
    // Default to HTTPS in production environments
    const isProduction = process.env.NODE_ENV === "production" || process.env.VCAP_APPLICATION;
    return isProduction ? "https" : req.protocol;
}
/**
 * Registers OAuth endpoints for XSUAA or IAS integration
 * Only called for jwt/xsuaa/ias auth types with valid credentials
 */
function registerOAuthEndpoints(expressApp, credentials, kind) {
    // Instantiate the appropriate service based on auth kind
    const authService = kind === 'ias' 
        ? new ias_service_1.IASService() 
        : new xsuaa_service_1.XSUAAService();
    
    // Fetch endpoints from OIDC configuration
    authService.discoverOAuthEndpoints();
    // Add JSON and URL-encoded body parsing for OAuth endpoints
    expressApp.use("/oauth", express_1.default.json());
    expressApp.use("/oauth", express_1.default.urlencoded({ extended: true }));
    // Apply helmet security middleware only to OAuth routes
    expressApp.use("/oauth", (0, helmet_1.default)({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                scriptSrc: ["'self'"],
                imgSrc: ["'self'", "data:", "https:"],
            },
        },
    }));
    // OAuth Authorization endpoint - stateless redirect to auth provider (XSUAA or IAS)
    expressApp.get("/oauth/authorize", (req, res) => {
        const { state, redirect_uri, client_id, code_challenge, code_challenge_method, scope, } = req.query;
        // Client validation and redirect URI validation is handled by the auth provider
        // We delegate all client management to the auth provider's built-in OAuth server
        const protocol = getProtocol(req);
        const redirectUri = redirect_uri || `${protocol}://${req.get("host")}/oauth/callback`;
        const authUrl = authService.getAuthorizationUrl(redirectUri, client_id ?? "", state, code_challenge, code_challenge_method, scope);
        res.redirect(authUrl);
    });
    // OAuth Callback endpoint - stateless token exchange
    expressApp.get("/oauth/callback", async (req, res) => {
        const { code, state, error, error_description, redirect_uri, code_verifier, } = req.query;
        logger_1.LOGGER.debug("[AUTH] Callback received", code, state);
        if (error) {
            res.status(400).json({
                error: "authorization_failed",
                error_description: error_description || error,
            });
            return;
        }
        if (!code) {
            res.status(400).json({
                error: "invalid_request",
                error_description: "Missing authorization code",
            });
            return;
        }
        try {
            const protocol = getProtocol(req);
            const url = redirect_uri || `${protocol}://${req.get("host")}/oauth/callback`;
            const tokenData = await authService.exchangeCodeForToken(code, url, code_verifier);
            const scopedToken = await authService.getApplicationScopes(tokenData);
            logger_1.LOGGER.debug("Scopes in token:", scopedToken.scope);
            res.json(scopedToken);
        }
        catch (error) {
            logger_1.LOGGER.error("OAuth callback error:", error);
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            res.status(400).json({
                error: "token_exchange_failed",
                error_description: errorMessage,
            });
        }
    });
    // OAuth Token endpoint - POST (standard OAuth 2.0)
    expressApp.post("/oauth/token", async (req, res) => {
        await (0, handlers_1.handleTokenRequest)(req, res, authService);
    });
    // OAuth Discovery endpoint
    expressApp.get("/.well-known/oauth-authorization-server", (req, res) => {
        const protocol = getProtocol(req);
        const baseUrl = `${protocol}://${req.get("host")}`;
        res.json({
            issuer: credentials.url,
            authorization_endpoint: `${baseUrl}/oauth/authorize`,
            token_endpoint: `${baseUrl}/oauth/token`,
            registration_endpoint: `${baseUrl}/oauth/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: ["openid"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
            registration_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
    });
    // OAuth Dynamic Client Registration discovery endpoint (GET)
    expressApp.get("/oauth/register", async (req, res) => {
        // IAS does not support DCR so we will respond with the pre-configured client_id
        if (kind === "ias") {
            const protocol = getProtocol(req);
            const enhancedResponse = {
                client_id: credentials.clientid, // Add our CAP app's client ID
                redirect_uris: req.body.redirect_uris || [
                    `${protocol}://${req.get("host")}/oauth/callback`,
                ],
            };
            logger_1.LOGGER.debug("Provided static client_id during DCR registration process");
            res.json(enhancedResponse);
            return;
        }
        // Keep original implementation for XSUAA
        try {
            // Simple proxy for discovery - no CSRF needed
            const response = await fetch(`${credentials.url}/oauth/register`, {
                method: "GET",
                headers: {
                    Authorization: `Basic ${Buffer.from(`${credentials.clientid}:${credentials.clientsecret}`).toString("base64")}`,
                    Accept: "application/json",
                },
            });
            const xsuaaData = await response.json();
            // Add missing required fields that MCP client expects
            const protocol = getProtocol(req);
            const enhancedResponse = {
                ...xsuaaData, // Keep all XSUAA fields
                client_id: credentials.clientid, // Add our CAP app's client ID
                redirect_uris: [`${protocol}://${req.get("host")}/oauth/callback`], // Add our callback URL for discovery
            };
            res.status(response.status).json(enhancedResponse);
        }
        catch (error) {
            logger_1.LOGGER.error("OAuth registration discovery error:", error);
            res.status(500).json({
                error: "server_error",
                error_description: error instanceof Error ? error.message : "Unknown error",
            });
        }
    });
    // OAuth Dynamic Client Registration endpoint (POST) with CSRF handling
    expressApp.post("/oauth/register", async (req, res) => {
        // IAS does not support DCR so we will respond with the pre-configured client_id
        if (kind === "ias") {
            const protocol = getProtocol(req);
            const enhancedResponse = {
                client_id: credentials.clientid, // Add our CAP app's client ID
                redirect_uris: req.body.redirect_uris || [
                    `${protocol}://${req.get("host")}/oauth/callback`,
                ],
            };
            logger_1.LOGGER.debug("Provided static client_id during DCR registration process");
            res.json(enhancedResponse);
            return;
        }
        // Keep original implementation for XSUAA
        try {
            // Step 1: Fetch CSRF token from XSUAA
            const csrfResponse = await fetch(`${credentials.url}/oauth/register`, {
                method: "GET",
                headers: {
                    "X-CSRF-Token": "Fetch",
                    Authorization: `Basic ${Buffer.from(`${credentials.clientid}:${credentials.clientsecret}`).toString("base64")}`,
                    Accept: "application/json",
                },
            });
            if (!csrfResponse.ok) {
                throw new Error(`CSRF fetch failed: ${csrfResponse.status}`);
            }
            // Step 2: Extract CSRF token and session cookie
            const setCookieHeader = csrfResponse.headers.get("set-cookie") || "";
            const csrfToken = extractCsrfFromCookie(setCookieHeader);
            if (!csrfToken) {
                throw new Error("Could not extract CSRF token from XSUAA response");
            }
            // Step 3: Make actual registration POST with CSRF token
            const registrationResponse = await fetch(`${credentials.url}/oauth/register`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-CSRF-Token": csrfToken,
                    Cookie: setCookieHeader,
                    Authorization: `Basic ${Buffer.from(`${credentials.clientid}:${credentials.clientsecret}`).toString("base64")}`,
                    Accept: "application/json",
                },
                body: JSON.stringify(req.body),
            });
            const xsuaaData = await registrationResponse.json();
            // Add missing required fields that MCP client expects
            const protocol = getProtocol(req);
            const enhancedResponse = {
                ...xsuaaData, // Keep all XSUAA fields
                client_id: credentials.clientid, // Add our CAP app's client ID
                // client_secret: credentials.clientsecret, // CAP app's client secret
                redirect_uris: req.body.redirect_uris || [
                    `${protocol}://${req.get("host")}/oauth/callback`,
                ], // Use client's redirect URIs
            };
            logger_1.LOGGER.debug("[AUTH] Register POST response", enhancedResponse);
            res.status(registrationResponse.status).json(enhancedResponse);
        }
        catch (error) {
            logger_1.LOGGER.error("OAuth registration error:", error);
            res.status(500).json({
                error: "server_error",
                error_description: error instanceof Error ? error.message : "Unknown error",
            });
        }
    });
    logger_1.LOGGER.debug(`OAuth endpoints registered for ${kind === 'ias' ? 'IAS' : 'XSUAA'} integration`);
}
/**
 * Extracts CSRF token from XSUAA Set-Cookie header
 * Looks for "X-Uaa-Csrf=<token>" pattern in the cookie string
 */
function extractCsrfFromCookie(setCookieHeader) {
    if (!setCookieHeader)
        return null;
    // Match X-Uaa-Csrf=<token> pattern
    const csrfMatch = setCookieHeader.match(/X-Uaa-Csrf=([^;,]+)/i);
    return csrfMatch ? csrfMatch[1] : null;
}
/**
 * Checks whether the requesting user's access matches that of the roles required
 * @param user
 * @returns true if the user has access
 */
function hasToolOperationAccess(user, roles) {
    // If no restrictions are defined, allow access
    if (!roles || roles.length === 0)
        return true;
    for (const el of roles) {
        if (user.is(el.role))
            return true;
    }
    return false;
}
/**
 * Determines wrap accesses based on the given MCP restrictions derived from annotations
 * @param user
 * @param restrictions
 * @returns wrap tool accesses
 */
function getWrapAccesses(user, restrictions) {
    // If no restrictions are defined, allow all access
    if (!restrictions || restrictions.length === 0) {
        return {
            canRead: true,
            canCreate: true,
            canUpdate: true,
            canDelete: true,
        };
    }
    const access = {};
    for (const el of restrictions) {
        // If the user does not even have the role then no reason to check
        if (!user.is(el.role))
            continue;
        if (!el.operations || el.operations.length <= 0) {
            access.canRead = true;
            access.canCreate = true;
            access.canDelete = true;
            access.canUpdate = true;
            break;
        }
        if (el.operations.includes("READ")) {
            access.canRead = true;
        }
        if (el.operations.includes("UPDATE")) {
            access.canUpdate = true;
        }
        if (el.operations.includes("CREATE")) {
            access.canCreate = true;
        }
        if (el.operations.includes("DELETE")) {
            access.canDelete = true;
        }
    }
    return access;
}
/**
 * Utility method for checking whether auth used is mocked and not live
 * @returns boolean
 */
function useMockAuth(authKind) {
    return authKind !== "jwt" && authKind !== "ias" && authKind !== "xsuaa";
}
