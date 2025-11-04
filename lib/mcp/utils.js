"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.determineMcpParameterType = determineMcpParameterType;
exports.handleMcpSessionRequest = handleMcpSessionRequest;
exports.writeODataDescriptionForResource = writeODataDescriptionForResource;
exports.toolError = toolError;
exports.asMcpResult = asMcpResult;
exports.applyOmissionFilter = applyOmissionFilter;
const constants_1 = require("./constants");
const zod_1 = require("zod");
/* @ts-ignore */
const cds = global.cds || require("@sap/cds"); // This is a work around for missing cds context
/**
 * Converts a CDS type string to the corresponding Zod schema type
 * @param cdsType - The CDS type name (e.g., 'String', 'Integer')
 * @returns Zod schema instance for the given type
 */
function determineMcpParameterType(cdsType, key, target) {
    switch (cdsType) {
        case "String":
            return zod_1.z.string();
        case "UUID":
            return zod_1.z.string();
        case "Date":
            return zod_1.z.date();
        case "Time":
            return zod_1.z.date();
        case "DateTime":
            return zod_1.z.date();
        case "Timestamp":
            return zod_1.z.number();
        case "Integer":
            return zod_1.z.number();
        case "Int16":
            return zod_1.z.number();
        case "Int32":
            return zod_1.z.number();
        case "Int64":
            return zod_1.z.number();
        case "UInt8":
            return zod_1.z.number();
        case "Decimal":
            return zod_1.z.number();
        case "Double":
            return zod_1.z.number();
        case "Boolean":
            return zod_1.z.boolean();
        case "Binary":
            return zod_1.z.string();
        case "LargeBinary":
            return zod_1.z.string();
        case "LargeString":
            return zod_1.z.string();
        case "Map":
            return zod_1.z.object({});
        case "StringArray":
            return zod_1.z.array(zod_1.z.string());
        case "DateArray":
            return zod_1.z.array(zod_1.z.date());
        case "TimeArray":
            return zod_1.z.array(zod_1.z.date());
        case "DateTimeArray":
            return zod_1.z.array(zod_1.z.date());
        case "TimestampArray":
            return zod_1.z.array(zod_1.z.number());
        case "UUIDArray":
            return zod_1.z.array(zod_1.z.string());
        case "IntegerArray":
            return zod_1.z.array(zod_1.z.number());
        case "Int16Array":
            return zod_1.z.array(zod_1.z.number());
        case "Int32Array":
            return zod_1.z.array(zod_1.z.number());
        case "Int64Array":
            return zod_1.z.array(zod_1.z.number());
        case "UInt8Array":
            return zod_1.z.array(zod_1.z.number());
        case "DecimalArray":
            return zod_1.z.array(zod_1.z.number());
        case "BooleanArray":
            return zod_1.z.array(zod_1.z.boolean());
        case "DoubleArray":
            return zod_1.z.array(zod_1.z.number());
        case "BinaryArray":
            return zod_1.z.array(zod_1.z.string());
        case "LargeBinaryArray":
            return zod_1.z.array(zod_1.z.string());
        case "LargeStringArray":
            return zod_1.z.array(zod_1.z.string());
        case "MapArray":
            return zod_1.z.array(zod_1.z.object({}));
        case "Composition":
            return buildCompositionZodType(key, target);
        default:
            return zod_1.z.string();
    }
}
/**
 * Builds the complex ZodType for a CDS type of 'Composition'
 * @param key
 * @param target
 * @returns ZodType
 */
function buildCompositionZodType(key, target) {
    const model = cds.model;
    if (!model.definitions || !target || !key) {
        return zod_1.z.object({}); // fallback, might have to reconsider type later
    }
    const targetDef = model.definitions[target];
    const targetProp = targetDef.elements[key];
    const comp = model.definitions[targetProp.target];
    if (!comp) {
        return zod_1.z.object({});
    }
    const isArray = targetProp.cardinality !== undefined;
    const compProperties = new Map();
    for (const [k, v] of Object.entries(comp.elements)) {
        if (!v.type)
            continue;
        const elementKeys = new Map(Object.keys(v).map((el) => [el.toLowerCase(), el]));
        const isComputed = elementKeys.has("@core.computed") &&
            v[elementKeys.get("@core.computed") ?? ""] === true;
        if (isComputed)
            continue;
        // Check if this field is a foreign key to the parent entity in the composition
        // If so, exclude it because CAP will auto-fill it during deep insert
        const foreignKeyAnnotation = elementKeys.has("@odata.foreignkey4")
            ? elementKeys.get("@odata.foreignkey4")
            : null;
        if (foreignKeyAnnotation) {
            const associationName = v[foreignKeyAnnotation];
            // Check if the association references the parent entity
            if (associationName && comp.elements[associationName]) {
                const association = comp.elements[associationName];
                if (association.target === target) {
                    // This FK references the parent entity, exclude it from composition schema
                    continue;
                }
            }
        }
        const parsedType = v.type.replace("cds.", "");
        if (parsedType === "Association" || parsedType === "Composition")
            continue; // We will not support nested compositions for now
        const isOptional = !v.key && !v.notNull;
        const paramType = determineMcpParameterType(parsedType);
        compProperties.set(k, isOptional ? paramType.optional() : paramType);
    }
    const zodType = zod_1.z.object(Object.fromEntries(compProperties));
    return isArray ? zod_1.z.array(zodType) : zodType;
}
/**
 * Handles incoming MCP session requests by validating session IDs and routing to appropriate session
 * @param req - Express request object containing session headers
 * @param res - Express response object for sending responses
 * @param sessions - Map of active MCP sessions keyed by session ID
 */
