"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfiguration = loadConfiguration;
const logger_1 = require("../logger");
const env_sanitizer_1 = require("./env-sanitizer");
const json_parser_1 = require("./json-parser");
/* @ts-ignore */
const cds = global.cds || require("@sap/cds"); // This is a work around for missing cds context
const ENV_NPM_PACKAGE_NAME = "npm_package_name";
const ENV_NPM_PACKAGE_VERSION = "npm_package_version";
const DEFAULT_PROJECT_INFO = {
    name: "cap-mcp-server",
    version: "1.0.0",
};
/**
 * Loads CAP configuration from environment and CDS settings
 * @returns Complete CAP configuration object with defaults applied
 */
function loadConfiguration() {
    const packageInfo = getProjectInfo();
    const cdsEnv = loadCdsEnvConfiguration();
    return {
        name: cdsEnv?.name ?? packageInfo.name,
        version: cdsEnv?.version ?? packageInfo.version,
        auth: cdsEnv?.auth ?? "inherit",
        capabilities: {
            tools: cdsEnv?.capabilities?.tools ?? { listChanged: true },
            resources: cdsEnv?.capabilities?.resources ?? { listChanged: true },
            prompts: cdsEnv?.capabilities?.prompts ?? { listChanged: true },
        },
        wrap_entities_to_actions: cdsEnv?.wrap_entities_to_actions ?? false,
        wrap_entity_modes: cdsEnv?.wrap_entity_modes ?? [
            "query",
            "get",
            "create",
            "update",
        ],
        instructions: cdsEnv?.instructions,
    };
}
/**
 * Extracts project information from environment variables with fallback to defaults
 * Uses npm package environment variables to identify the hosting CAP application
 * @returns Project information object with name and version
 */
function getProjectInfo() {
    try {
        return {
            name: (0, env_sanitizer_1.getSafeEnvVar)(ENV_NPM_PACKAGE_NAME, DEFAULT_PROJECT_INFO.name),
            version: (0, env_sanitizer_1.getSafeEnvVar)(ENV_NPM_PACKAGE_VERSION, DEFAULT_PROJECT_INFO.version),
        };
    }
    catch (e) {
        logger_1.LOGGER.warn("Failed to dynamically load project info, reverting to defaults. Error: ", e);
        return DEFAULT_PROJECT_INFO;
    }
}
/**
 * Loads CDS environment configuration from cds.env.mcp
 * @returns CAP configuration object or undefined if not found/invalid
 */
function loadCdsEnvConfiguration() {
    const config = cds.env.mcp;
    if (!config)
        return undefined;
    else if (typeof config === "object")
        return config;
    // Use secure JSON parser for string configurations
    const parsed = (0, json_parser_1.parseCAPConfiguration)(config);
    if (!parsed) {
        logger_1.LOGGER.warn((0, json_parser_1.createSafeErrorMessage)("CDS environment configuration"));
        return undefined;
    }
    return parsed;
}
