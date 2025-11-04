"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpPromptAnnotation = exports.McpToolAnnotation = exports.McpResourceAnnotation = exports.McpAnnotation = void 0;
/**
 * Base class for all MCP annotations that provides common properties
 * and functionality shared across different annotation types
 */
class McpAnnotation {
    /** The name identifier for this annotation */
    _name;
    /** AI agent readable description of what this annotation represents */
    _description;
    /** The target entity, function, or service element this annotation applies to */
    _target;
    /** The name of the CAP service this annotation belongs to */
    _serviceName;
    /** Auth roles by providing CDS that is required for use */
    _restrictions;
    /** Property hints to be used for inputs */
    _propertyHints;
    /**
     * Creates a new MCP annotation instance
     * @param name - Unique identifier for this annotation
     * @param description - Human-readable description
     * @param target - The target element this annotation applies to
     * @param serviceName - Name of the associated CAP service
     * @param restrictions - Roles required for the given annotation
     */
    constructor(name, description, target, serviceName, restrictions, propertyHints) {
        this._name = name;
        this._description = description;
        this._target = target;
        this._serviceName = serviceName;
        this._restrictions = restrictions;
        this._propertyHints = propertyHints;
    }
    /**
     * Gets the unique name identifier for this annotation
     * @returns The annotation name
     */
    get name() {
        return this._name;
    }
    /**
     * Gets the human-readable description of this annotation
     * @returns The annotation description
     */
    get description() {
        return this._description;
    }
    /**
     * Gets the target element this annotation applies to
     * @returns The target identifier
     */
    get target() {
        return this._target;
    }
    /**
     * Gets the name of the CAP service this annotation belongs to
     * @returns The service name
     */
    get serviceName() {
        return this._serviceName;
    }
    /**
     * Gets the list of roles required for access to the annotation.
     * If the list is empty, then all can access.
     * @returns List of required roles
     */
    get restrictions() {
        return this._restrictions;
    }
    /**
     * Gets a map of possible property hints to be used for resource/tool properties.
     * @returns Map of property hints
     */
    get propertyHints() {
        return this._propertyHints;
    }
}
exports.McpAnnotation = McpAnnotation;
/**
 * Annotation class for MCP resources that can be queried with OData parameters
 * Extends the base annotation with resource-specific configuration
 */
class McpResourceAnnotation extends McpAnnotation {
    /** Set of OData query functionalities enabled for this resource */
    _functionalities;
    /** Map of property names to their CDS types for validation */
    _properties;
    /** Map of resource key fields to their types */
    _resourceKeys;
    /** Optional wrapper configuration to expose this resource as tools */
    _wrap;
    /** Map of foreign keys property -> associated entity */
    _foreignKeys;
    /** Set of computed field names */
    _computedFields;
    /** List of omitted fields */
    _omittedFields;
    /**
     * Creates a new MCP resource annotation
     * @param name - Unique identifier for this resource
     * @param description - Human-readable description
     * @param target - The CAP entity this resource represents
     * @param serviceName - Name of the associated CAP service
     * @param functionalities - Set of enabled OData query options (filter, top, skip, etc.)
     * @param properties - Map of entity properties to their CDS types
     * @param resourceKeys - Map of key fields to their types
     * @param foreignKeys - Map of foreign keys used by entity
     * @param wrap - Wrap usage
     * @param restrictions - Optional restrictions based on CDS roles
     * @param computedFields - Optional set of fields that are computed and should be ignored in create scenarios
     * @param propertyHints - Optional map of hints for specific properties on resource
     * @param omittedFields - Optional set of fields that should be omitted from MCP entity
     */
    constructor(name, description, target, serviceName, functionalities, properties, resourceKeys, foreignKeys, wrap, restrictions, computedFields, propertyHints, omittedFields) {
        super(name, description, target, serviceName, restrictions ?? [], propertyHints ?? new Map());
        this._functionalities = functionalities;
        this._properties = properties;
        this._resourceKeys = resourceKeys;
        this._wrap = wrap;
        this._foreignKeys = foreignKeys;
        this._computedFields = computedFields;
        this._omittedFields = omittedFields;
    }
    /**
     * Gets the set of enabled OData query functionalities
     * @returns Set of available query options like 'filter', 'top', 'skip'
     */
    get functionalities() {
        return this._functionalities;
    }
    /**
     * Gets the map of foreign keys used withing the resource
     * @returns Map of foreign keys - property name -> associated entity
     */
    get foreignKeys() {
        return this._foreignKeys;
    }
    /**
     * Gets the map of entity properties to their CDS types
     * @returns Map of property names to type strings
     */
    get properties() {
        return this._properties;
    }
    /**
     * Gets the map of resource key fields to their types
     * @returns Map of key field names to type strings
     */
    get resourceKeys() {
        return this._resourceKeys;
    }
    /**
     * Gets the wrapper configuration for exposing this resource as tools
     */
    get wrap() {
        return this._wrap;
    }
    /**
     * Gets the computed fields if any are available
     */
    get computedFields() {
        return this._computedFields;
    }
    /**
     * Gets a set of fields/elements of the resource that should be omitted if any
     */
    get omittedFields() {
        return this._omittedFields;
    }
}
exports.McpResourceAnnotation = McpResourceAnnotation;
/**
 * Annotation class for MCP tools that represent executable CAP functions or actions
 * Can be either bound (entity-level) or unbound (service-level) operations
 */
