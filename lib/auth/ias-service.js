"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.IASService = void 0;
const xssec = __importStar(require("@sap/xssec"));
const logger_1 = require("../logger");
/* @ts-ignore */
const cds = global.cds || require("@sap/cds");
/**
 * IAS (Identity Authentication Service) OAuth service
 * Handles pure IAS authentication without XSUAA cross-consumption
 */
class IASService {
    credentials;
    endpoints;
    hasXsuaaCrossConsumption;
    xsuaaService;
    xsuaaCredentials;
    xsuaaEndpoints;
    constructor() {
        // Get IAS credentials from auth configuration
        this.credentials = cds.env.requires.auth?.credentials;
        
        // IAS can use either clientid or authorization_client_id (for X.509)
        // Normalize to always use clientid internally
        if (this.credentials && !this.credentials.clientid && this.credentials.authorization_client_id) {
            this.credentials.clientid = this.credentials.authorization_client_id;
        }
        
        // Check if XSUAA cross-consumption is enabled
        this.hasXsuaaCrossConsumption = !!cds.env.requires.xsuaa?.credentials;
        
        if (this.hasXsuaaCrossConsumption) {
            this.xsuaaCredentials = cds.env.requires.xsuaa.credentials;
            this.xsuaaEndpoints = {
                discovery_url: `${this.xsuaaCredentials?.url}/.well-known/openid-configuration`,
                authorization_endpoint: `${this.xsuaaCredentials?.url}/oauth/authorize`,
                token_endpoint: `${this.xsuaaCredentials?.url}/oauth/token`,
            };
            this.xsuaaService = new xssec.XsuaaService(this.xsuaaCredentials);
        }
        
        // Set default IAS endpoints
        // Note: IAS uses /oauth2/ path (not /oauth/)
        this.endpoints = {
            discovery_url: `${this.credentials?.url}/.well-known/openid-configuration`,
            authorization_endpoint: `${this.credentials?.url}/oauth2/authorize`,
            token_endpoint: `${this.credentials?.url}/oauth2/token`,
        };
    }
    isConfigured() {
        return !!(this.credentials?.clientid && this.credentials?.url);
    }
    
    /**
     * Check if this client uses X.509 certificate authentication (mTLS)
     */
    usesCertificateAuth() {
        return !!(this.credentials?.certificate && this.credentials?.key);
    }
    
