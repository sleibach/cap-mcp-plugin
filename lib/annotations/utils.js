"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.splitDefinitionName = splitDefinitionName;
exports.containsMcpAnnotation = containsMcpAnnotation;
exports.containsRequiredAnnotations = containsRequiredAnnotations;
exports.containsRequiredElicitedParams = containsRequiredElicitedParams;
exports.isValidResourceAnnotation = isValidResourceAnnotation;
exports.isValidToolAnnotation = isValidToolAnnotation;
exports.isValidPromptsAnnotation = isValidPromptsAnnotation;
exports.determineResourceOptions = determineResourceOptions;
exports.parseResourceElements = parseResourceElements;
exports.parseOperationElements = parseOperationElements;
exports.parseEntityKeys = parseEntityKeys;
exports.parseCdsRestrictions = parseCdsRestrictions;
const constants_1 = require("./constants");
const logger_1 = require("../logger");
/**
 * Splits a definition name into service name and target
 * @param definition - The definition name to split
 * @returns Object containing serviceName and target
 */
function splitDefinitionName(definition) {
    if (definition?.length <= 0) {
        throw new Error("Invalid definition name. Cannot be split");
    }
    const splitted = definition.split(".");
    if (splitted.length <= 1) {
        return {
            serviceName: splitted[0],
            target: "",
        };
    }
    const target = splitted.pop();
    const serviceName = splitted.join(".");
    return {
        serviceName: serviceName,
        target: target ?? "",
    };
}
/**
 * Checks if a definition contains any MCP annotations
 * @param definition - The definition to check
 * @returns True if MCP annotations are found, false otherwise
 */
function containsMcpAnnotation(definition) {
    for (const key of Object.keys(definition)) {
        if (!key.includes(constants_1.MCP_ANNOTATION_KEY))
            continue;
        return true;
    }
    return false;
}
/**
 * Validates that required MCP annotations are present and valid
 * @param annotations - The annotation structure to validate
 * @returns True if valid, throws error if invalid
 * @throws Error if required annotations are missing
 */
function containsRequiredAnnotations(annotations) {
    if (annotations.definition?.kind === "service")
        return true;
    if (!annotations?.name || annotations.name.length <= 0) {
        throw new Error(`Invalid annotation '${annotations.definition?.target}' - Missing required property 'name'`);
    }
    if (!annotations?.description || annotations.description.length <= 0) {
        throw new Error("Invalid annotation - Missing required property 'description'");
    }
    return true;
}
/**
 * Validates that the required params for MCP elicited user input annotations are valid
 * @param annotations - The annotation structure to validate
 * @returns True if valid, throw error if invalid
 * @throws Error if required annotations are missing
 */
function containsRequiredElicitedParams(annotations) {
    if (!annotations.elicit)
        return true;
    const param = annotations.elicit;
    if (!param || param?.length <= 0) {
        throw new Error(`Invalid annotation '${annotations.target}' - Incomplete elicited user input`);
    }
    return true;
}
/**
 * Validates a resource annotation structure
 * @param annotations - The annotation structure to validate
 * @returns True if valid, throws error if invalid
 * @throws Error if resource annotation is invalid
 */
function isValidResourceAnnotation(annotations) {
    if (!annotations?.resource) {
        throw new Error(`Invalid annotation '${annotations.definition?.target}' - Missing required flag 'resource'`);
    }
    if (Array.isArray(annotations.resource)) {
        for (const el of annotations.resource) {
            if (constants_1.DEFAULT_ALL_RESOURCE_OPTIONS.has(el))
                continue;
            throw new Error(`Invalid annotation '${annotations.definition?.target}' - Invalid resource option: ${el}`);
        }
    }
    return true;
}
/**
 * Validates a tool annotation structure
 * @param annotations - The annotation structure to validate
 * @returns True if valid, throws error if invalid
 * @throws Error if tool annotation is invalid
 */