class McpToolAnnotation extends McpAnnotation {
    /** Map of function parameters to their CDS types */
    _parameters;
    /** Entity key field name for bound operations */
    _entityKey;
    /** Type of operation: 'function' or 'action' */
    _operationKind;
    /** Map of key field names to their types for bound operations */
    _keyTypeMap;
    /** Elicited user input object */
    _elicits;
    /**
     * Creates a new MCP tool annotation
     * @param name - Unique identifier for this tool
     * @param description - Human-readable description
     * @param operation - The CAP function or action name
     * @param serviceName - Name of the associated CAP service
     * @param parameters - Optional map of function parameters to their types
     * @param entityKey - Optional entity key field for bound operations
     * @param operationKind - Optional operation type ('function' or 'action')
     * @param keyTypeMap - Optional map of key fields to types for bound operations
     * @param restrictions - Optional restrictions based on CDS roles
     * @param elicits - Optional elicited input requirement
     * @param propertyHints - Optional map of property hints for tool inputs
     */
    constructor(name, description, operation, serviceName, parameters, entityKey, operationKind, keyTypeMap, restrictions, elicits, propertyHints) {
        super(name, description, operation, serviceName, restrictions ?? [], propertyHints ?? new Map());
        this._parameters = parameters;
        this._entityKey = entityKey;
        this._operationKind = operationKind;
        this._keyTypeMap = keyTypeMap;
        this._elicits = elicits;
    }
    /**
     * Gets the map of function parameters to their CDS types
     * @returns Map of parameter names to type strings, or undefined if no parameters
     */
    get parameters() {
        return this._parameters;
    }
    /**
     * Gets the entity key field name for bound operations
     * @returns Entity key field name, or undefined for unbound operations
     */
    get entityKey() {
        return this._entityKey;
    }
    /**
     * Gets the operation kind (function or action)
     * @returns Operation type string, or undefined if not specified
     */
    get operationKind() {
        return this._operationKind;
    }
    /**
     * Gets the map of key field names to their types for bound operations
     * @returns Map of key fields to types, or undefined for unbound operations
     */
    get keyTypeMap() {
        return this._keyTypeMap;
    }
    /**
     * Gets the elicited user input if any is required for the tool
     * @returns Elicited user input object
     */
    get elicits() {
        return this._elicits;
    }
}
exports.McpToolAnnotation = McpToolAnnotation;
/**
 * Annotation class for MCP prompts that define reusable prompt templates
 * Applied at the service level to provide prompt templates with variable substitution
 */
class McpPromptAnnotation extends McpAnnotation {
    /** Array of prompt template definitions */
    _prompts;
    /**
     * Creates a new MCP prompt annotation
     * @param name - Unique identifier for this prompt collection
     * @param description - Human-readable description
     * @param serviceName - Name of the associated CAP service
     * @param prompts - Array of prompt template definitions
     */
    constructor(name, description, serviceName, prompts) {
        super(name, description, serviceName, serviceName, [], new Map());
        this._prompts = prompts;
    }
    /**
     * Gets the array of prompt template definitions
     * @returns Array of prompt templates with their inputs and templates
     */
    get prompts() {
        return this._prompts;
    }
}
exports.McpPromptAnnotation = McpPromptAnnotation;