    /**
     * Check if this is a confidential client (has client secret)
     * vs a public client (no client secret, uses PKCE)
     */
    isConfidentialClient() {
        return !!(this.credentials?.clientsecret);
    }
    /**
     * Fetch OAuth endpoints from IAS OIDC discovery endpoint
     */
    async discoverOAuthEndpoints() {
        try {
            // Discover IAS endpoints
            const response = await fetch(this.endpoints.discovery_url, {
                method: "GET",
                headers: {
                    Accept: "application/json",
                },
            });
            if (!response.ok) {
                const errorData = await response.json();
                logger_1.LOGGER.warn(`IAS OAuth endpoints fetch failed: ${response.status} ${errorData.error_description || errorData.error}. Continuing with default configuration.`);
            }
            else {
                const oidcConfig = await response.json();
                this.endpoints.authorization_endpoint = oidcConfig.authorization_endpoint;
                this.endpoints.token_endpoint = oidcConfig.token_endpoint;
                logger_1.LOGGER.debug("IAS OAuth endpoints set to:", this.endpoints);
            }
            
            // If XSUAA cross-consumption is enabled, discover XSUAA endpoints too
            if (this.hasXsuaaCrossConsumption && this.xsuaaEndpoints) {
                const xsuaaResponse = await fetch(this.xsuaaEndpoints.discovery_url, {
                    method: "GET",
                    headers: {
                        Accept: "application/json",
                    },
                });
                if (!xsuaaResponse.ok) {
                    const errorData = await xsuaaResponse.json();
                    logger_1.LOGGER.warn(`XSUAA OAuth endpoints fetch failed: ${xsuaaResponse.status} ${errorData.error_description || errorData.error}. Continuing with default configuration.`);
                }
                else {
                    const oidcConfig = await xsuaaResponse.json();
                    this.xsuaaEndpoints.authorization_endpoint = oidcConfig.authorization_endpoint;
                    this.xsuaaEndpoints.token_endpoint = oidcConfig.token_endpoint;
                    logger_1.LOGGER.debug("XSUAA OAuth endpoints set to:", this.xsuaaEndpoints);
                }
            }
        }
        catch (error) {
            if (error instanceof Error) {
                throw error;
            }
            throw new Error(`OAuth endpoints fetch failed: ${String(error)}`);
        }
    }
    /**
     * Generates authorization URL for IAS
     */
    getAuthorizationUrl(redirectUri, client_id, state, code_challenge, code_challenge_method, scope) {
        const params = new URLSearchParams({
            response_type: "code",
            redirect_uri: redirectUri,
            client_id,
            ...(!!code_challenge ? { code_challenge } : {}),
            ...(!!code_challenge_method ? { code_challenge_method } : {}),
            ...(!!scope ? { scope } : {}),
        });
        if (state) {
            params.append("state", state);
        }
        return `${this.endpoints.authorization_endpoint}?${params.toString()}`;
    }
    /**
     * Exchange authorization code for token using IAS token endpoint
     * Supports three authentication methods:
     * 1. X.509 Certificate (mTLS) - for IAS with credential-type: X509_GENERATED
     * 2. Client Secret (confidential) - for IAS with client_secret
     * 3. Public client with PKCE - for IAS without client_secret
     * 
     * This matches the behavior of @sap/approuter (oauth2.js)
     */
    async exchangeCodeForToken(code, redirectUri, code_verifier) {
        try {
            const tokenOptions = {
                grant_type: "authorization_code",
                code,
                redirect_uri: redirectUri,
                client_id: this.credentials?.clientid,
                ...(!!code_verifier ? { code_verifier } : {}),
            };
            
            const fetchOptions = {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams(tokenOptions),
            };
            
            // Method 1: X.509 Certificate Authentication (mTLS)
            if (this.usesCertificateAuth()) {
                logger_1.LOGGER.debug("IAS token exchange: Using X.509 certificate authentication (mTLS)");
                // For mTLS, we need to use https.Agent with cert and key
                const https = require("https");
                fetchOptions.agent = new https.Agent({
                    cert: this.credentials?.certificate,
                    key: this.credentials?.key,
                    rejectUnauthorized: true,
                });
            }
            // Method 2: Client Secret Authentication
            else if (this.isConfidentialClient()) {
                // For confidential clients: send BOTH Basic Auth header AND client_secret in form
                // This matches @sap/approuter implementation (oauth2.js lines 73-77)
                tokenOptions.client_secret = this.credentials?.clientsecret;
                fetchOptions.headers.Authorization = `Basic ${Buffer.from(`${this.credentials?.clientid}:${this.credentials?.clientsecret}`).toString("base64")}`;
                logger_1.LOGGER.debug("IAS token exchange: Using confidential client authentication (Basic Auth + client_secret in form)");
            }
            // Method 3: Public Client with PKCE
            else {
                logger_1.LOGGER.debug("IAS token exchange: Using public client authentication (PKCE only)");
            }
            
            // Use IAS token endpoint for authorization code exchange
            const response = await fetch(this.endpoints.token_endpoint, fetchOptions);
            
            if (!response.ok) {
                const errorData = (await response.json());
                throw new Error(`IAS token exchange failed: ${response.status} ${errorData.error_description || errorData.error}`);
            }
            return response.json();
        }
        catch (error) {
            if (error instanceof Error) {
                throw error;
            }
            throw new Error(`IAS token exchange failed: ${String(error)}`);
        }
    }
    /**
     * Convert IAS access_token to XSUAA access_token with application scopes
     * Only applicable when XSUAA cross-consumption is enabled
     * For pure IAS, returns the token as-is since IAS tokens already contain the necessary scopes
     */
    async getApplicationScopes(token) {
        // If using pure IAS (no XSUAA cross-consumption), return token as-is
        if (!this.hasXsuaaCrossConsumption) {
            logger_1.LOGGER.debug("Pure IAS mode: No XSUAA token exchange needed, returning IAS token");
            return token;
        }
        
        // Perform IAS -> XSUAA token exchange
        try {
            const tokenOptions = {
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                response_type: "token",
                assertion: token.access_token,
            };
            
            const response = await fetch(this.xsuaaEndpoints.token_endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Authorization: `Basic ${Buffer.from(`${this.xsuaaCredentials?.clientid}:${this.xsuaaCredentials?.clientsecret}`).toString("base64")}`,
                },
                body: new URLSearchParams(tokenOptions),
            });
            
