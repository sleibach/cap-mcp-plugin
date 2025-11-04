"use strict";
/**
 * Logger instance for the CDS MCP plugin
 * Uses CAP's built-in logging system with "cds-mcp" namespace
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOGGER = void 0;
/* @ts-ignore */
const cds = global.cds || require("@sap/cds"); // This is a work around for missing cds context
// In some test/mocked environments cds.log may not exist. Provide a no-op fallback.
const safeLog = (ns) => {
    try {
        if (typeof cds?.log === "function")
            return cds.log(ns);
    }
    catch { }
    return {
        debug: () => { },
        info: () => { },
        warn: () => { },
        error: () => { },
    };
};
// Create both channels so logs show up even if the app configured "mcp" instead of "cds-mcp"
const loggerPrimary = safeLog("cds-mcp");
const loggerCompat = safeLog("mcp");
/**
 * Shared logger instance for all MCP plugin components
 * Multiplexes logs to both "cds-mcp" and legacy "mcp" channels for visibility
 */
exports.LOGGER = {
    debug: (...args) => {
        try {
            loggerPrimary?.debug?.(...args);
            loggerCompat?.debug?.(...args);
        }
        catch { }
    },
    info: (...args) => {
        try {
            loggerPrimary?.info?.(...args);
            loggerCompat?.info?.(...args);
        }
        catch { }
    },
    warn: (...args) => {
        try {
            loggerPrimary?.warn?.(...args);
            loggerCompat?.warn?.(...args);
        }
        catch { }
    },
    error: (...args) => {
        try {
            loggerPrimary?.error?.(...args);
            loggerCompat?.error?.(...args);
        }
        catch { }
    },
};
