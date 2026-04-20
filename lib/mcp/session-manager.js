"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemorySessionStore = void 0;
exports.DbSessionStore = void 0;
exports.StatelessSessionStore = void 0;
exports.McpSessionManager = void 0;
exports.createSessionStore = createSessionStore;
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const crypto_1 = require("crypto");
const env_sanitizer_1 = require("../config/env-sanitizer");
const logger_1 = require("../logger");
const factory_1 = require("./factory");
/* @ts-ignore */
const cds = global.cds || require("@sap/cds");
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
 * Shared constructor configuration for the StreamableHTTPServerTransport used
 * by both stores. The plugin relies on JSON response mode (enableJsonResponse)
 * so every POST /mcp is self-contained — this is what makes DB-backed session
 * sharing across instances feasible in the first place (SSE streams are
 * inherently sticky to the instance that opened them).
 */
function resolveEnableJson() {
    return (0, env_sanitizer_1.getSafeEnvVar)("MCP_ENABLE_JSON", "true") === "true" ||
        (0, env_sanitizer_1.isTestEnvironment)();
}

/** Factory shared by both stores to build a live server+transport pair. */
function buildServerAndTransport(config, annotations, sessionIdGenerator, onSessionInit) {
    const server = (0, factory_1.createMcpServer)(config, annotations);
    const enableJson = resolveEnableJson();
    const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
        sessionIdGenerator,
        enableJsonResponse: enableJson,
        onsessioninitialized: onSessionInit,
    });
    return { server, transport, enableJson };
}

/**
 * In-memory session store. Holds server/transport pairs in a per-process
 * Map. Keeps the exact behavior of the original McpSessionManager:
 *   - Sessions carry a last-access timestamp refreshed on every getSession
 *   - An interval sweeper removes sessions idle longer than TTL
 *   - A hard cap evicts the LRU session to prevent unbounded growth
 *
 * Suitable for single-instance deployments or any topology with sticky
 * routing. Multi-instance deployments behind a round-robin LB need the
 * DbSessionStore instead.
 */
class InMemorySessionStore {
    sessions;
    sweepTimer;
    constructor() {
        this.sessions = new Map();
        const sweepMs = Number((0, env_sanitizer_1.getSafeEnvVar)("CDS_MCP_SESSION_SWEEP_MS", String(DEFAULT_SESSION_SWEEP_MS))) || DEFAULT_SESSION_SWEEP_MS;
        this.sweepTimer = setInterval(() => this.reap(), sweepMs);
        this.sweepTimer?.unref?.();
    }
    getSessions() {
        return this.sessions;
    }
    async hasSession(sessionID) {
        return this.sessions.has(sessionID);
    }
    async getSession(sessionID) {
        if (!sessionID)
            return undefined;
        const session = this.sessions.get(sessionID);
        if (session) {
            session.lastAccess = Date.now();
        }
        return session;
    }
    async deleteSession(sessionID) {
        const session = this.sessions.get(sessionID);
        if (!session)
            return;
        this.sessions.delete(sessionID);
        void Promise.resolve().then(() => session.transport?.close?.()).catch(() => { });
        void Promise.resolve().then(() => session.server?.close?.()).catch(() => { });
    }
    async reap() {
        const ttl = Number((0, env_sanitizer_1.getSafeEnvVar)("CDS_MCP_SESSION_TTL_MS", String(DEFAULT_SESSION_TTL_MS))) || DEFAULT_SESSION_TTL_MS;
        const cutoff = Date.now() - ttl;
        let reaped = 0;
        for (const [sid, session] of this.sessions.entries()) {
            if ((session.lastAccess ?? 0) < cutoff) {
                this.sessions.delete(sid);
                reaped += 1;
                void Promise.resolve().then(() => session.transport?.close?.()).catch(() => { });
                void Promise.resolve().then(() => session.server?.close?.()).catch(() => { });
            }
        }
        if (reaped > 0) {
            logger_1.LOGGER.debug(`Session reaper removed ${reaped} idle session(s)`, { remaining: this.sessions.size });
        }
    }
    stop() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = undefined;
        }
    }
    async createSession(config, annotations) {
        logger_1.LOGGER.debug("Initialize session request received");
        this.enforceSessionCap();
        const { server, transport, enableJson } = buildServerAndTransport(config, annotations, () => (0, crypto_1.randomUUID)(), (sid) => {
            logger_1.LOGGER.debug("Session initialized", { sid, enableJsonResponse: enableJson });
            this.sessions.set(sid, { server, transport, lastAccess: Date.now() });
        });
        transport.onclose = () => {
            if (!enableJson) {
                this.onCloseSession(transport);
            }
        };
        await server.connect(transport);
        return { server, transport, lastAccess: Date.now() };
    }
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
            void Promise.resolve().then(() => evicted?.transport?.close?.()).catch(() => { });
            void Promise.resolve().then(() => evicted?.server?.close?.()).catch(() => { });
        }
    }
    onCloseSession(transport) {
        if (!transport.sessionId || !this.sessions.has(transport.sessionId)) {
            return;
        }
        this.sessions.delete(transport.sessionId);
    }
}
exports.InMemorySessionStore = InMemorySessionStore;

