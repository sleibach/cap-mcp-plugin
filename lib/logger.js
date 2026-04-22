"use strict";
/**
 * Logger instance for the CDS MCP plugin
 * Uses CAP's built-in logging system with "mcp" namespace.
 * Enable verbose output with: DEBUG=mcp cds watch
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOGGER = void 0;
/* @ts-ignore */
const cds = global.cds || require("@sap/cds"); // Work around for missing cds context
// In some test/mocked environments cds.log may not exist. Provide a no-op fallback.
const noop = () => { };
const fallbackLogger = { debug: noop, info: noop, warn: noop, error: noop };
let logger = fallbackLogger;
let draftLogger = fallbackLogger;
let authLogger = fallbackLogger;
try {
    if (typeof cds?.log === "function") {
        logger = cds.log("mcp");
        // Dedicated draft-lifecycle channel. Opt-in diagnostic noise — keeps
        // production logs quiet; enable with `DEBUG=mcp.draft cds watch` when
        // troubleshooting draft locking, composite-FK payloads, or activation
        // failures.
        draftLogger = cds.log("mcp.draft");
        // Dedicated auth-trace channel. Enable with `DEBUG=mcp.auth cds watch`
        // to see the principal CAP resolved on every MCP tool invocation
        // (id, roles, privileged flag, tenant, is_anonymous). Use this when
        // DRAFT_LOCKED / DRAFT_REQUIRED / 403s don't match the human you
        // expect to be driving the call.
        authLogger = cds.log("mcp.auth");
    }
}
catch { }
/**
 * Shared logger instance for all MCP plugin components.
 * Uses the "mcp" cds.log channel.
 */
exports.LOGGER = logger;
/**
 * Draft-scoped logger on the "mcp.draft" channel. Use for
 * per-operation diagnostics (entity, keys, user) without
 * cluttering the base channel.
 */
exports.DRAFT_LOGGER = draftLogger;
/**
 * Auth-scoped logger on the "mcp.auth" channel. Use when
 * the resolved MCP principal doesn't match the caller's
 * expectation — it prints a one-line snapshot of
 * cds.context.user (id, roles, tenant, privileged flag) on
 * every tool invocation.
 */
exports.AUTH_LOGGER = authLogger;
