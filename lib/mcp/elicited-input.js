"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isElicitInput = isElicitInput;
exports.constructElicitationFunctions = constructElicitationFunctions;
exports.handleElicitationRequests = handleElicitationRequests;
const zod_1 = require("zod");
/**
 * Message displayed to users when requesting input parameters
 */
const INPUT_MSG = "Please fill out the required parameters";
/**
 * Checks if the elicited input array contains an 'input' requirement
 * @param elicits - Array of elicit types or undefined
 * @returns True if 'input' elicitation is required, false otherwise
 */
function isElicitInput(elicits) {
    return elicits ? elicits.includes("input") : false;
}
/**
 * Constructs elicitation request parameters based on the tool annotation's elicit requirements
 * @param model - MCP tool annotation containing elicit configuration
 * @param params - Parameter definitions for the tool
 * @returns Array of elicit request parameters for MCP server
 * @throws Error if invalid elicitation type is encountered
 */
function constructElicitationFunctions(model, params) {
    const result = [];
    for (const el of model.elicits ?? []) {
        switch (el) {
            case "input":
                result.push(constructElicitInput(params));
                continue;
            case "confirm":
                result.push(contructElicitConfirm(model));
                continue;
            default:
                throw new Error("Invalid elicitation type");
        }
    }
    return result;
}
/**
 * Processes multiple elicitation requests sequentially and handles user responses
 * @param requests - Array of elicit request parameters or undefined
 * @param server - MCP server instance for making elicit calls
 * @returns Promise resolving to elicitation response with early exit or data
 */
async function handleElicitationRequests(requests, server) {
    if (!requests || requests.length <= 0) {
        return { earlyResponse: undefined };
    }
    let data = undefined;
    for (const req of requests) {
        const res = await server.server.elicitInput(req);
        const earlyResponse = handleElicitResponse(res);
        if (earlyResponse) {
            return { earlyResponse };
        }
        if (req.message === INPUT_MSG) {
            data = res.content;
        }
    }
    return {
        earlyResponse: undefined,
        data,
    };
}
/**
 * Converts elicit response action into appropriate MCP result
 * @param elicitResponse - Result from MCP server elicit input call
 * @returns MCP result for decline/cancel actions, undefined for accept
 * @throws Error if invalid response action is received
 */
function handleElicitResponse(elicitResponse) {
    switch (elicitResponse.action) {
        case "accept":
            return undefined;
        case "decline":
            return {
                content: [
                    {
                        type: "text",
                        text: "Action was declined.",
                    },
                ],
            };
        case "cancel":
            return {
                content: [
                    {
                        type: "text",
                        text: "Action was cancelled",
                    },
                ],
            };
        default:
            throw new Error("Invalid elicit response received");
    }
}
/**
 * Determines the schema type for elicit input based on Zod parameter type
 * @param param - Zod schema parameter to analyze
 * @returns Corresponding elicit schema type string
 * @throws Error if parameter type is not supported for elicitation
 */
function determineSchemaType(param) {
    if (param instanceof zod_1.z.ZodBoolean) {
        return "boolean";
    }
    else if (param instanceof zod_1.z.ZodString) {
        return "string";
    }
    else if (param instanceof zod_1.z.ZodNumber) {
        return "number";
    }
    throw new Error("Unsupported elicitation input type");
}
/**
 * Constructs confirmation elicit request for tool execution
 * @param model - MCP annotation model containing tool description
 * @returns Elicit request parameters for user confirmation
 */
function contructElicitConfirm(model) {
    return {
        message: `Please confirm that you want to perform action '${model.description}'`,
        requestedSchema: {
            type: "object",
            properties: {
                confirm: {
                    type: "boolean",
                    title: "Confirmation",
                    description: "Please confirm the action",
                },
            },
            required: ["confirm"],
        },
    };
}
/**
 * Constructs input elicit request for tool parameters
 * @param params - Tool parameters definition with Zod schemas
 * @returns Elicit request parameters for user input collection
 */
function constructElicitInput(params) {
    const elicitSpec = {
        message: INPUT_MSG,
        requestedSchema: {
            type: "object",
            properties: {},
            required: [],
        },
    };
    for (const [key, zodType] of Object.entries(params)) {
        elicitSpec.requestedSchema.required?.push(key);
        elicitSpec.requestedSchema.properties[key] = {
            type: determineSchemaType(zodType),
            title: key,
            description: key,
        };
    }
    return elicitSpec;
}