function isValidToolAnnotation(annotations) {
    if (!annotations?.tool) {
        throw new Error(`Invalid annotation '${annotations.definition?.target}' - Missing required flag 'tool'`);
    }
    return true;
}
/**
 * Validates a prompts annotation structure
 * @param annotations - The annotation structure to validate
 * @returns True if valid, throws error if invalid
 * @throws Error if prompts annotation is invalid
 */
function isValidPromptsAnnotation(annotations) {
    if (!annotations?.prompts) {
        throw new Error(`Invalid annotation '${annotations.definition?.target}' - Missing prompts annotations`);
    }
    for (const prompt of annotations.prompts) {
        if (!prompt.template || prompt.template.length <= 0) {
            throw new Error(`Invalid annotation '${annotations.definition?.target}' - Missing valid template`);
        }
        if (!prompt.name || prompt.name.length <= 0) {
            throw new Error(`Invalid annotation '${annotations.definition?.target}' - Missing valid name`);
        }
        if (!prompt.title || prompt.title.length <= 0) {
            throw new Error(`Invalid annotation '${annotations.definition?.target}' - Missing valid title`);
        }
        if (!prompt.role ||
            (prompt.role !== "user" && prompt.role !== "assistant")) {
            throw new Error(`Invalid annotation '${annotations.definition?.target}' - Role must be 'user' or 'assistant'`);
        }
        prompt.inputs?.forEach((el) => {
            if (!el.key || el.key.length <= 0) {
                throw new Error(`Invalid annotation '${annotations.definition?.target}' - missing input key`);
            }
            if (!el.type || el.type.length <= 0) {
                throw new Error(`Invalid annotation '${annotations.definition?.target}' - missing input type`);
            }
            // TODO: Verify the input type against valid data types
        });
    }
    return true;
}
/**
 * Determines resource options from annotation structure
 * @param annotations - The annotation structure to process
 * @returns Set of resource options, defaults to all options if not specified
 */
function determineResourceOptions(annotations) {
    if (!Array.isArray(annotations.resource))
        return constants_1.DEFAULT_ALL_RESOURCE_OPTIONS;
    return new Set(annotations.resource);
}
/**
 * Parses resource elements from a definition to extract properties and keys
 * @param definition - The definition to parse
 * @returns Object containing properties and resource keys maps
 */
function parseResourceElements(definition, model) {
    const properties = new Map();
    const resourceKeys = new Map();
    const propertyHints = new Map();
    const parseParam = (k, v, suffix) => {
        let result = "";
        if (typeof v.type !== "string") {
            const referencedType = parseTypedReference(v.type, model);
            result = `${referencedType}${suffix ?? ""}`;
        }
        else {
            result = `${v.type.replace("cds.", "")}${suffix ?? ""}`;
        }
        if (v[constants_1.MCP_HINT_ELEMENT]) {
            propertyHints.set(k, v[constants_1.MCP_HINT_ELEMENT]);
        }
        properties?.set(k, result);
        return result;
    };
    for (const [k, v] of Object.entries(definition.elements || {})) {
        if (v.items) {
            const result = parseParam(k, v.items, "Array");
            if (v[constants_1.MCP_HINT_ELEMENT]) {
                propertyHints.set(k, v[constants_1.MCP_HINT_ELEMENT]);
            }
            if (!v.key)
                continue;
            resourceKeys.set(k, result);
            continue;
        }
        const result = parseParam(k, v);
        if (!v.key || v.type === "cds.Association")
            continue;
        resourceKeys.set(k, result);
    }
    return {
        properties,
        resourceKeys,
        propertyHints,
    };
}
/**
 * Parses operation elements from annotation structure
 * @param annotations - The annotation structure to parse
 * @returns Object containing parameters and operation kind
 */