/**
 * DB-backed session store for multi-instance runtimes. Session IDs and their
 * last-access timestamps live in a CAP-managed entity (default
 * `cap.mcp.Sessions`, injected programmatically at model-loaded time, see
 * lib/mcp/session-model.js). Each instance keeps a local cache of live
 * server+transport pairs; when a request arrives for a session ID that's not
 * in the local cache, the store queries the DB and, if the row exists,
 * rehydrates a fresh transport that adopts that session ID.
 *
 * Transport rehydration relies on private fields of the MCP SDK's
 * StreamableHTTPServerTransport. With enableJsonResponse=true, handleRequest
 * is stateless per POST, so a freshly-constructed transport whose
 * `sessionId` and `_initialized` are set to the stored values can serve any
 * JSON-RPC method (tools/call, resources/list, ...) without having processed
 * the original `initialize` request. SSE mode is unsupported and rejected
 * at startup.
 */
class DbSessionStore {
    sessions;
    sweepTimer;
    entity;
    localCacheTtlMs;
    constructor(storeConfig) {
        this.sessions = new Map();
        this.entity = storeConfig?.entity || "cap.mcp.Sessions";
        this.localCacheTtlMs = Number(storeConfig?.local_cache_ttl_ms) || 10 * 60 * 1000;
        this._runtimeConfig = undefined;
        this._annotations = undefined;
        const sweepMs = Number((0, env_sanitizer_1.getSafeEnvVar)("CDS_MCP_SESSION_SWEEP_MS", String(DEFAULT_SESSION_SWEEP_MS))) || DEFAULT_SESSION_SWEEP_MS;
        this.sweepTimer = setInterval(() => this.reap(), sweepMs);
        this.sweepTimer?.unref?.();
    }
    /**
     * Seeded by the plugin in onLoaded (on 'serving'), so rehydration can
     * happen on any instance — including instances that never saw the
     * originating `initialize` request. Without this, a rehydrate on a
     * cold instance would fail with "rehydrate called before createSession
     * captured runtime config", which is exactly the multi-instance failure
     * mode the DB store is meant to prevent.
     */
    setRuntimeConfig(config, annotations) {
        this._runtimeConfig = config;
        this._annotations = annotations;
    }
    getSessions() {
        return this.sessions;
    }
    async hasSession(sessionID) {
        if (!sessionID)
            return false;
        if (this.sessions.has(sessionID))
            return true;
        try {
            const row = await cds.run(SELECT.one.from(this.entity).columns("session_id").where({ session_id: sessionID }));
            return !!row;
        }
        catch (e) {
            logger_1.LOGGER.error(`[SESSION-STORE] hasSession DB lookup failed for ${sessionID}: ${e?.message || e}`);
            return false;
        }
    }
    async getSession(sessionID) {
        if (!sessionID)
            return undefined;
        const local = this.sessions.get(sessionID);
        if (local) {
            local.lastAccess = Date.now();
            void this._touch(sessionID);
            return local;
        }
        // Cache miss — try to rehydrate from the DB row if present.
        let row;
        try {
            row = await cds.run(SELECT.one.from(this.entity).where({ session_id: sessionID }));
        }
        catch (e) {
            logger_1.LOGGER.error(`[SESSION-STORE] getSession DB lookup failed for ${sessionID}: ${e?.message || e}`);
            return undefined;
        }
        if (!row)
            return undefined;
        try {
            const session = await this._rehydrate(sessionID);
            this.sessions.set(sessionID, session);
            void this._touch(sessionID);
            logger_1.LOGGER.debug(`[SESSION-STORE] Rehydrated session ${sessionID} on this instance`);
            return session;
        }
        catch (e) {
            logger_1.LOGGER.error(`[SESSION-STORE] Rehydrate failed for ${sessionID}: ${e?.message || e}`);
            return undefined;
        }
    }
    async deleteSession(sessionID) {
        const local = this.sessions.get(sessionID);
        if (local) {
            this.sessions.delete(sessionID);
            void Promise.resolve().then(() => local.transport?.close?.()).catch(() => { });
            void Promise.resolve().then(() => local.server?.close?.()).catch(() => { });
        }
        try {
            await cds.run(DELETE.from(this.entity).where({ session_id: sessionID }));
        }
        catch (e) {
            logger_1.LOGGER.error(`[SESSION-STORE] deleteSession DB delete failed for ${sessionID}: ${e?.message || e}`);
        }
    }
    async reap() {
        const ttl = Number((0, env_sanitizer_1.getSafeEnvVar)("CDS_MCP_SESSION_TTL_MS", String(DEFAULT_SESSION_TTL_MS))) || DEFAULT_SESSION_TTL_MS;
        const cutoffMs = Date.now() - ttl;
        // Global reap: DELETE rows where last_access is older than TTL. Idempotent
        // across instances — any instance can run this safely.
        try {
            const cutoff = new Date(cutoffMs).toISOString();
            await cds.run(DELETE.from(this.entity).where`last_access < ${cutoff}`);
        }
        catch (e) {
            logger_1.LOGGER.debug(`[SESSION-STORE] Global DB reap skipped: ${e?.message || e}`);
        }
        // Local reap: close cached transports idle longer than local cache TTL.
        // The DB row may still be live — a future request just re-hydrates.
        const localCutoff = Date.now() - this.localCacheTtlMs;
        let evicted = 0;
        for (const [sid, session] of this.sessions.entries()) {
            if ((session.lastAccess ?? 0) < localCutoff) {
                this.sessions.delete(sid);
                evicted += 1;
                void Promise.resolve().then(() => session.transport?.close?.()).catch(() => { });
                void Promise.resolve().then(() => session.server?.close?.()).catch(() => { });
            }
        }
        if (evicted > 0) {
            logger_1.LOGGER.debug(`[SESSION-STORE] Local cache evicted ${evicted} idle transport(s)`, { remaining: this.sessions.size });
        }
    }
    stop() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = undefined;
        }
    }
    async createSession(config, annotations) {
        logger_1.LOGGER.debug("Initialize session request received (db store)");
        // Also refresh in case setRuntimeConfig wasn't called (belt & braces).
        this._runtimeConfig = config;
        this._annotations = annotations;
        const { server, transport, enableJson } = buildServerAndTransport(config, annotations, () => (0, crypto_1.randomUUID)(), async (sid) => {
            logger_1.LOGGER.debug("Session initialized (db store)", { sid, enableJsonResponse: enableJson });
            const now = Date.now();
            this.sessions.set(sid, { server, transport, lastAccess: now });
            const iso = new Date(now).toISOString();
            try {
                await cds.run(INSERT.into(this.entity).entries({
                    session_id: sid,
                    created_at: iso,
                    last_access: iso,
                }));
            }
            catch (e) {
                logger_1.LOGGER.error(`[SESSION-STORE] INSERT failed for ${sid}: ${e?.message || e}. Requests routed to other instances will be rejected.`);
            }
        });
        transport.onclose = () => {
            if (!enableJson) {
                this._onLocalClose(transport);
            }
        };
        await server.connect(transport);
        return { server, transport, lastAccess: Date.now() };
    }
    async _rehydrate(sessionId) {
        if (!this._runtimeConfig) {
            throw new Error("DbSessionStore.rehydrate called before runtime config was seeded. Ensure setRuntimeConfig is called in the plugin's 'serving' hook.");
        }
        const { server, transport } = buildServerAndTransport(this._runtimeConfig, this._annotations, () => sessionId, undefined);
        await server.connect(transport);
        // Force the transport to accept subsequent JSON-RPC requests for this
        // session without replaying the original `initialize`. The outer
        // StreamableHTTPServerTransport delegates sessionId to an inner
        // WebStandardStreamableHTTPServerTransport; set the state on the
        // inner instance if present (newer SDK), otherwise fall back to the
        // outer (older SDK). Both sessionId and _initialized are writable
        // instance fields on the web-standard transport.
        const inner = transport._webStandardTransport ?? transport;
        inner.sessionId = sessionId;
        inner._initialized = true;
        return { server, transport, lastAccess: Date.now() };
    }
    async _touch(sessionID) {
        try {
            const iso = new Date().toISOString();
            await cds.run(UPDATE(this.entity).set({ last_access: iso }).where({ session_id: sessionID }));
        }
        catch (e) {
            logger_1.LOGGER.debug(`[SESSION-STORE] last_access update skipped for ${sessionID}: ${e?.message || e}`);
        }
    }
    _onLocalClose(transport) {
        if (!transport.sessionId || !this.sessions.has(transport.sessionId))
            return;
        this.sessions.delete(transport.sessionId);
    }
}
exports.DbSessionStore = DbSessionStore;

