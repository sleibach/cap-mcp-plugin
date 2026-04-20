"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpSessionManager = void 0;
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const crypto_1 = require("crypto");
const env_sanitizer_1 = require("../config/env-sanitizer");
const logger_1 = require("../logger");
const factory_1 = require("./factory");
// Idle sessions are reaped after this many ms of inactivity.
// Override via CDS_MCP_SESSION_TTL_MS (env). Clients reconnect transparently
// by re-initializing, so a 30-minute window is safe for interactive use.
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
// How often the reaper scans for idle sessions.
const DEFAULT_SESSION_SWEEP_MS = 5 * 60 * 1000;
// Hard cap to bound memory even under session churn (e.g. buggy clients
// that never send DELETE and initialize new sessions on every call).
const DEFAULT_SESSION_MAX = 256;
/**
 * Manages active MCP server sessions and their lifecycle
 * Handles session creation, storage, retrieval, and cleanup for MCP protocol communication
 *
 * Session cleanup strategy:
 *   - Sessions have a last-access timestamp refreshed on every getSession()
 *   - An interval sweeper removes sessions idle longer than TTL
 *   - A hard cap evicts the oldest session when full to prevent DoS-style growth
 */
class McpSessionManager {
    /** Map storing active sessions by their unique session IDs */
    sessions;
    /** Interval handle for the idle-session reaper. */
    sweepTimer;
    constructor() {
        this.sessions = new Map();
        const sweepMs = Number((0, env_sanitizer_1.getSafeEnvVar)("CDS_MCP_SESSION_SWEEP_MS", String(DEFAULT_SESSION_SWEEP_MS))) || DEFAULT_SESSION_SWEEP_MS;
        this.sweepTimer = setInterval(() => this.reapIdleSessions(), sweepMs);
        // Don't keep the process alive just for the reaper.
        this.sweepTimer?.unref?.();
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
     * Retrieves a specific session by its ID and refreshes its last-access timestamp
     * so the reaper doesn't evict actively-used sessions.
     * @param sessionID - Unique identifier for the session
     * @returns Session object if found, undefined otherwise
     */
    getSession(sessionID) {
        if (!sessionID)
            return undefined;
        const session = this.sessions.get(sessionID);
        if (session) {
            session.lastAccess = Date.now();
        }
        return session;
    }
    /**
     * Sweeps sessions that have been idle longer than the configured TTL.
     * Called on a timer; also safe to call manually (e.g. in tests).
     */
    async reapIdleSessions() {
        const ttl = Number((0, env_sanitizer_1.getSafeEnvVar)("CDS_MCP_SESSION_TTL_MS", String(DEFAULT_SESSION_TTL_MS))) || DEFAULT_SESSION_TTL_MS;
        const cutoff = Date.now() - ttl;
        let reaped = 0;
        for (const [sid, session] of this.sessions.entries()) {
            if ((session.lastAccess ?? 0) < cutoff) {
                this.sessions.delete(sid);
                reaped += 1;
                // Close transport/server for the reaped session; never block the sweep.
                void Promise.resolve()
                    .then(() => session.transport?.close?.())
                    .catch(() => { });
                void Promise.resolve()
                    .then(() => session.server?.close?.())
                    .catch(() => { });
            }
        }
        if (reaped > 0) {
            logger_1.LOGGER.debug(`Session reaper removed ${reaped} idle session(s)`, { remaining: this.sessions.size });
        }
    }
    /**
     * Stops the background reaper. Call during graceful shutdown to avoid
     * keeping timers alive after the plugin disposes.
     */
    stop() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = undefined;
        }
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
        this.enforceSessionCap();
        const server = (0, factory_1.createMcpServer)(config, annotations);
        const transport = this.createTransport(server);
        await server.connect(transport);
        return { server, transport, lastAccess: Date.now() };
    }
    /**
     * If the session map is at its hard cap, evict the least-recently-used
     * entry before admitting a new one. Prevents unbounded growth when
     * misbehaving clients keep initializing without sending DELETE.
     */
    enforceSessionCap() {
        const max = Number((0, env_sanitizer_1.getSafeEnvVar)("CDS_MCP_SESSION_MAX", String(DEFAULT_SESSION_MAX))) || DEFAULT_SESSION_MAX;
        if (this.sessions.size < max)
            return;
        let oldestSid;
        let oldestAccess = Infinity;
        for (const [sid, session] of this.sessions.entries()) {
            const la = session.lastAccess ?? 0;
            if (la < oldestAccess) {
                oldestAccess = la;
                oldestSid = sid;
            }
        }
        if (oldestSid) {
            const evicted = this.sessions.get(oldestSid);
            this.sessions.delete(oldestSid);
            logger_1.LOGGER.warn(`Session cap (${max}) reached, evicting LRU session`, { sid: oldestSid });
            void Promise.resolve()
                .then(() => evicted?.transport?.close?.())
                .catch(() => { });
            void Promise.resolve()
                .then(() => evicted?.server?.close?.())
                .catch(() => { });
        }
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
                logger_1.LOGGER.debug("Session initialized", { sid, enableJsonResponse: enableJson });
                this.sessions.set(sid, {
                    server: server,
                    transport: transport,
                    lastAccess: Date.now(),
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