async function handleMcpSessionRequest(req, res, sessions) {
    const sessionIdHeader = req.headers[constants_1.MCP_SESSION_HEADER];
    if (!sessionIdHeader || !sessions.has(sessionIdHeader)) {
        res.status(400).send("Invalid or missing session ID");
        return;
    }
    const session = sessions.get(sessionIdHeader);
    if (!session) {
        res.status(400).send("Invalid session");
        return;
    }
    await session.transport.handleRequest(req, res);
}
/**
 * Writes a detailed OData description for a resource including available query parameters and properties
 * @param model - The resource annotation to generate description for
 * @returns Formatted description string with OData query syntax examples
 */
function writeODataDescriptionForResource(model) {
    let description = `${model.description}.${constants_1.NEW_LINE}`;
    description += `Should be queried using OData v4 query style using the following allowed parameters.${constants_1.NEW_LINE}`;
    description += `Parameters: ${constants_1.NEW_LINE}`;
    if (model.functionalities.has("filter")) {
        description += `- filter: OData $filter syntax (e.g., "$filter=author_name eq 'Stephen King'")${constants_1.NEW_LINE}`;
    }
    if (model.functionalities.has("top")) {
        description += `- top: OData $top syntax (e.g., $top=10)${constants_1.NEW_LINE}`;
    }
    if (model.functionalities.has("skip")) {
        description += `- skip: OData $skip syntax (e.g., $skip=10)${constants_1.NEW_LINE}`;
    }
    if (model.functionalities.has("select")) {
        description += `- select: OData $select syntax (e.g., $select=property1,property2, etc..)${constants_1.NEW_LINE}`;
    }
    if (model.functionalities.has("orderby")) {
        description += `- orderby: OData $orderby syntax (e.g., "$orderby=property1 asc", or "$orderby=property1 desc")${constants_1.NEW_LINE}`;
    }
    description += `${constants_1.NEW_LINE}Available properties on ${model.target}: ${constants_1.NEW_LINE}`;
    for (const [key, type] of model.properties.entries()) {
        description += `- ${key} -> value type = ${type} ${constants_1.NEW_LINE}`;
    }
    return description;
}
/**
 * Unified MCP tool error response helper
 * Returns a consistent JSON error payload inside MCP content
 */
function toolError(code, message, extra) {
    const payload = { error: code, message, ...(extra || {}) };
    return {
        isError: true,
        content: [
            {
                type: "text",
                text: JSON.stringify(payload),
            },
        ],
    };
}
/**
 * Formats a payload as MCP result content with a single text part.
 * This ensures compatibility with all MCP clients.
 */
function asMcpResult(payload) {
    // Pretty-print for objects, stringify primitives, and split arrays into multiple parts
    const toText = (value) => {
        if (typeof value === "string")
            return value;
        if (value === undefined)
            return "undefined";
        try {
            if (value !== null && typeof value === "object") {
                return JSON.stringify(value, null, 2);
            }
            return String(value);
        }
        catch {
            // Circular structures fall back to default string conversion
            return String(value);
        }
    };
    if (Array.isArray(payload)) {
        if (payload.length === 0)
            return { content: [] };
        return {
            content: payload.map((item) => ({ type: "text", text: toText(item) })),
        };
    }
    return {
        content: [
            {
                type: "text",
                text: toText(payload),
            },
        ],
    };
}
/**
 * Applies the omit rules for the resulting object based on the annotations.
 * Creates a copy of the input object to avoid unwanted mutations.
 * @param res
 * @param annotations
 * @returns object|undefined
 */
function applyOmissionFilter(res, annotations) {
    if (!res)
        return res; // We do not want to parse something that does not exist
    else if (!annotations.omittedFields || annotations.omittedFields.size < 0) {
        return { ...res };
    }
    return Object.fromEntries(Object.entries(res).filter(([k, _]) => !annotations.omittedFields?.has(k)));
}
