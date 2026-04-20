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
try {
    if (typeof cds?.log === "function") {
        logger = cds.log("mcp");
    }
}
catch { }
/**
 * Shared logger instance for all MCP plugin components.
 * Uses the "mcp" cds.log channel.
 */
exports.LOGGER = logger;