function parseOperationElements(annotations, model) {
    let parameters;
    const propertyHints = new Map();
    const parseParam = (k, v, suffix) => {
        if (typeof v.type !== "string") {
            const referencedType = parseTypedReference(v.type, model);
            parameters?.set(k, `${referencedType}${suffix ?? ""}`);
            return;
        }
        if (v[constants_1.MCP_HINT_ELEMENT]) {
            propertyHints.set(k, v[constants_1.MCP_HINT_ELEMENT]);
        }
        parameters?.set(k, `${v.type.replace("cds.", "")}${suffix ?? ""}`);
    };
    const params = annotations.definition["params"];
    if (params && Object.entries(params).length > 0) {
        parameters = new Map();
        for (const [k, v] of Object.entries(params)) {
            if (v.items) {
                parseParam(k, v.items, "Array");
                if (v[constants_1.MCP_HINT_ELEMENT]) {
                    propertyHints.set(k, v[constants_1.MCP_HINT_ELEMENT]);
                }
                continue;
            }
            parseParam(k, v);
        }
    }
    return {
        parameters,
        operationKind: annotations.definition.kind,
        propertyHints,
    };
}
/**
 * Recursively digs through the typed reference object of an operation parameter.
 * @param param
 * @param model
 * @returns string|undefined
 * @throws Error if nested type is not parseable
 */
function parseTypedReference(param, model) {
    if (!param || !param.ref) {
        throw new Error("Failed to parse nested type reference");
    }
    const referenceType = model.definitions?.[param.ref[0]].elements[param.ref[1]];
    return typeof referenceType?.type === "string"
        ? referenceType.type?.replace("cds.", "")
        : parseTypedReference(referenceType?.type, model);
}
/**
 * Parses entity keys from a definition
 * @param definition - The definition to parse keys from
 * @returns Map of key names to their types
 * @throws Error if invalid key type is found
 */
function parseEntityKeys(definition) {
    const result = new Map();
    if (!definition?.elements)
        return result; // If there is no defined elements, we exit early
    for (const [k, v] of Object.entries(definition.elements)) {
        if (!v.key)
            continue;
        if (!v.type) {
            logger_1.LOGGER.error("Invalid key type", k);
            throw new Error("Invalid key type found for bound operation");
        }
        result.set(k, v.type.replace("cds.", ""));
    }
    return result;
}
/**
 * Parses the CDS role restrictions to be used for MCP
 */
function parseCdsRestrictions(restrictions, requires) {
    if (!restrictions && !requires)
        return [];
    const result = [];
    if (requires) {
        result.push({
            role: requires,
        });
    }
    if (!restrictions || restrictions.length <= 0)
        return result;
    for (const el of restrictions) {
        const ops = mapOperationRestriction(el.grant);
        if (!el.to) {
            result.push({
                role: "authenticated-user",
                operations: ops,
            });
            continue;
        }
        const mapped = Array.isArray(el.to)
            ? el.to.map((to) => ({
                role: to,
                operations: ops,
            }))
            : [{ role: el.to, operations: ops }];
        result.push(...mapped);
    }
    return result;
}
/**
 * Maps the "grant" property from CdsRestriction to McpRestriction
 */
function mapOperationRestriction(cdsRestrictions) {
    if (!cdsRestrictions || cdsRestrictions.length <= 0) {
        return ["CREATE", "READ", "UPDATE", "DELETE"];
    }
    if (!Array.isArray(cdsRestrictions)) {
        return translateOperationRestriction(cdsRestrictions);
    }
    const result = [];
    for (const el of cdsRestrictions) {
        const translated = translateOperationRestriction(el);
        if (!translated || translated.length <= 0)
            continue;
        result.push(...translated);
    }
    return result;
}
function translateOperationRestriction(restrictionType) {
    switch (restrictionType) {
        case "CHANGE":
            return ["UPDATE"];
        case "WRITE":
            return ["CREATE", "UPDATE", "DELETE"];
        case "*":
            return ["CREATE", "READ", "UPDATE", "DELETE"];
        default:
            return [restrictionType];
    }
}
