"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpSessionManager = void 0;
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const crypto_1 = require("crypto");
const env_sanitizer_1 = require("../config/env-sanitizer");
const logger_1 = require("../logger");
const factory_1 = require("./factory");
/**
 * Manages active MCP server sessions and their lifecycle
 * Handles session creation, storage, retrieval, and cleanup for MCP protocol communication
 */
class McpSessionManager {
    /** Map storing active sessions by their unique session IDs */
    sessions;
    /**
     * Creates a new session manager with empty session storage
     */
    constructor() {
        this.sessions = new Map();
    }
    /**
     * Retrieves the complete map of active sessions
     * @returns Map of session IDs to their corresponding session objects
     */
    getSessions() {
        return this.sessions;
    }
    /**
     * Checks if a session exists for the given session ID
     * @param sessionID - Unique identifier for the session
     * @returns True if session exists, false otherwise
     */
    hasSession(sessionID) {
        return this.sessions.has(sessionID);
    }
    /**
     * Retrieves a specific session by its ID
     * @param sessionID - Unique identifier for the session
     * @returns Session object if found, undefined otherwise
     */
    getSession(sessionID) {
        return this.sessions.get(sessionID);
    }
    /**
     * Creates a new MCP session with server and transport configuration
     * Initializes MCP server with provided annotations and establishes transport connection
     * @param config - CAP configuration for the MCP server
     * @param annotations - Optional parsed MCP annotations for resources, tools, and prompts
     * @returns Promise resolving to the created session object
     */
    async createSession(config, annotations) {
        logger_1.LOGGER.debug("Initialize session request received");
        const server = (0, factory_1.createMcpServer)(config, annotations);
        const transport = this.createTransport(server);
        await server.connect(transport);
        return { server, transport };
    }
    /**
     * Creates and configures HTTP transport for MCP communication
     * Sets up session ID generation, response format, and event handlers
     * @param server - MCP server instance to associate with the transport
     * @returns Configured StreamableHTTPServerTransport instance
     */
    createTransport(server) {
        // Prefer JSON responses to avoid SSE client compatibility issues in dev/mock
        const enableJson = (0, env_sanitizer_1.getSafeEnvVar)("MCP_ENABLE_JSON", "true") === "true" ||
            (0, env_sanitizer_1.isTestEnvironment)();
        const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
            sessionIdGenerator: () => (0, crypto_1.randomUUID)(),
            enableJsonResponse: enableJson,
            onsessioninitialized: (sid) => {
                logger_1.LOGGER.info("Session initialized with ID: ", sid);
                logger_1.LOGGER.debug("Transport mode", { enableJsonResponse: enableJson });
                this.sessions.set(sid, {
                    server: server,
                    transport: transport,
                });
            },
        });
        // In JSON response mode, HTTP connections are short-lived per request.
        // Closing the underlying connection does NOT mean the MCP session is over.
        // Avoid deleting the session on close when enableJson is true.
        transport.onclose = () => {
            if (!enableJson) {
                this.onCloseSession(transport);
            }
        };
        return transport;
    }
    /**
     * Handles session cleanup when transport connection closes
     * Removes the session from active sessions map when connection terminates
     * @param transport - Transport instance that was closed
     */
    onCloseSession(transport) {
        if (!transport.sessionId || !this.sessions.has(transport.sessionId)) {
            return;
        }
        this.sessions.delete(transport.sessionId);
    }
}
exports.McpSessionManager = McpSessionManager;
