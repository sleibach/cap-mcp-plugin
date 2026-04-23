"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCP_EXPAND_PROP_KEY = exports.MCP_OMIT_PROP_KEY = exports.MCP_HINT_ELEMENT = exports.DEFAULT_ALL_RESOURCE_OPTIONS = exports.MCP_ANNOTATION_MAPPING = exports.MCP_ANNOTATION_KEY = void 0;
/**
 * MCP annotation constants and default configurations
 * Defines the standard annotation keys and default values used throughout the plugin
 */
/**
 * Base key used to identify MCP annotations in CDS definitions
 * All MCP annotations must start with this prefix
 */
exports.MCP_ANNOTATION_KEY = "@mcp";
/**
 * Mapping of the custom annotations + CDS specific annotations and their correlated mapping for MCP usage
 */
exports.MCP_ANNOTATION_MAPPING = new Map([
    ["@mcp.name", "name"],
    ["@mcp.description", "description"],
    ["@mcp.resource", "resource"],
    ["@mcp.tool", "tool"],
    ["@mcp.prompts", "prompts"],
    ["@mcp.wrap", "wrap"],
    ["@mcp.wrap.tools", "wrap.tools"],
    ["@mcp.wrap.modes", "wrap.modes"],
    ["@mcp.wrap.hint", "wrap.hint"],
    ["@mcp.wrap.hint.get", "wrap.hint.get"],
    ["@mcp.wrap.hint.query", "wrap.hint.query"],
    ["@mcp.wrap.hint.create", "wrap.hint.create"],
    ["@mcp.wrap.hint.update", "wrap.hint.update"],
    ["@mcp.wrap.hint.delete", "wrap.hint.delete"],
    // Draft-lifecycle hint keys. CDS flattens struct-literal keys in the CSN
    // (e.g. `hint: { ![draft-new]: '...' }` becomes "@mcp.wrap.hint.draft-new"),
    // so each lifecycle mode needs its own mapping entry. `constructHintMessage`
    // looks these up via ordered candidate lists (["draft-new", "create"] etc.).
    ["@mcp.wrap.hint.draft-new", "wrap.hint.draft-new"],
    ["@mcp.wrap.hint.draft-edit", "wrap.hint.draft-edit"],
    ["@mcp.wrap.hint.draft-patch", "wrap.hint.draft-patch"],
    ["@mcp.wrap.hint.draft-activate", "wrap.hint.draft-activate"],
    ["@mcp.wrap.hint.draft-discard", "wrap.hint.draft-discard"],
    ["@mcp.wrap.hint.draft-upsert", "wrap.hint.draft-upsert"],
    ["@mcp.elicit", "elicit"],
    ["@mcp.expand", "expand"],
    ["@requires", "requires"],
    ["@restrict", "restrict"],
]);
/**
 * Default set of all available OData query options for MCP resources
 * Used when @mcp.resource is set to `true` to enable all capabilities
 * Includes: $filter, $orderby, $top, $skip, $select, $expand
 */
exports.DEFAULT_ALL_RESOURCE_OPTIONS = new Set([
    "filter",
    "orderby",
    "top",
    "skip",
    "select",
    "expand",
]);
/**
 * Hint key for annotations made on specific properties/elements
 */
exports.MCP_HINT_ELEMENT = "@mcp.hint";
/**
 * MCP omit property annotation key
 */
exports.MCP_OMIT_PROP_KEY = "@mcp.omit";
/**
 * MCP expand behaviour annotation key (entity-level).
 * Accepted values: 'compositions' | 'none' | 'all' — overrides runtime default.
 */
exports.MCP_EXPAND_PROP_KEY = "@mcp.expand";