/**
 * Stateless session store for deployments whose tools are pure CRUD/RPC with
 * no server-initiated notifications or subscriptions. `sessionIdGenerator` is
 * set to undefined so the MCP SDK does not issue or expect `Mcp-Session-Id`;
 * every POST /mcp is handled by a fresh server+transport pair and discarded.
 * Zero per-instance state, no DB dependency, trivially multi-instance safe.
 *
 * GET /mcp (SSE) and DELETE /mcp return 400 because no sessions exist to open
 * a stream on or close.
 */
class StatelessSessionStore {
    isStateless = true;
    getSessions() {
        return new Map();
    }
    async hasSession() {
        return false;
    }
    async getSession() {
        return undefined;
    }
    async createSession(config, annotations) {
        const enableJson = resolveEnableJson();
        const server = (0, factory_1.createMcpServer)(config, annotations);
        const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: enableJson,
        });
        await server.connect(transport);
        return { server, transport, lastAccess: Date.now() };
    }
    async deleteSession() {
        // nothing persisted; no-op
    }
    async reap() {
        // no state to reap
    }
    stop() {
        // no timers
    }
}
exports.StatelessSessionStore = StatelessSessionStore;

/**
 * Factory returning the configured session store.
 * Default is "db" so multi-instance deployments are safe out of the box.
 * Falls back to "memory" when no DB binding is present AND the user didn't
 * explicitly request "db". Explicit kind="db" with no DB binding fails fast
 * so misconfigured production deployments don't silently degrade.
 */
