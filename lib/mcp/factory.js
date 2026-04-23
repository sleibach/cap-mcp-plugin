"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMcpServer = createMcpServer;
// @ts-ignore - MCP SDK types may not be present at compile time in all environments
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const logger_1 = require("../logger");
const structures_1 = require("../annotations/structures");
const tools_1 = require("./tools");
const resources_1 = require("./resources");
const prompts_1 = require("./prompts");
const utils_1 = require("../auth/utils");
// Use relative import without extension for ts-jest resolver compatibility
const entity_tools_1 = require("./entity-tools");
const describe_model_1 = require("./describe-model");
const instructions_1 = require("../config/instructions");
/**
 * Creates and configures an MCP server instance with the given configuration and annotations
 * @param config - CAP configuration object
 * @param annotations - Optional parsed annotations to register with the server
 * @returns Configured MCP server instance
 */
function createMcpServer(config, annotations) {
    logger_1.LOGGER.debug("Creating MCP server instance");
    const server = new mcp_js_1.McpServer({
        name: config.name,
        version: config.version,
        capabilities: config.capabilities,
    }, { instructions: (0, instructions_1.getMcpInstructions)(config) });
    if (!annotations) {
        logger_1.LOGGER.debug("No annotations provided, skipping registration...");
        return server;
    }
    logger_1.LOGGER.debug("Annotations found for server: ", annotations);
    const authEnabled = (0, utils_1.isAuthEnabled)(config.auth);
    // Always register discovery tool for better model planning
    (0, describe_model_1.registerDescribeModelTool)(server);
    // Always register the whoami introspection tool — needed for diagnosing
    // DRAFT_LOCKED and other principal-mismatch scenarios even when every
    // other tool would reject the caller.
    (0, describe_model_1.registerWhoAmITool)(server);
    
    // IMPORTANT: Do NOT filter tools/resources at server creation time
    // The user context may not be available during the initialize request
    // Instead, register ALL tools/resources and check authorization at execution time
    // This matches how CAP services handle authorization
    
    for (const entry of annotations.values()) {
        if (entry instanceof structures_1.McpToolAnnotation) {
            // Register tool without checking access rights at creation time
            // Authorization will be checked when the tool is executed
            const before = snapshotToolNames(server);
            (0, tools_1.assignToolToServer)(entry, server, authEnabled);
            installToolVisibilityGates(server, before, authEnabled, () => standaloneToolGate(entry.restrictions));
            continue;
        }
        else if (entry instanceof structures_1.McpResourceAnnotation) {
            // Register resource without checking access rights at creation time
            // Authorization will be checked when the resource is accessed
            (0, resources_1.assignResourceToServer)(entry, server, authEnabled);

            // Optionally expose entities as tools based on global/per-entity switches
            const globalWrap = !!config.wrap_entities_to_actions;
            const localWrap = entry.wrap?.tools;
            const enabled = localWrap === true || (localWrap === undefined && globalWrap);
            if (enabled) {
                const modes = entry.wrap?.modes ??
                    config.wrap_entity_modes ?? ["query", "get"];
                // Pass full accesses - authorization will be checked at execution time
                const fullAccesses = {
                    canRead: true,
                    canCreate: true,
                    canUpdate: true,
                    canDelete: true,
                };
                const before = snapshotToolNames(server);
                (0, entity_tools_1.registerEntityWrappers)(entry, server, authEnabled, modes, fullAccesses);
                installToolVisibilityGates(server, before, authEnabled, (toolName) => entityWrapperGate(entry.restrictions, toolName));
            }
            continue;
        }
        else if (entry instanceof structures_1.McpPromptAnnotation) {
            (0, prompts_1.assignPromptToServer)(entry, server);
            continue;
        }
        logger_1.LOGGER.warn("Invalid annotation entry - Cannot be parsed by MCP server, skipping...");
    }
    return server;
}
/**
 * Snapshot the set of tool names currently registered on the server. Used to
 * diff against the post-registration set so we can install visibility gates
 * only on the tools a given annotation contributed (entity wrappers register
 * several tools per resource — we need the concrete name list).
 */
