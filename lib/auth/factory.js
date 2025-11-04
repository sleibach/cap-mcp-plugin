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
    
    // Create the appropriate auth service based on auth kind
    let authService = undefined;
    if (!(0, utils_1.useMockAuth)(authKind)) {
        if (authKind === "ias") {
            authService = new ias_service_1.IASService();
        } else {
            // For xsuaa, jwt, or other types
            authService = new xsuaa_service_1.XSUAAService();
        }
    }
    
    logger_1.LOGGER.debug("Authentication kind", authKind);
    
    return async (req, res, next) => {
        if (!req.headers.authorization && authKind !== "dummy") {
            res.status(401).json({
                jsonrpc: "2.0",
                error: {
                    code: RPC_UNAUTHORIZED,
                    message: "Unauthorized",
                    id: null,
                },
            });
            return;
        }
        
        // IMPORTANT: CAP's middleware should have already validated the token and set cds.context.user
        // This additional validation is for extra security when using enterprise auth (XSUAA/IAS)
        // We use the appropriate service (IASService for IAS, XSUAAService for XSUAA/JWT)
        if ((authKind === "jwt" || authKind === "xsuaa" || authKind === "ias") &&
            authService?.isConfigured()) {
            const securityContext = await authService.createSecurityContext(req);
            if (!securityContext && authKind !== "ias") {
                // For pure IAS, createSecurityContext may return null (validation delegated to CAP)
                // Only fail for XSUAA/JWT where we expect xssec validation
                res.status(401).json({
                    jsonrpc: "2.0",
                    error: {
                        code: RPC_UNAUTHORIZED,
                        message: "Invalid or expired token",
                        id: null,
                    },
                });
                return;
            }
            // Add security context to request for later use (if available)
            if (securityContext) {
                req.securityContext = securityContext;
            }
        }
        
        // Validate that CAP context is properly set with authenticated user
        // This is the critical check - CAP's middleware MUST have set cds.context.user
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
            res.status(401).json({
                jsonrpc: "2.0",
                error: {
                    code: RPC_UNAUTHORIZED,
                    message: "Unauthorized: No authenticated user in CAP context",
                    id: null,
                },
            });
            return;
        }
        
        logger_1.LOGGER.debug(`Authenticated user: ${user.id}, roles: ${JSON.stringify(user._roles)}`);
        return next();
    };
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
    return (err, _, res, next) => {
        if (err === 401 || err === 403) {
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
