"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDefinitions = parseDefinitions;
const logger_1 = require("../logger");
const structures_1 = require("./structures");
const utils_1 = require("./utils");
const constants_1 = require("./constants");
/**
 * Parses model definitions to extract MCP annotations and return them as a map of annotated entries
 * @param model - The CSN model containing definitions to parse
 * @returns A map of target names to their corresponding MCP annotation entries
 * @throws Error if model lacks valid definitions
 */
function parseDefinitions(model) {
    if (!model.definitions) {
        logger_1.LOGGER.error("Invalid model loaded", model);
        throw new Error("Cannot parse model without valid definitions");
    }
    const result = new Map();
    for (const [key, value] of Object.entries(model.definitions)) {
        // Narrow unknown to csn.Definition with a runtime check
        const def = value;
        const parsedAnnotations = parseAnnotations(def);
        const { serviceName, target } = (0, utils_1.splitDefinitionName)(key);
        parseBoundOperations(model, serviceName, target, def, result); // Mutates result map with bound operations
        if (!parsedAnnotations || !(0, utils_1.containsRequiredAnnotations)(parsedAnnotations)) {
            continue; // This check must occur here, since we do want the bound operations even if the parent is not annotated
        }
        // Set the target in annotations for error reporting
        if (parsedAnnotations) {
            parsedAnnotations.target = key;
        }
        if (!(0, utils_1.containsRequiredElicitedParams)(parsedAnnotations)) {
            continue; // Really doesn't do anything as the method will throw if the implementation is invalid
        }
        const verifiedAnnotations = parsedAnnotations;
        switch (def.kind) {
            case "entity":
                const resourceAnnotation = constructResourceAnnotation(serviceName, target, verifiedAnnotations, def, model);
                if (!resourceAnnotation)
                    continue;
                result.set(`${serviceName}.${target}`, resourceAnnotation);
                continue;
            case "function":
                const functionAnnotation = constructToolAnnotation(model, serviceName, target, verifiedAnnotations);
                if (!functionAnnotation)
                    continue;
                result.set(`${serviceName}.${target}`, functionAnnotation);
                continue;
            case "action":
                const actionAnnotation = constructToolAnnotation(model, serviceName, target, verifiedAnnotations);
                if (!actionAnnotation)
                    continue;
                result.set(`${serviceName}.${target}`, actionAnnotation);
                continue;
            case "service":
                const promptsAnnotation = constructPromptAnnotation(serviceName, verifiedAnnotations);
                if (!promptsAnnotation)
                    continue;
                result.set(promptsAnnotation.target, promptsAnnotation);
                continue;
            default:
                continue;
        }
    }
    return result;
}
function mapToMcpAnnotationStructure(obj) {
    const result = {};
    // Helper function to set nested properties
    const setNestedValue = (target, path, value) => {
        const keys = path.split(".");
        const lastKey = keys.pop();
        const nestedTarget = keys.reduce((current, key) => {
            if (!(key in current)) {
                current[key] = {};
            }
            return current[key];
        }, target);
        // If the target already has a value and both are objects, merge them
        if (typeof nestedTarget[lastKey] === "object" &&
            typeof value === "object" &&
            nestedTarget[lastKey] !== null &&
            value !== null &&
            !Array.isArray(nestedTarget[lastKey]) &&
            !Array.isArray(value)) {
            nestedTarget[lastKey] = { ...nestedTarget[lastKey], ...value };
        }
        else {
            nestedTarget[lastKey] = value;
        }
    };
    // Loop through object keys and map them
    for (const key in obj) {
        if (constants_1.MCP_ANNOTATION_MAPPING.has(key)) {
            const mappedPath = constants_1.MCP_ANNOTATION_MAPPING.get(key);
            setNestedValue(result, mappedPath, obj[key]);
        }
    }
    return result;
}
/**
 * Parses MCP annotations from a definition object
 * @param definition - The definition object to parse annotations from
 * @returns Partial annotation structure or undefined if no MCP annotations found
 */
function parseAnnotations(definition) {
    if (!(0, utils_1.containsMcpAnnotation)(definition))
        return undefined;
    const parsed = mapToMcpAnnotationStructure(definition);
    const annotations = {
        definition: definition,
        ...parsed,
    };
    return annotations;
}
/**
 * Constructs a resource annotation from parsed annotation data
 * @param serviceName - Name of the service containing the resource
 * @param target - Target entity name
 * @param annotations - Parsed annotation structure
 * @param definition - CSN definition object
 * @returns Resource annotation or undefined if invalid
 */