function snapshotToolNames(server) {
    return new Set(Object.keys(server._registeredTools || {}));
}
/**
 * Installs per-tool `enabled` getters that consult the current caller's roles
 * at list-tools time. The SDK's ListTools handler re-reads `tool.enabled` on
 * every request (mcp.js:67-69), so a getter turns registration-time static
 * visibility into per-session dynamic visibility — exactly what we need to
 * stop `admin-*` tools from showing up for non-admin callers.
 *
 * Only runs when auth is enabled; with auth disabled there is no principal to
 * gate against and filtering would hide everything from localhost dev flows.
 */
function installToolVisibilityGates(server, before, authEnabled, gateFactory) {
    if (!authEnabled)
        return;
    const registry = server._registeredTools || {};
    for (const name of Object.keys(registry)) {
        if (before.has(name))
            continue;
        const tool = registry[name];
        if (!tool)
            continue;
        const predicate = gateFactory(name);
        if (!predicate)
            continue;
        let overrideEnabled; // honours explicit .disable()/.enable() from callers
        Object.defineProperty(tool, "enabled", {
            configurable: true,
            get() {
                if (overrideEnabled === false)
                    return false;
                // During the MCP initialize request cds.context.user is not yet
                // populated by the HTTP auth middleware — don't hide tools we
                // can't evaluate, or the client sees an empty tool list and
                // gives up. Real per-user filtering kicks in on later tools/list
                // requests once the middleware has attached the principal.
                const user = global.cds?.context?.user;
                if (!user)
                    return true;
                try {
                    return predicate(user);
                }
                catch {
                    return true;
                }
            },
            set(v) {
                overrideEnabled = v;
            },
        });
    }
}
/**
 * Predicate for a standalone MCP tool (action / function / explicit @mcp.tool)
 * — uses the same single-role membership check the execution-time guard does,
 * so the list and the call agree on who can invoke what.
 */
function standaloneToolGate(restrictions) {
    if (!restrictions || restrictions.length === 0)
        return null;
    return (user) => (0, utils_1.hasToolOperationAccess)(user, restrictions);
}
/**
 * Predicate for a wrapper tool (query/get/create/update/delete/draft-*) —
 * maps the tool-name suffix to one of the CRUD operation classes and defers
 * to getWrapAccesses, which already encodes the @restrict grant → operation
 * matrix. Draft sub-tools fold into CREATE/UPDATE by their effect on the
 * underlying row (draft-new creates, draft-edit/patch/activate/discard
 * update, draft-upsert covers both).
 */
function entityWrapperGate(restrictions, toolName) {
    if (!restrictions || restrictions.length === 0)
        return null;
    const mode = wrapperOperationForName(toolName);
    if (!mode)
        return null;
    return (user) => {
        const access = (0, utils_1.getWrapAccesses)(user, restrictions);
        if (mode === "READ")
            return !!access.canRead;
        if (mode === "CREATE")
            return !!access.canCreate;
        if (mode === "UPDATE")
            return !!access.canUpdate;
        if (mode === "DELETE")
            return !!access.canDelete;
        return true;
    };
}
function wrapperOperationForName(toolName) {
    if (toolName.endsWith("_query") || toolName.endsWith("_get"))
        return "READ";
    if (toolName.endsWith("_create") || toolName.endsWith("_draft-new"))
        return "CREATE";
    if (toolName.endsWith("_delete"))
        return "DELETE";
    if (toolName.endsWith("_update")
        || toolName.endsWith("_draft-edit")
        || toolName.endsWith("_draft-patch")
        || toolName.endsWith("_draft-activate")
        || toolName.endsWith("_draft-discard"))
        return "UPDATE";
    if (toolName.endsWith("_draft-upsert"))
        return "CREATE";
    return null;
}
