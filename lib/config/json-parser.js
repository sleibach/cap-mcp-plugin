"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonParseError = exports.JsonParseErrorType = void 0;
exports.safeJsonParse = safeJsonParse;
exports.parseCAPConfiguration = parseCAPConfiguration;
exports.createSafeErrorMessage = createSafeErrorMessage;
const zod_1 = require("zod");
const logger_1 = require("../logger");
/**
 * Configuration schema for validation
 */
const CAPConfigurationSchema = zod_1.z.object({
    name: zod_1.z.string(),
    version: zod_1.z.string(),
    auth: zod_1.z.custom(),
    capabilities: zod_1.z.object({
        tools: zod_1.z.object({
            listChanged: zod_1.z.boolean().optional(),
        }),
        resources: zod_1.z.object({
            listChanged: zod_1.z.boolean().optional(),
            subscribe: zod_1.z.boolean().optional(),
        }),
        prompts: zod_1.z.object({
            listChanged: zod_1.z.boolean().optional(),
        }),
    }),
});
/**
 * Error types for JSON parsing failures
 */
var JsonParseErrorType;
(function (JsonParseErrorType) {
    JsonParseErrorType["INVALID_INPUT"] = "INVALID_INPUT";
    JsonParseErrorType["PARSE_ERROR"] = "PARSE_ERROR";
    JsonParseErrorType["VALIDATION_ERROR"] = "VALIDATION_ERROR";
})(JsonParseErrorType || (exports.JsonParseErrorType = JsonParseErrorType = {}));
/**
 * Custom error class for JSON parsing failures
 */
class JsonParseError extends Error {
    type;
    details;
    constructor(type, message, details) {
        super(message);
        this.type = type;
        this.details = details;
        this.name = "JsonParseError";
    }
}
exports.JsonParseError = JsonParseError;
/**
 * Validates basic JSON structure without parsing
 * @param input - JSON string to validate
 * @returns True if basic structure is valid
 */
function hasValidJsonStructure(input) {
    // Check for balanced braces and brackets
    let braceCount = 0;
    let bracketCount = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (inString)
            continue;
        switch (char) {
            case "{":
                braceCount++;
                break;
            case "}":
                braceCount--;
                break;
            case "[":
                bracketCount++;
                break;
            case "]":
                bracketCount--;
                break;
        }
        // Early detection of imbalanced brackets
        if (braceCount < 0 || bracketCount < 0) {
            return false;
        }
    }
    return braceCount === 0 && bracketCount === 0 && !inString;
}
/**
 * Safely parses JSON with comprehensive security checks
 * @param input - JSON string to parse
 * @param schema - Zod schema for validation
 * @returns Parsed and validated object or null if parsing fails
 */
function safeJsonParse(input, schema) {
    try {
        // Input validation
        if (typeof input !== "string") {
            throw new JsonParseError(JsonParseErrorType.INVALID_INPUT, "Input must be a string", `Received: ${typeof input}`);
        }
        // Trim whitespace
        const trimmed = input.trim();
        if (trimmed.length === 0) {
            throw new JsonParseError(JsonParseErrorType.INVALID_INPUT, "Input is empty or contains only whitespace");
        }
        // Basic structure validation
        if (!hasValidJsonStructure(trimmed)) {
            throw new JsonParseError(JsonParseErrorType.PARSE_ERROR, "Invalid JSON structure detected");
        }
        // Parse JSON
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch (error) {
            throw new JsonParseError(JsonParseErrorType.PARSE_ERROR, "JSON parsing failed", error instanceof Error ? error.message : "Unknown parse error");
        }
        // Schema validation
        const validationResult = schema.safeParse(parsed);
        if (!validationResult.success) {
            throw new JsonParseError(JsonParseErrorType.VALIDATION_ERROR, "JSON does not match expected schema", validationResult.error.message);
        }
        return validationResult.data;
    }
    catch (error) {
        if (error instanceof JsonParseError) {
            // Log detailed error for debugging (without exposing to user)
            logger_1.LOGGER.warn(`Safe JSON parsing failed: ${error.type}`, {
                message: error.message,
                details: error.details,
            });
        }
        else {
            // Unexpected error
            logger_1.LOGGER.warn("Unexpected error during JSON parsing", error);
        }
        return null;
    }
}
/**
 * Safely parses CAP configuration JSON
 * @param input - JSON string containing CAP configuration
 * @returns Parsed CAPConfiguration or null if parsing fails
 */
function parseCAPConfiguration(input) {
    return safeJsonParse(input, CAPConfigurationSchema);
}
/**
 * Creates a generic error message for user-facing errors
 * @param context - Context where the error occurred
 * @returns Generic error message that doesn't expose sensitive information
 */
function createSafeErrorMessage(context) {
    return `Configuration parsing failed in ${context}. Please check the configuration format.`;
}