function constructResourceAnnotation(serviceName, target, annotations, definition, model) {
    if (!(0, utils_1.isValidResourceAnnotation)(annotations))
        return undefined;
    const entityTarget = `${serviceName}.${target}`;
    const functionalities = (0, utils_1.determineResourceOptions)(annotations);
    const foreignKeys = new Map(Object.entries(model.definitions?.[entityTarget].elements ?? {})
        .filter(([_, v]) => v["@odata.foreignKey4"] !== undefined)
        .map(([k, v]) => [k, v["@odata.foreignKey4"]]));
    const computedFields = new Set(Object.entries(model.definitions?.[entityTarget].elements ?? {})
        .filter(([_, v]) => new Map(Object.entries(v).map(([key, value]) => [key.toLowerCase(), value])).get("@core.computed"))
        .map(([k, _]) => k));
    console.log("I AM TRYING TO PARSE", model.definitions);
    const omittedFields = new Set(Object.entries(model.definitions?.[entityTarget].elements ?? {})
        .filter(([_, v]) => v[constants_1.MCP_OMIT_PROP_KEY])
        .map(([k, _]) => k));
    console.log("OMITTED FIELDS", omittedFields);
    const { properties, resourceKeys, propertyHints } = (0, utils_1.parseResourceElements)(definition, model);
    const restrictions = (0, utils_1.parseCdsRestrictions)(annotations.restrict, annotations.requires);
    return new structures_1.McpResourceAnnotation(annotations.name, annotations.description, target, serviceName, functionalities, properties, resourceKeys, foreignKeys, annotations.wrap, restrictions, computedFields, propertyHints, omittedFields);
}
/**
 * Constructs a tool annotation from parsed annotation data
 * @param serviceName - Name of the service containing the tool
 * @param target - Target operation name
 * @param annotations - Parsed annotation structure
 * @param entityKey - Optional entity key for bound operations
 * @param keyParams - Optional key parameters for bound operations
 * @returns Tool annotation or undefined if invalid
 */
function constructToolAnnotation(model, serviceName, target, annotations, entityKey, keyParams) {
    if (!(0, utils_1.isValidToolAnnotation)(annotations))
        return undefined;
    const { parameters, operationKind, propertyHints } = (0, utils_1.parseOperationElements)(annotations, model);
    const restrictions = (0, utils_1.parseCdsRestrictions)(annotations.restrict, annotations.requires);
    return new structures_1.McpToolAnnotation(annotations.name, annotations.description, target, serviceName, parameters, entityKey, operationKind, keyParams, restrictions, annotations.elicit, propertyHints);
}
/**
 * Constructs a prompt annotation from parsed annotation data
 * @param serviceName - Name of the service containing the prompts
 * @param annotations - Parsed annotation structure
 * @returns Prompt annotation or undefined if invalid
 */
function constructPromptAnnotation(serviceName, annotations) {
    if (!(0, utils_1.isValidPromptsAnnotation)(annotations))
        return undefined;
    return new structures_1.McpPromptAnnotation(annotations.name, annotations.description, serviceName, annotations.prompts);
}
/**
 * Parses bound operations (actions/functions) attached to an entity definition
 * Extracts MCP tool annotations from entity-level operations and adds them to the result map
 * @param serviceName - Name of the service containing the entity
 * @param entityKey - Name of the entity that owns these bound operations
 * @param definition - CSN entity definition containing bound operations
 * @param resultRef - Map to store parsed annotations (mutated by this function)
 */
function parseBoundOperations(model, serviceName, entityKey, definition, resultRef) {
    if (definition.kind !== "entity")
        return;
    const boundOperations = definition
        .actions; // NOTE: Necessary due to missing type reference in cds-types
    if (!boundOperations)
        return;
    const keyParams = (0, utils_1.parseEntityKeys)(definition);
    for (const [k, v] of Object.entries(boundOperations)) {
        if (v.kind !== "function" && v.kind !== "action")
            continue;
        const parsedAnnotations = parseAnnotations(v);
        // Set the target in annotations for error reporting
        if (parsedAnnotations) {
            parsedAnnotations.target = k;
        }
        if (!parsedAnnotations ||
            !(0, utils_1.containsRequiredAnnotations)(parsedAnnotations) ||
            !(0, utils_1.containsRequiredElicitedParams)(parsedAnnotations)) {
            continue;
        }
        const verifiedAnnotations = parsedAnnotations;
        const toolAnnotation = constructToolAnnotation(model, serviceName, k, verifiedAnnotations, entityKey, keyParams);
        if (!toolAnnotation)
            continue;
        resultRef.set(`${serviceName}.${entityKey}.${k}`, toolAnnotation);
    }
}
