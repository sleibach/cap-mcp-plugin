"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleTokenRequest = handleTokenRequest;
const logger_1 = require("../logger");
/**
 * Reusable OAuth token handler function
 * Handles both GET and POST requests by extracting parameters from both query and body
 * This unified approach follows lemaiwo's successful pattern and works around MCP SDK inconsistencies
 */
async function handleTokenRequest(req, res, authService) {
    try {
        const params = { ...req.query, ...req.body };
        const { grant_type, code, redirect_uri, refresh_token, code_verifier } = params;
        if (grant_type === "authorization_code") {
            if (!code || !redirect_uri) {
                res.status(400).json({
                    error: "invalid_request",
                    error_description: "Missing code or redirect_uri",
                });
                return;
            }
            const tokenData = await authService.exchangeCodeForToken(code, redirect_uri, code_verifier);
            
            // IMPORTANT: For OAuth clients (MCP), return the IAS/XSUAA token as-is
            // Do NOT exchange IAS -> XSUAA here. That should only happen for backend service calls.
            // This matches @sap/approuter behavior which returns the original token to OAuth clients.
            logger_1.LOGGER.debug("Scopes in token:", tokenData.scope);
            logger_1.LOGGER.debug("[AUTH] Token exchange successful");
            res.json(tokenData);
        }
        else if (grant_type === "refresh_token") {
            if (!refresh_token) {
                res.status(400).json({
                    error: "invalid_request",
                    error_description: "Missing refresh_token",
                });
                return;
            }
            const tokenData = await authService.refreshAccessToken(refresh_token);
            logger_1.LOGGER.debug("[AUTH] Token refresh successful");
            res.json(tokenData);
        }
        else {
            res.status(400).json({
                error: "unsupported_grant_type",
                error_description: "Only authorization_code and refresh_token are supported",
            });
        }
    }
    catch (error) {
        logger_1.LOGGER.error("OAuth token error:", error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        res.status(400).json({
            error: "invalid_grant",
            error_description: errorMessage,
        });
    }
}
