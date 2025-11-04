"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignResourceToServer = assignResourceToServer;
const custom_resource_template_1 = require("./custom-resource-template");
const logger_1 = require("../logger");
const utils_1 = require("./utils");
const validation_1 = require("./validation");
const utils_2 = require("../auth/utils");
/* @ts-ignore */
const cds = global.cds || require("@sap/cds"); // This is a work around for missing cds context
async function resolveServiceInstance(serviceName) {
    const CDS = global.cds || cds;
    let svc = CDS.services?.[serviceName] || CDS.services?.[serviceName.toLowerCase()];
    if (svc)
        return svc;
    const providers = (CDS.service && CDS.service.providers) ||
        (CDS.services && CDS.services.providers) ||
        [];
    if (Array.isArray(providers)) {
        const found = providers.find((p) => p?.definition?.name === serviceName || p?.name === serviceName);
        if (found)
            return found;
    }
    // do not connect; rely on served providers only to avoid duplicate cds contexts
    return undefined;
}
/**
 * Registers a CAP entity as an MCP resource with optional OData query support
 * Creates either static or dynamic resources based on configured functionalities
 * @param model - The resource annotation containing entity metadata and query options
 * @param server - The MCP server instance to register the resource with
 */
function assignResourceToServer(model, server, authEnabled) {
    logger_1.LOGGER.debug("Adding resource", model);
    if (model.functionalities.size <= 0) {
        registerStaticResource(model, server, authEnabled);
        return;
    }
    // Dynamic resource registration
    const detailedDescription = (0, utils_1.writeODataDescriptionForResource)(model);
    const functionalities = Array.from(model.functionalities);
    // Using grouped query parameter format to fix MCP SDK URI matching issue
    // Format: {?param1,param2,param3} instead of {?param1}{?param2}{?param3}
    const templateParams = functionalities.length > 0 ? `{?${functionalities.join(",")}}` : "";
    const resourceTemplateUri = `odata://${model.serviceName}/${model.name}${templateParams}`;
    const template = new custom_resource_template_1.CustomResourceTemplate(resourceTemplateUri, {
        list: undefined,
    });
    server.registerResource(model.name, template, // Type assertion to bypass strict type checking - necessary due to broken URI parser in the MCP SDK
    { title: model.target, description: detailedDescription }, async (uri, variables) => {
        const queryParameters = variables;
        const service = await resolveServiceInstance(model.serviceName);
        if (!service) {
            logger_1.LOGGER.error(`Invalid service found for service '${model.serviceName}'`);
            throw new Error(`Invalid service found for service '${model.serviceName}'`);
        }
        // Create validator with entity properties
        const validator = new validation_1.ODataQueryValidator(model.properties);
        // Validate and build query with secure parameter handling
        let query;
        try {
            query = SELECT.from(model.target).limit(queryParameters.top
                ? validator.validateTop(queryParameters.top)
                : 100, queryParameters.skip
                ? validator.validateSkip(queryParameters.skip)
                : undefined);
            for (const [k, v] of Object.entries(queryParameters)) {
                if (!v || v.trim().length <= 0)
                    continue;
                switch (k) {
                    case "filter":
                        // BUG: If filter value is e.g. "filter=1234" the value 1234 will go through
                        const validatedFilter = validator.validateFilter(v);
                        const expression = (global.cds || cds).parse.expr(validatedFilter);
                        query.where(expression);
                        continue;
                    case "select":
                        const validatedColumns = validator.validateSelect(v);
                        query.columns(validatedColumns);
                        continue;
                    case "orderby":
                        const validatedOrderBy = validator.validateOrderBy(v);
                        query.orderBy(validatedOrderBy);
                        continue;
                    default:
                        continue;
                }
            }
        }
        catch (error) {
            logger_1.LOGGER.warn(`OData query validation failed for ${model.target}:`, error);
            return {
                contents: [
                    {
                        uri: uri.href,
                        text: `ERROR: Invalid query parameter - ${error instanceof validation_1.ODataValidationError ? error.message : "Invalid query syntax"}`,
                    },
                ],
            };
        }
        try {
            const accessRights = (0, utils_2.getAccessRights)(authEnabled);
            const response = await service.tx({ user: accessRights }).run(query);
            const result = response?.map((el) => (0, utils_1.applyOmissionFilter)(el, model));
            return {
                contents: [
                    {
                        uri: uri.href,
                        text: result ? JSON.stringify(result) : "",
                    },
                ],
            };
        }
        catch (e) {
            logger_1.LOGGER.error(`Failed to retrieve resource data for ${model.target}`, e);
            return {
                contents: [
                    {
                        uri: uri.href,
                        text: "ERROR: Failed to find data due to unexpected error",
                    },
                ],
            };
        }
    });
}
/**
 * Registers a static resource without OData query functionality
 * Used when no query functionalities are configured for the resource
 * @param model - The resource annotation with entity metadata
 * @param server - The MCP server instance to register with
 */
function registerStaticResource(model, server, authEnabled) {
    server.registerResource(model.name, `odata://${model.serviceName}/${model.name}`, { title: model.target, description: model.description }, async (uri, extra) => {
        const queryParameters = extra;
        const service = cds.services[model.serviceName];
        // Create validator even for static resources to validate top parameter
        const validator = new validation_1.ODataQueryValidator(model.properties);
        try {
            const query = SELECT.from(model.target).limit(queryParameters.top
                ? validator.validateTop(queryParameters.top)
                : 100);
            const accessRights = (0, utils_2.getAccessRights)(authEnabled);
            const response = await service.tx({ user: accessRights }).run(query);
            const result = response?.map((el) => (0, utils_1.applyOmissionFilter)(el, model));
            return {
                contents: [
                    {
                        uri: uri.href,
                        text: result ? JSON.stringify(result) : "",
                    },
                ],
            };
        }
        catch (error) {
            if (error instanceof validation_1.ODataValidationError) {
                logger_1.LOGGER.warn(`OData validation failed for static resource ${model.target}:`, error);
                return {
                    contents: [
                        {
                            uri: uri.href,
                            text: `ERROR: Invalid query parameter - ${error.message}`,
                        },
                    ],
                };
            }
            logger_1.LOGGER.error(`Failed to retrieve resource data for ${model.target}`, error);
            return {
                contents: [
                    {
                        uri: uri.href,
                        text: "ERROR: Failed to find data due to unexpected error",
                    },
                ],
            };
        }
    });
}
