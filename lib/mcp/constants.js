"use strict";
/**
 * Constants used throughout the MCP (Model Context Protocol) implementation
 * Defines error messages, HTTP headers, and formatting constants
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEW_LINE = exports.MCP_SESSION_HEADER = exports.ERR_MISSING_SERVICE = void 0;
/**
 * Standard error message returned when a CAP service cannot be found or accessed
 * Used in tool execution when the target service is unavailable
 */
exports.ERR_MISSING_SERVICE = "Error: Service could not be found";
/**
 * HTTP header name used to identify MCP session IDs in requests
 * Client must include this header with a valid session ID for authenticated requests
 */
exports.MCP_SESSION_HEADER = "mcp-session-id";
/**
 * Newline character constant used for consistent text formatting
 * Used in resource descriptions and error message formatting
 */
exports.NEW_LINE = "\n";
