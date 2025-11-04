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
    const accessRights = (0, utils_1.getAccessRights)(authEnabled);
    for (const entry of annotations.values()) {
        if (entry instanceof structures_1.McpToolAnnotation) {
            if (!(0, utils_1.hasToolOperationAccess)(accessRights, entry.restrictions))
                continue;
            (0, tools_1.assignToolToServer)(entry, server, authEnabled);
            continue;
        }
        else if (entry instanceof structures_1.McpResourceAnnotation) {
            const accesses = (0, utils_1.getWrapAccesses)(accessRights, entry.restrictions);
            if (accesses.canRead) {
                (0, resources_1.assignResourceToServer)(entry, server, authEnabled);
            }
            // Optionally expose entities as tools based on global/per-entity switches
            const globalWrap = !!config.wrap_entities_to_actions;
            const localWrap = entry.wrap?.tools;
            const enabled = localWrap === true || (localWrap === undefined && globalWrap);
            if (enabled) {
                const modes = entry.wrap?.modes ??
                    config.wrap_entity_modes ?? ["query", "get"];
                (0, entity_tools_1.registerEntityWrappers)(entry, server, authEnabled, modes, accesses);
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