function createSessionStore(runtimeConfig) {
    const storeCfg = runtimeConfig?.session_store ?? {};
    const explicitKind = storeCfg.kind;
    const hasDbBinding = !!cds.env?.requires?.db;
    const VALID = new Set(["memory", "db", "stateless"]);
    // Resolve effective kind: explicit > db when bindable > memory.
    let kind;
    if (VALID.has(explicitKind)) {
        kind = explicitKind;
    }
    else {
        if (explicitKind !== undefined) {
            logger_1.LOGGER.warn(`[SESSION-STORE] Unknown session_store.kind='${explicitKind}', ignoring.`);
        }
        kind = hasDbBinding ? "db" : "memory";
        if (!hasDbBinding) {
            logger_1.LOGGER.debug(`[SESSION-STORE] No DB binding detected, defaulting to in-memory session store. Bind a database, set session_store.kind='db', or set session_store.kind='stateless' for multi-instance deployments without a DB.`);
        }
    }
    if (kind === "stateless") {
        const enableJson = resolveEnableJson();
        if (!enableJson) {
            throw new Error(`[SESSION-STORE] session_store.kind='stateless' requires enableJsonResponse (MCP_ENABLE_JSON=true). SSE streams depend on a persistent transport and are incompatible with stateless mode.`);
        }
        logger_1.LOGGER.info(`[SESSION-STORE] Stateless session store enabled (no session tracking, no DB dependency)`);
        return new StatelessSessionStore();
    }
    if (kind === "db") {
        if (!hasDbBinding) {
            throw new Error(`[SESSION-STORE] session_store.kind='db' requires a DB binding (cds.env.requires.db). Bind a database or switch to session_store.kind='memory' or session_store.kind='stateless'.`);
        }
        const enableJson = resolveEnableJson();
        if (!enableJson) {
            throw new Error(`[SESSION-STORE] session_store.kind='db' requires enableJsonResponse (MCP_ENABLE_JSON=true). SSE streams are sticky to one instance and cannot be rehydrated.`);
        }
        logger_1.LOGGER.info(`[SESSION-STORE] DB-backed session store enabled (entity=${storeCfg.entity ?? "cap.mcp.Sessions"})`);
        return new DbSessionStore(storeCfg);
    }
    logger_1.LOGGER.debug(`[SESSION-STORE] In-memory session store active`);
    return new InMemorySessionStore();
}

// Legacy alias kept so existing imports (e.g. `new McpSessionManager()`) still work.
exports.McpSessionManager = InMemorySessionStore;