            if (!response.ok) {
                const errorData = (await response.json());
                throw new Error(`IAS to XSUAA token exchange failed: ${response.status} ${errorData.error_description || errorData.error}`);
            }
            
            logger_1.LOGGER.debug("IAS token successfully exchanged for XSUAA token with application scopes");
            return response.json();
        }
        catch (error) {
            if (error instanceof Error) {
                throw error;
            }
            throw new Error(`IAS to XSUAA token exchange failed: ${String(error)}`);
        }
    }
    /**
     * Refresh access token using IAS token endpoint
     * Supports three authentication methods matching exchangeCodeForToken
     */
    async refreshAccessToken(refreshToken) {
        try {
            const tokenOptions = {
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: this.credentials?.clientid,
            };
            
            const fetchOptions = {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams(tokenOptions),
            };
            
            // Method 1: X.509 Certificate Authentication (mTLS)
            if (this.usesCertificateAuth()) {
                logger_1.LOGGER.debug("IAS token refresh: Using X.509 certificate authentication (mTLS)");
                const https = require("https");
                fetchOptions.agent = new https.Agent({
                    cert: this.credentials?.certificate,
                    key: this.credentials?.key,
                    rejectUnauthorized: true,
                });
            }
            // Method 2: Client Secret Authentication
            else if (this.isConfidentialClient()) {
                tokenOptions.client_secret = this.credentials?.clientsecret;
                fetchOptions.headers.Authorization = `Basic ${Buffer.from(`${this.credentials?.clientid}:${this.credentials?.clientsecret}`).toString("base64")}`;
                logger_1.LOGGER.debug("IAS token refresh: Using confidential client authentication (Basic Auth + client_secret in form)");
            }
            // Method 3: Public Client
            else {
                logger_1.LOGGER.debug("IAS token refresh: Using public client authentication");
            }
            
            const response = await fetch(this.endpoints.token_endpoint, fetchOptions);
            
            if (!response.ok) {
                const errorData = (await response.json());
                throw new Error(`IAS token refresh failed: ${response.status} ${errorData.error_description || errorData.error}`);
            }
            
            return response.json();
        }
        catch (error) {
            if (error instanceof Error) {
                throw error;
            }
            throw new Error(`IAS token refresh failed: ${String(error)}`);
        }
    }
    /**
     * Validate JWT token
     * For pure IAS, delegates to CAP's authentication middleware
     * For IAS with XSUAA cross-consumption, uses @sap/xssec
     */
    async validateToken(accessToken, req) {
        try {
            // For pure IAS, validation is handled by CAP middleware
            if (!this.hasXsuaaCrossConsumption) {
                logger_1.LOGGER.debug("Pure IAS mode: Token validation delegated to CAP authentication middleware");
                return true;
            }
            
            // For IAS with XSUAA, validate using xssec
            const securityContext = await xssec.createSecurityContext(this.xsuaaService, {
                req: req || { headers: { authorization: `Bearer ${accessToken}` } },
                token: accessToken,
            });
            
            return !!securityContext;
        }
        catch (error) {
            if (error instanceof xssec.errors.TokenValidationError) {
                logger_1.LOGGER.warn("IAS token validation failed:", error.message);
            }
            else if (error instanceof Error) {
                logger_1.LOGGER.warn("IAS token validation failed:", error.message);
            }
            return false;
        }
    }
    /**
     * Create security context for authenticated requests
     * Returns null if token is invalid
     */
    async createSecurityContext(req) {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith("Bearer ")) {
                return null;
            }
            
            // For pure IAS, let CAP handle the security context
            if (!this.hasXsuaaCrossConsumption) {
                logger_1.LOGGER.debug("Pure IAS mode: Security context creation delegated to CAP");
                return null; // CAP will handle this
            }
            
            const token = authHeader.substring(7);
            const securityContext = await xssec.createSecurityContext(this.xsuaaService, { req, token });
            
            return securityContext;
        }
        catch (error) {
            if (error instanceof xssec.errors.TokenValidationError) {
                logger_1.LOGGER.warn("IAS security context creation failed:", error.message);
            }
            else if (error instanceof Error) {
                logger_1.LOGGER.warn("IAS security context creation failed:", error.message);
            }
            return null;
        }
    }
}
exports.IASService = IASService;

