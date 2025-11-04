"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignToolToServer = assignToolToServer;
const utils_1 = require("./utils");
const logger_1 = require("../logger");
const constants_1 = require("./constants");
const zod_1 = require("zod");
const utils_2 = require("../auth/utils");
const elicited_input_1 = require("./elicited-input");
/* @ts-ignore */
const cds = global.cds || require("@sap/cds"); // This is a work around for missing cds context
/**
 * Registers a CAP function or action as an executable MCP tool
 * Handles both bound (entity-level) and unbound (service-level) operations
 * @param model - The tool annotation containing operation metadata and parameters
 * @param server - The MCP server instance to register the tool with
 */
function assignToolToServer(model, server, authEnabled) {
    logger_1.LOGGER.debug("Adding tool", model);
    const parameters = buildToolParameters(model.parameters, model.propertyHints);
    if (model.entityKey) {
        // Assign tool as bound operation
        assignBoundOperation(parameters, model, server, authEnabled);
        return;
    }
    assignUnboundOperation(parameters, model, server, authEnabled);
}
/**
 * Registers a bound operation that operates on a specific entity instance
 * Requires entity key parameters in addition to operation parameters
 * @param params - Zod schema definitions for operation parameters
 * @param model - Tool annotation with bound operation metadata
 * @param server - MCP server instance to register with
 */
function assignBoundOperation(params, model, server, authEnabled) {
    if (!model.keyTypeMap || model.keyTypeMap.size <= 0) {
        logger_1.LOGGER.error("Invalid tool assignment - missing key map for bound operation");
        throw new Error("Bound operation cannot be assigned to tool list, missing keys");
    }
    const keys = buildToolParameters(model.keyTypeMap, model.propertyHints);
    const useElicitInput = (0, elicited_input_1.isElicitInput)(model.elicits);
    const inputSchema = buildZodSchema({
        ...keys,
        ...(useElicitInput ? {} : params),
    });
    const elicitationRequests = (0, elicited_input_1.constructElicitationFunctions)(model, params);
    server.registerTool(model.name, {
        title: model.name,
        description: model.description,
        inputSchema: inputSchema,
    }, async (args) => {
        // Resolve from current CAP context; prefer global to align with Jest mocks
        const cdsMod = global.cds || cds;
        const servicesMap = cdsMod.services || (cdsMod.services = {});
        const service = servicesMap[model.serviceName];
        if (!service) {
            logger_1.LOGGER.error("Invalid CAP service - undefined");
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: constants_1.ERR_MISSING_SERVICE,
                    },
                ],
            };
        }
        const operationInput = {};
        const operationKeys = {};
        for (const [k, v] of Object.entries(args)) {
            if (model.keyTypeMap?.has(k)) {
                operationKeys[k] = v;
            }
            if (!model.parameters?.has(k))
                continue;
            operationInput[k] = v;
        }
        const elicitationResult = await (0, elicited_input_1.handleElicitationRequests)(elicitationRequests, server);
        if (elicitationResult?.earlyResponse) {
            return elicitationResult.earlyResponse;
        }
        const accessRights = (0, utils_2.getAccessRights)(authEnabled);
        const response = await service.tx({ user: accessRights }).send({
            event: model.target,
            entity: model.entityKey,
            data: elicitationResult?.data ?? operationInput,
            params: [operationKeys],
        });
        return (0, utils_1.asMcpResult)(response);
    });
}
/**
 * Registers an unbound operation that operates at the service level
 * Does not require entity keys, only operation parameters
 * @param params - Zod schema definitions for operation parameters
 * @param model - Tool annotation with unbound operation metadata
 * @param server - MCP server instance to register with
 */
function assignUnboundOperation(params, model, server, authEnabled) {
    const useElicitInput = (0, elicited_input_1.isElicitInput)(model.elicits);
    const inputSchema = buildZodSchema(useElicitInput ? {} : params);
    const elicitationRequests = (0, elicited_input_1.constructElicitationFunctions)(model, params);
    server.registerTool(model.name, {
        title: model.name,
        description: model.description,
        inputSchema: inputSchema,
    }, async (args) => {
        // Resolve from current CAP context; prefer global to align with Jest mocks
        const cdsMod = global.cds || cds;
        const servicesMap = cdsMod.services || (cdsMod.services = {});
        const service = servicesMap[model.serviceName];
        if (!service) {
            logger_1.LOGGER.error("Invalid CAP service - undefined");
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: constants_1.ERR_MISSING_SERVICE,
                    },
                ],
            };
        }
        const elicitationResult = await (0, elicited_input_1.handleElicitationRequests)(elicitationRequests, server);
        if (elicitationResult?.earlyResponse) {
            return elicitationResult.earlyResponse;
        }
        const accessRights = (0, utils_2.getAccessRights)(authEnabled);
        const response = await service
            .tx({ user: accessRights })
            .send(model.target, elicitationResult?.data ?? args);
        return (0, utils_1.asMcpResult)(response);
    });
}
/**
 * Converts a map of CDS parameter types to MCP parameter schema definitions
 * @param params - Map of parameter names to their CDS type strings
 * @returns Record of parameter names to Zod schema types
 */
function buildToolParameters(params, propertyHints) {
    if (!params || params.size <= 0)
        return {};
    const result = {};
    for (const [k, v] of params.entries()) {
        result[k] = (0, utils_1.determineMcpParameterType)(v)?.describe(propertyHints.get(k) ?? "");
    }
    return result;
}
/**
 * Constructs a complete Zod schema object for MCP tool input validation
 * @param params - Record of parameter names to Zod schema types
 * @returns Zod schema record suitable for MCP tool registration
 */
function buildZodSchema(params) {
    const schema = {};
    for (const [key, zodType] of Object.entries(params)) {
        // The parameter is already a Zod type from determineMcpParameterType
        if (zodType && typeof zodType === "object" && "describe" in zodType) {
            schema[key] = zodType;
        }
        else {
            // Fallback to string if not a valid Zod type
            schema[key] = zod_1.z.string().describe(`Parameter: ${key}`);
        }
    }
    return schema;
}
