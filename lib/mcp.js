"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = require("./logger");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const express_1 = __importDefault(require("express"));
const parser_1 = require("./annotations/parser");
const utils_1 = require("./mcp/utils");
const constants_1 = require("./mcp/constants");
const loader_1 = require("./config/loader");
const session_manager_1 = require("./mcp/session-manager");
const utils_2 = require("./auth/utils");
const helmet_1 = __importDefault(require("helmet"));
const cors_1 = __importDefault(require("cors"));
/* @ts-ignore */
const cds = global.cds; // Use hosting app's CDS instance exclusively
/**
 * Main MCP plugin class that integrates CAP services with Model Context Protocol
 * Manages server sessions, API endpoints, and annotation processing
 */
class McpPlugin {
    sessionManager;
    config;
    expressApp;
    annotations;
    /**
     * Creates a new MCP plugin instance with configuration and session management
     */
    constructor() {
        logger_1.LOGGER.debug("Plugin instance created");
        this.config = (0, loader_1.loadConfiguration)();
        this.sessionManager = new session_manager_1.McpSessionManager();
        logger_1.LOGGER.debug("Running with configuration", this.config);
    }
    /**
     * Handles the bootstrap event by setting up Express app and API endpoints
     * @param app - Express application instance
     */
    async onBootstrap(app) {
        logger_1.LOGGER.debug("Event received for 'bootstrap'");
        this.expressApp = app;
        this.expressApp.use("/mcp", express_1.default.json());
        // Only needed to use MCP Inspector in local browser:
        this.expressApp.use(["/oauth", "/.well-known"], (0, cors_1.default)({ origin: "http://localhost:6274" }));
        // Apply helmet security middleware only to MCP routes
        this.expressApp.use("/mcp", (0, helmet_1.default)({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    scriptSrc: ["'self'"],
                    imgSrc: ["'self'", "data:", "https:"],
                },
            },
        }));
        if (this.config.auth === "inherit") {
            (0, utils_2.registerAuthMiddleware)(this.expressApp);
        }
        await this.registerApiEndpoints();
        logger_1.LOGGER.debug("Bootstrap complete");
    }
    /**
     * Handles the loaded event by parsing model definitions for MCP annotations
     * @param model - CSN model containing definitions
     */
    async onLoaded(model) {
        logger_1.LOGGER.debug("Event received for 'loaded'");
        this.annotations = (0, parser_1.parseDefinitions)(model);
        logger_1.LOGGER.debug("Annotations have been loaded");
    }
    /**
     * Handles the shutdown event by gracefully closing all MCP server sessions
     */
    async onShutdown() {
        logger_1.LOGGER.debug("Gracefully shutting down MCP server");
        for (const session of this.sessionManager.getSessions().values()) {
            await session.transport.close();
            await session.server.close();
        }
        logger_1.LOGGER.debug("MCP server sessions has been shutdown");
    }
    /**
     * Sets up HTTP endpoints for MCP communication and health checks
     * Registers /mcp and /mcp/health routes with appropriate handlers
     */
    async registerApiEndpoints() {
        if (!this.expressApp) {
            logger_1.LOGGER.warn("Cannot register MCP server as there is no available express layer");
            return;
        }
        logger_1.LOGGER.debug("Registering health endpoint for MCP");
        this.expressApp?.get("/mcp/health", (_, res) => {
            res.json({
                status: "UP",
            });
        });
        this.registerMcpSessionRoute();
        this.expressApp?.get("/mcp", (req, res) => (0, utils_1.handleMcpSessionRequest)(req, res, this.sessionManager.getSessions()));
        this.expressApp?.delete("/mcp", ((req, res) => {
            const sessionIdHeader = req.headers[constants_1.MCP_SESSION_HEADER];
            const sessions = this.sessionManager.getSessions();
            if (!sessionIdHeader || !sessions.has(sessionIdHeader)) {
                return res.status(400).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32000,
                        message: "Bad Request: No valid sessions ID provided",
                        id: null,
                    },
                });
            }
            const session = sessions.get(sessionIdHeader);
            // Fire-and-forget close operations
            void session.transport.close();
            void session.server.close();
            sessions.delete(sessionIdHeader);
            return res.status(200).json({ jsonrpc: "2.0", result: { closed: true } });
        }));
    }
    /**
     * Registers the main MCP POST endpoint for session creation and request handling
     * Handles session initialization and routes requests to appropriate sessions
     */
    registerMcpSessionRoute() {
        logger_1.LOGGER.debug("Registering MCP entry point");
        this.expressApp?.post("/mcp", async (req, res) => {
            const sessionIdHeader = req.headers[constants_1.MCP_SESSION_HEADER];
            logger_1.LOGGER.debug("MCP request received", {
                hasSessionId: !!sessionIdHeader,
                isInitialize: (0, types_js_1.isInitializeRequest)(req.body),
                contentType: req.headers["content-type"],
            });
            const session = !sessionIdHeader && (0, types_js_1.isInitializeRequest)(req.body)
                ? await this.sessionManager.createSession(this.config, this.annotations)
                : this.sessionManager.getSession(sessionIdHeader);
            if (!session) {
                logger_1.LOGGER.error("Invalid session ID", sessionIdHeader);
                res.status(400).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32000,
                        message: "Bad Request: No valid sessions ID provided",
                        id: null,
                    },
                });
                return;
            }
            try {
                const t0 = Date.now();
                await session.transport.handleRequest(req, res, req.body);
                logger_1.LOGGER.debug("MCP request handled", { durationMs: Date.now() - t0 });
                return;
            }
            catch (e) {
                if (res.headersSent)
                    return;
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32603,
                        message: "Internal Error: Transport failed",
                        id: null,
                    },
                });
                return;
            }
        });
    }
}
exports.default = McpPlugin;
