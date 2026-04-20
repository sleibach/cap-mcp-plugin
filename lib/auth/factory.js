"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authHandlerFactory = authHandlerFactory;
exports.errorHandlerFactory = errorHandlerFactory;
const xsuaa_service_1 = require("./xsuaa-service");
const ias_service_1 = require("./ias-service");
const utils_1 = require("./utils");
const logger_1 = require("../logger");
/** JSON-RPC 2.0 error code for unauthorized requests */
const RPC_UNAUTHORIZED = 10;
/* @ts-ignore */
const cds = global.cds || require("@sap/cds"); // This is a work around for missing cds context
/**
 * Creates an Express middleware for MCP authentication validation.
 *
 * This handler validates that requests are properly authenticated based on the CAP authentication
 * configuration. It checks for authorization headers (except for 'dummy' auth), validates the
 * CAP context, and ensures a valid user is present.
 *
 * The middleware performs the following validations:
 * 1. Checks for Authorization header (unless CAP auth is 'dummy')
 * 2. Validates that CAP context is properly initialized
 * 3. Ensures an authenticated user exists and is not anonymous
 *
 * @returns Express RequestHandler middleware function
 *
 * @example
 * ```typescript
 * const authMiddleware = authHandlerFactory();
 * app.use('/mcp', authMiddleware);
 * ```
 *
 * @throws {401} When authorization header is missing (non-dummy auth)
 * @throws {401} When user is not authenticated or is anonymous
 * @throws {500} When CAP context is not properly loaded
 */
function authHandlerFactory() {
    const authKind = cds.env.requires.auth.kind;
    // Create the appropriate auth service based on auth kind.
    // XSUAAService validates XSUAA/JWT tokens against xssec; IASService
    // delegates to CAP's IAS strategy (returns null).
    let authService = undefined;
    if (!(0, utils_1.useMockAuth)(authKind)) {
        authService = authKind === "ias"
            ? new ias_service_1.IASService()
            : new xsuaa_service_1.XSUAAService();
    }
    logger_1.LOGGER.debug("Authentication kind", authKind);
    return async (req, res, next) => {
        if (!req.headers.authorization && authKind !== "dummy") {
            return respondUnauthorized(req, res, "Unauthorized");
        }
        // For enterprise auth (XSUAA/JWT), run an xssec validation to catch
        // forged/expired tokens even if CAP's middleware lets them through.
        // IAS returns null from createSecurityContext by design — CAP's
        // IAS strategy handles validation and sets cds.context.user below.
        if (authService?.isConfigured() &&
            (authKind === "jwt" || authKind === "xsuaa")) {
            const securityContext = await authService.createSecurityContext(req);
            if (!securityContext) {
                return respondUnauthorized(req, res, "Invalid or expired token");
            }
        }
        // Validate that CAP context is properly set with authenticated user.
        // This is the critical check for every auth kind — including IAS,
        // where CAP's middleware is the sole validator.
        const ctx = cds.context;
        if (!ctx) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: {
                    code: -32603,
                    message: "Internal Error: CAP context not correctly loaded",
                    id: null,
                },
            });
            return;
        }
        const user = ctx.user;
        if (!user || user === cds.User.anonymous) {
            return respondUnauthorized(req, res, "Unauthorized: No authenticated user in CAP context");
        }
        logger_1.LOGGER.debug(`Authenticated user: ${user.id}, roles: ${JSON.stringify(user._roles)}`);
        return next();
    };
}
/**
 * Emits a JSON-RPC 2.0 401 response with the MCP-spec-required
 * WWW-Authenticate header pointing at this resource's
 * /.well-known/oauth-protected-resource metadata document (RFC 9728 §5).
 */
function respondUnauthorized(req, res, message) {
    try {
        res.setHeader("WWW-Authenticate", (0, utils_1.wwwAuthenticateHeader)(req));
    }
    catch { /* best effort — never block the 401 on header build failure */ }
    res.status(401).json({
        jsonrpc: "2.0",
        error: {
            code: RPC_UNAUTHORIZED,
            message,
            id: null,
        },
    });
}
/**
 * Creates an Express error handling middleware for CAP authentication errors.
 *
 * This error handler catches authentication and authorization errors thrown by CAP
 * middleware and converts them to JSON-RPC 2.0 compliant error responses. It handles
 * both 401 (Unauthorized) and 403 (Forbidden) errors specifically.
 *
 * @returns Express ErrorRequestHandler middleware function
 *
 * @example
 * ```typescript
 * const errorHandler = errorHandlerFactory();
 * app.use('/mcp', errorHandler);
 * ```
 *
 * @param err - The error object, expected to be 401 or 403 for auth errors
 * @param req - Express request object (unused, marked with underscore)
 * @param res - Express response object for sending error responses
 * @param next - Express next function for passing unhandled errors
 */
function errorHandlerFactory() {
    return (err, req, res, next) => {
        if (err === 401 || err === 403) {
            if (err === 401) {
                try {
                    res.setHeader("WWW-Authenticate", (0, utils_1.wwwAuthenticateHeader)(req));
                }
                catch { /* best effort */ }
            }
            res.status(err).json({
                jsonrpc: "2.0",
                error: {
                    code: RPC_UNAUTHORIZED,
                    message: err === 401 ? "Unauthorized" : "Forbidden",
                    id: null,
                },
            });
            return;
        }
        next(err);
    };
}
