"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerEntityWrappers = registerEntityWrappers;
const zod_1 = require("zod");
const utils_1 = require("../auth/utils");
const logger_1 = require("../logger");
const utils_2 = require("./utils");
/**
 * Wraps a promise with a timeout to avoid indefinite hangs in MCP tool calls.
 * Ensures we always either resolve within the expected time or fail gracefully.
 */
async function withTimeout(promise, ms, label, onTimeout) {
    let timeoutId;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(async () => {
                    try {
                        await onTimeout?.();
                    }
                    catch { }
                    reject(new Error(`${label} timed out after ${ms}ms`));
                }, ms);
            }),
        ]);
    }
    finally {
        if (timeoutId)
            clearTimeout(timeoutId);
    }
}
/**
 * Attempts to find a running CAP service instance for the given service name.
 * - Checks the in-memory services registry first
 * - Falls back to known service providers (when available)
 * Note: We deliberately avoid creating new connections here to not duplicate contexts.
 */
async function resolveServiceInstance(serviceName) {
    const CDS = global.cds;
    // Direct lookup (both exact and lowercase variants)
    let svc = CDS.services?.[serviceName] || CDS.services?.[serviceName.toLowerCase()];
    if (svc)
        return svc;
    // Look through known service providers
    const providers = (CDS.service && CDS.service.providers) ||
        (CDS.services && CDS.services.providers) ||
        [];
    if (Array.isArray(providers)) {
        const found = providers.find((p) => p?.definition?.name === serviceName ||
            p?.name === serviceName ||
            (typeof p?.path === "string" &&
                p.path.includes(serviceName.toLowerCase())));
        if (found)
            return found;
    }
    // Last resort: connect by name
    // Do not attempt to require/connect another cds instance; rely on app runtime only
    return undefined;
}
// NOTE: We use plain entity names (service projection) for queries.
const MAX_TOP = 200;
const TIMEOUT_MS = 10_000; // Standard timeout for tool calls (ms)
// Map OData operators to CDS/SQL operators for better performance and readability
const ODATA_TO_CDS_OPERATORS = new Map([
    ["eq", "="],
    ["ne", "!="],
    ["gt", ">"],
    ["ge", ">="],
    ["lt", "<"],
    ["le", "<="],
]);
/**
 * Builds enhanced query tool description with field types and association examples
 */
function buildEnhancedQueryDescription(resAnno) {
    const associations = Array.from(resAnno.properties.entries())
        .filter(([, cdsType]) => String(cdsType).toLowerCase().includes("association"))
        .map(([name]) => `${name}_ID`);
    const baseDesc = `Query ${resAnno.target} with structured filters, select, orderby, top/skip.`;
    const assocHint = associations.length > 0
        ? ` IMPORTANT: For associations, always use foreign key fields (${associations.join(", ")}) - never use association names directly.`
        : "";
    return baseDesc + assocHint;
}
/**
 * Registers CRUD-like MCP tools for an annotated entity (resource).
 * Modes can be controlled globally via configuration and per-entity via @mcp.wrap.
 *
 * Example tool names (naming is explicit for easier LLM usage):
 *   Service_Entity_query, Service_Entity_get, Service_Entity_create, Service_Entity_update, Service_Entity_delete
 */
function registerEntityWrappers(resAnno, server, authEnabled, defaultModes, accesses) {
    const CDS = global.cds;
    logger_1.LOGGER.debug(`[REGISTRATION TIME] Registering entity wrappers for ${resAnno.serviceName}.${resAnno.target}, available services:`, Object.keys(CDS.services || {}));
    const modes = resAnno.wrap?.modes ?? defaultModes;
    if (modes.includes("query") && accesses.canRead) {
        registerQueryTool(resAnno, server, authEnabled);
    }
    if (modes.includes("get") &&
        resAnno.resourceKeys &&
        resAnno.resourceKeys.size > 0 &&
        accesses.canRead) {
        registerGetTool(resAnno, server, authEnabled);
    }
    if (modes.includes("create") && accesses.canCreate) {
        registerCreateTool(resAnno, server, authEnabled);
    }
    if (modes.includes("update") &&
        resAnno.resourceKeys &&
        resAnno.resourceKeys.size > 0 &&
        accesses.canUpdate) {
        registerUpdateTool(resAnno, server, authEnabled);
    }
    if (modes.includes("delete") &&
        resAnno.resourceKeys &&
        resAnno.resourceKeys.size > 0 &&
        accesses.canDelete) {
        registerDeleteTool(resAnno, server, authEnabled);
    }
}
/**
 * Builds the visible tool name for a given operation mode.
 * We prefer a descriptive naming scheme that is easy for humans and LLMs:
 *   Service_Entity_mode
 */
function nameFor(service, entity, suffix) {
    // Use explicit Service_Entity_suffix naming to match docs/tests
    const entityName = entity.split(".").pop(); // keep original case
    const serviceName = service.split(".").pop(); // keep original case
    return `${serviceName}_${entityName}_${suffix}`;
}
/**
 * Registers the list/query tool for an entity.
 * Supports select/where/orderby/top/skip and simple text search (q).
 */
function registerQueryTool(resAnno, server, authEnabled) {
    const toolName = nameFor(resAnno.serviceName, resAnno.target, "query");
    // Structured input schema for queries with guard for empty property lists
    const allKeys = Array.from(resAnno.properties.keys());
    const scalarKeys = Array.from(resAnno.properties.entries())
        .filter(([k, cdsType]) => !String(cdsType).toLowerCase().includes("association") &&
        !resAnno.omittedFields?.has(k))
        .map(([name]) => name);
    // Build where field enum: use same fields as select (scalar + foreign keys)
    // This ensures consistency - what you can select, you can filter by
    const whereKeys = [...scalarKeys];
    const whereFieldEnum = (whereKeys.length
        ? zod_1.z.enum(whereKeys)
        : zod_1.z
            .enum(["__dummy__"])
            .transform(() => "__dummy__"));
    const selectFieldEnum = (scalarKeys.length
        ? zod_1.z.enum(scalarKeys)
        : zod_1.z
            .enum(["__dummy__"])
            .transform(() => "__dummy__"));
    const inputZod = zod_1.z
        .object({
        top: zod_1.z
            .number()
            .int()
            .min(1)
            .max(MAX_TOP)
            .default(25)
            .describe("Rows (default 25)"),
        skip: zod_1.z.number().int().min(0).default(0).describe("Offset"),
        select: zod_1.z
            .array(selectFieldEnum)
            .optional()
            .transform((val) => val && val.length > 0 ? val : undefined)
            .describe(`Select/orderby allow only scalar fields: ${scalarKeys.join(", ")}`),
        orderby: zod_1.z
            .array(zod_1.z.object({
            field: selectFieldEnum,
            dir: zod_1.z.enum(["asc", "desc"]).default("asc"),
        }))
            .optional()
            .transform((val) => val && val.length > 0 ? val : undefined),
        where: zod_1.z
            .array(zod_1.z.object({
            field: whereFieldEnum.describe(`FILTERABLE FIELDS: ${scalarKeys.join(", ")}. For associations use foreign key (author_ID), NOT association name (author).`),
            op: zod_1.z.enum([
                "eq",
                "ne",
                "gt",
                "ge",
                "lt",
                "le",
                "contains",
                "startswith",
                "endswith",
                "in",
            ]),
            value: zod_1.z.union([
                zod_1.z.string(),
                zod_1.z.number(),
                zod_1.z.boolean(),
                zod_1.z.array(zod_1.z.union([zod_1.z.string(), zod_1.z.number()])),
            ]),
        }))
            .optional()
            .transform((val) => val && val.length > 0 ? val : undefined),
        q: zod_1.z.string().optional().describe("Quick text search"),
        return: zod_1.z.enum(["rows", "count", "aggregate"]).default("rows").optional(),
        aggregate: zod_1.z
            .array(zod_1.z.object({
            field: selectFieldEnum,
            fn: zod_1.z.enum(["sum", "avg", "min", "max", "count"]),
        }))
            .optional()
            .transform((val) => (val && val.length > 0 ? val : undefined)),
        explain: zod_1.z.boolean().optional(),
    })
        .strict();
    const inputSchema = {
        top: inputZod.shape.top,
        skip: inputZod.shape.skip,
        select: inputZod.shape.select,
        orderby: inputZod.shape.orderby,
        where: inputZod.shape.where,
        q: inputZod.shape.q,
        return: inputZod.shape.return,
        aggregate: inputZod.shape.aggregate,
        explain: inputZod.shape.explain,
    };
    const hint = constructHintMessage(resAnno, "query");
    const desc = `Resource description: ${resAnno.description}. ${buildEnhancedQueryDescription(resAnno)} CRITICAL: Use foreign key fields (e.g., author_ID) for associations - association names (e.g., author) won't work in filters.` +
        hint;
    const queryHandler = async (rawArgs) => {
        const parsed = inputZod.safeParse(rawArgs);
        if (!parsed.success) {
            return (0, utils_2.toolError)("INVALID_INPUT", "Query arguments failed validation", {
                issues: parsed.error.issues,
            });
        }
        const args = parsed.data;
        const CDS = global.cds;
        logger_1.LOGGER.debug(`[EXECUTION TIME] Query tool: Looking for service: ${resAnno.serviceName}, available services:`, Object.keys(CDS.services || {}));
        const svc = await resolveServiceInstance(resAnno.serviceName);
        if (!svc) {
            const msg = `Service not found: ${resAnno.serviceName}. Available: ${Object.keys(CDS.services || {}).join(", ")}`;
            logger_1.LOGGER.error(msg);
            return (0, utils_2.toolError)("ERR_MISSING_SERVICE", msg);
        }
        let q;
        try {
            q = buildQuery(CDS, args, resAnno, allKeys);
        }
        catch (e) {
            return (0, utils_2.toolError)("FILTER_PARSE_ERROR", e?.message || String(e));
        }
        try {
            const t0 = Date.now();
            const response = await withTimeout(executeQuery(CDS, svc, args, q), TIMEOUT_MS, toolName);
            const result = response?.map((obj) => (0, utils_2.applyOmissionFilter)(obj, resAnno));
            logger_1.LOGGER.debug(`[EXECUTION TIME] Query tool completed: ${toolName} in ${Date.now() - t0}ms`, { resultKind: args.return ?? "rows" });
            return (0, utils_2.asMcpResult)(args.explain ? { data: result, plan: undefined } : result);
        }
        catch (error) {
            const msg = `QUERY_FAILED: ${error?.message || String(error)}`;
            logger_1.LOGGER.error(msg, error);
            return (0, utils_2.toolError)("QUERY_FAILED", msg);
        }
    };
    server.registerTool(toolName, { title: toolName, description: desc, inputSchema }, queryHandler);
}
/**
 * Registers the get-by-keys tool for an entity.
 * Accepts keys either as an object or shorthand (single-key) value.
 */
function registerGetTool(resAnno, server, authEnabled) {
    const toolName = nameFor(resAnno.serviceName, resAnno.target, "get");
    const inputSchema = {};
    for (const [k, cdsType] of resAnno.resourceKeys.entries()) {
        inputSchema[k] = (0, utils_2.determineMcpParameterType)(cdsType).describe(`Key ${k}. ${resAnno.propertyHints.get(k) ?? ""}`);
    }
    const keyList = Array.from(resAnno.resourceKeys.keys()).join(", ");
    const hint = constructHintMessage(resAnno, "get");
    const desc = `Resource description: ${resAnno.description}. Get one ${resAnno.target} by key(s): ${keyList}. For fields & examples call cap_describe_model.${hint}`;
    const getHandler = async (args) => {
        const startTime = Date.now();
        const CDS = global.cds;
        logger_1.LOGGER.debug(`[EXECUTION TIME] Get tool invoked: ${toolName}`, { args });
        const svc = await resolveServiceInstance(resAnno.serviceName);
        if (!svc) {
            const msg = `Service not found: ${resAnno.serviceName}. Available: ${Object.keys(CDS.services || {}).join(", ")}`;
            logger_1.LOGGER.error(msg);
            return (0, utils_2.toolError)("ERR_MISSING_SERVICE", msg);
        }
        // Normalize single-key shorthand, case-insensitive keys, and value-only payloads
        let normalizedArgs = args;
        if (resAnno.resourceKeys.size === 1) {
            const onlyKey = Array.from(resAnno.resourceKeys.keys())[0];
            if (normalizedArgs == null ||
                typeof normalizedArgs !== "object" ||
                Array.isArray(normalizedArgs)) {
                normalizedArgs = { [onlyKey]: normalizedArgs };
            }
            else if (normalizedArgs[onlyKey] === undefined &&
                normalizedArgs.value !== undefined) {
                normalizedArgs[onlyKey] = normalizedArgs.value;
            }
            else if (normalizedArgs[onlyKey] === undefined) {
                const alt = Object.entries(normalizedArgs).find(([kk]) => String(kk).toLowerCase() === String(onlyKey).toLowerCase());
                if (alt)
                    normalizedArgs[onlyKey] = normalizedArgs[alt[0]];
            }
        }
        const keys = {};
        for (const [k] of resAnno.resourceKeys.entries()) {
            let provided = normalizedArgs[k];
            if (provided === undefined) {
                const alt = Object.entries(normalizedArgs || {}).find(([kk]) => String(kk).toLowerCase() === String(k).toLowerCase());
                if (alt)
                    provided = normalizedArgs[alt[0]];
            }
            if (provided === undefined) {
                logger_1.LOGGER.warn(`Get tool missing required key`, { key: k, toolName });
                return (0, utils_2.toolError)("MISSING_KEY", `Missing key '${k}'`);
            }
            const raw = provided;
            keys[k] =
                typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
        }
        logger_1.LOGGER.debug(`Executing READ on ${resAnno.target} with keys`, keys);
        try {
            let response = await withTimeout(svc.run(svc.read(resAnno.target, keys)), TIMEOUT_MS, `${toolName}`);
            logger_1.LOGGER.debug(`[EXECUTION TIME] Get tool completed: ${toolName} in ${Date.now() - startTime}ms`, { found: !!response });
            const result = (0, utils_2.applyOmissionFilter)(response, resAnno);
            return (0, utils_2.asMcpResult)(result ?? null);
        }
        catch (error) {
            const msg = `GET_FAILED: ${error?.message || String(error)}`;
            logger_1.LOGGER.error(msg, error);
            return (0, utils_2.toolError)("GET_FAILED", msg);
        }
    };
    server.registerTool(toolName, { title: toolName, description: desc, inputSchema }, getHandler);
}
/**
 * Registers the create tool for an entity.
 * Associations are exposed via <assoc>_ID fields for simplicity.
 */
function registerCreateTool(resAnno, server, authEnabled) {
    const toolName = nameFor(resAnno.serviceName, resAnno.target, "create");
    const inputSchema = {};
    for (const [propName, cdsType] of resAnno.properties.entries()) {
        const isAssociation = String(cdsType).toLowerCase().includes("association");
        const isComputed = resAnno.computedFields?.has(propName);
        if (isAssociation || isComputed) {
            // Association keys are supplied directly from model loading as of v1.1.2
            continue;
        }
        inputSchema[propName] = (0, utils_2.determineMcpParameterType)(cdsType, propName, `${resAnno.serviceName}.${resAnno.target}`)
            .optional()
            .describe(resAnno.foreignKeys.has(propName)
            ? `Foreign key to ${resAnno.foreignKeys.get(propName)} on ${propName}. ${resAnno.propertyHints.get(propName) ?? ""}`
            : `Field ${propName}. ${resAnno.propertyHints.get(propName) ?? ""}`);
    }
    const hint = constructHintMessage(resAnno, "create");
    const desc = `Resource description: ${resAnno.description}. Create a new ${resAnno.target}. Provide fields; service applies defaults.${hint}`;
    const createHandler = async (args) => {
        const CDS = global.cds;
        const { INSERT } = CDS.ql;
        const svc = await resolveServiceInstance(resAnno.serviceName);
        if (!svc) {
            const msg = `Service not found: ${resAnno.serviceName}. Available: ${Object.keys(CDS.services || {}).join(", ")}`;
            logger_1.LOGGER.error(msg);
            return (0, utils_2.toolError)("ERR_MISSING_SERVICE", msg);
        }
        // Build data object from provided args, limited to known properties
        // Normalize payload: prefer *_ID for associations and coerce numeric strings
        const data = {};
        for (const [propName, cdsType] of resAnno.properties.entries()) {
            const isAssociation = String(cdsType)
                .toLowerCase()
                .includes("association");
            if (isAssociation) {
                const fkName = `${propName}_ID`;
                if (args[fkName] !== undefined) {
                    const val = args[fkName];
                    data[fkName] =
                        typeof val === "string" && /^\d+$/.test(val) ? Number(val) : val;
                }
                continue;
            }
            if (args[propName] !== undefined) {
                const val = args[propName];
                data[propName] =
                    typeof val === "string" && /^\d+$/.test(val) ? Number(val) : val;
            }
        }
        const tx = svc.tx({ user: (0, utils_1.getAccessRights)(authEnabled) });
        try {
            const response = await withTimeout(tx.run(INSERT.into(resAnno.target).entries(data)), TIMEOUT_MS, toolName, async () => {
                try {
                    await tx.rollback();
                }
                catch { }
            });
            try {
                await tx.commit();
            }
            catch { }
            const result = (0, utils_2.applyOmissionFilter)(response, resAnno);
            return (0, utils_2.asMcpResult)(result ?? {});
        }
        catch (error) {
            try {
                await tx.rollback();
            }
            catch { }
            const isTimeout = String(error?.message || "").includes("timed out");
            const msg = isTimeout
                ? `${toolName} timed out after ${TIMEOUT_MS}ms`
                : `CREATE_FAILED: ${error?.message || String(error)}`;
            logger_1.LOGGER.error(msg, error);
            return (0, utils_2.toolError)(isTimeout ? "TIMEOUT" : "CREATE_FAILED", msg);
        }
    };
    server.registerTool(toolName, { title: toolName, description: desc, inputSchema }, createHandler);
}
/**
 * Registers the update tool for an entity.
 * Keys are required; non-key fields are optional. Associations via <assoc>_ID.
 */
function registerUpdateTool(resAnno, server, authEnabled) {
    const toolName = nameFor(resAnno.serviceName, resAnno.target, "update");
    const inputSchema = {};
    // Keys required
    for (const [k, cdsType] of resAnno.resourceKeys.entries()) {
        inputSchema[k] = (0, utils_2.determineMcpParameterType)(cdsType).describe(`Key ${k}. ${resAnno.propertyHints.get(k) ?? ""}`);
    }
    // Other fields optional
    for (const [propName, cdsType] of resAnno.properties.entries()) {
        if (resAnno.resourceKeys.has(propName))
            continue;
        const isComputed = resAnno.computedFields?.has(propName);
        const isAssociation = String(cdsType).toLowerCase().includes("association");
        if (isAssociation || isComputed) {
            // Association keys are supplied directly from model loading as of v1.1.2
            continue;
        }
        inputSchema[propName] = (0, utils_2.determineMcpParameterType)(cdsType, propName, `${resAnno.serviceName}.${resAnno.target}`)
            .optional()
            .describe(resAnno.foreignKeys.has(propName)
            ? `Foreign key to ${resAnno.foreignKeys.get(propName)} on ${propName}. ${resAnno.propertyHints.get(propName) ?? ""}`
            : `Field ${propName}. ${resAnno.propertyHints.get(propName) ?? ""}`);
    }
    const keyList = Array.from(resAnno.resourceKeys.keys()).join(", ");
    const hint = constructHintMessage(resAnno, "update");
    const desc = `Resource description: ${resAnno.description}. Update ${resAnno.target} by key(s): ${keyList}. Provide fields to update.${hint}`;
    const updateHandler = async (args) => {
        const CDS = global.cds;
        const { UPDATE } = CDS.ql;
        const svc = await resolveServiceInstance(resAnno.serviceName);
        if (!svc) {
            const msg = `Service not found: ${resAnno.serviceName}. Available: ${Object.keys(CDS.services || {}).join(", ")}`;
            logger_1.LOGGER.error(msg);
            return (0, utils_2.toolError)("ERR_MISSING_SERVICE", msg);
        }
        // Extract keys and update fields
        const keys = {};
        for (const [k] of resAnno.resourceKeys.entries()) {
            if (args[k] === undefined) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Missing key '${k}'` }],
                };
            }
            keys[k] = args[k];
        }
        // Normalize updates: prefer *_ID for associations and coerce numeric strings
        const updates = {};
        for (const [propName, cdsType] of resAnno.properties.entries()) {
            if (resAnno.resourceKeys.has(propName))
                continue;
            const isAssociation = String(cdsType)
                .toLowerCase()
                .includes("association");
            if (isAssociation) {
                const fkName = `${propName}_ID`;
                if (args[fkName] !== undefined) {
                    const val = args[fkName];
                    updates[fkName] =
                        typeof val === "string" && /^\d+$/.test(val) ? Number(val) : val;
                }
                continue;
            }
            if (args[propName] !== undefined) {
                const val = args[propName];
                updates[propName] =
                    typeof val === "string" && /^\d+$/.test(val) ? Number(val) : val;
            }
        }
        if (Object.keys(updates).length === 0) {
            return (0, utils_2.toolError)("NO_FIELDS", "No fields provided to update");
        }
        const tx = svc.tx({ user: (0, utils_1.getAccessRights)(authEnabled) });
        try {
            const response = await withTimeout(tx.run(UPDATE(resAnno.target).set(updates).where(keys)), TIMEOUT_MS, toolName, async () => {
                try {
                    await tx.rollback();
                }
                catch { }
            });
            try {
                await tx.commit();
            }
            catch { }
            const result = (0, utils_2.applyOmissionFilter)(response, resAnno);
            return (0, utils_2.asMcpResult)(result ?? {});
        }
        catch (error) {
            try {
                await tx.rollback();
            }
            catch { }
            const isTimeout = String(error?.message || "").includes("timed out");
            const msg = isTimeout
                ? `${toolName} timed out after ${TIMEOUT_MS}ms`
                : `UPDATE_FAILED: ${error?.message || String(error)}`;
            logger_1.LOGGER.error(msg, error);
            return (0, utils_2.toolError)(isTimeout ? "TIMEOUT" : "UPDATE_FAILED", msg);
        }
    };
    server.registerTool(toolName, { title: toolName, description: desc, inputSchema }, updateHandler);
}
/**
 * Registers the delete tool for an entity.
 * Requires keys to identify the entity to delete.
 */
function registerDeleteTool(resAnno, server, authEnabled) {
    const toolName = nameFor(resAnno.serviceName, resAnno.target, "delete");
    const inputSchema = {};
    // Keys required for deletion
    for (const [k, cdsType] of resAnno.resourceKeys.entries()) {
        inputSchema[k] = (0, utils_2.determineMcpParameterType)(cdsType).describe(`Key ${k}. ${resAnno.propertyHints.get(k) ?? ""}`);
    }
    const keyList = Array.from(resAnno.resourceKeys.keys()).join(", ");
    const hint = constructHintMessage(resAnno, "delete");
    const desc = `Resource description: ${resAnno.description}. Delete ${resAnno.target} by key(s): ${keyList}. This operation cannot be undone.${hint}`;
    const deleteHandler = async (args) => {
        const CDS = global.cds;
        const { DELETE } = CDS.ql;
        const svc = await resolveServiceInstance(resAnno.serviceName);
        if (!svc) {
            const msg = `Service not found: ${resAnno.serviceName}. Available: ${Object.keys(CDS.services || {}).join(", ")}`;
            logger_1.LOGGER.error(msg);
            return (0, utils_2.toolError)("ERR_MISSING_SERVICE", msg);
        }
        // Extract keys - similar to get/update handlers
        const keys = {};
        for (const [k] of resAnno.resourceKeys.entries()) {
            let provided = args[k];
            if (provided === undefined) {
                // Case-insensitive key matching (like in get handler)
                const alt = Object.entries(args || {}).find(([kk]) => String(kk).toLowerCase() === String(k).toLowerCase());
                if (alt)
                    provided = args[alt[0]];
            }
            if (provided === undefined) {
                logger_1.LOGGER.warn(`Delete tool missing required key`, { key: k, toolName });
                return (0, utils_2.toolError)("MISSING_KEY", `Missing key '${k}'`);
            }
            // Coerce numeric strings (like in get handler)
            const raw = provided;
            keys[k] =
                typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
        }
        logger_1.LOGGER.debug(`Executing DELETE on ${resAnno.target} with keys`, keys);
        const tx = svc.tx({ user: (0, utils_1.getAccessRights)(authEnabled) });
        try {
            const response = await withTimeout(tx.run(DELETE.from(resAnno.target).where(keys)), TIMEOUT_MS, toolName, async () => {
                try {
                    await tx.rollback();
                }
                catch { }
            });
            try {
                await tx.commit();
            }
            catch { }
            return (0, utils_2.asMcpResult)(response ?? { deleted: true });
        }
        catch (error) {
            try {
                await tx.rollback();
            }
            catch { }
            const isTimeout = String(error?.message || "").includes("timed out");
            const msg = isTimeout
                ? `${toolName} timed out after ${TIMEOUT_MS}ms`
                : `DELETE_FAILED: ${error?.message || String(error)}`;
            logger_1.LOGGER.error(msg, error);
            return (0, utils_2.toolError)(isTimeout ? "TIMEOUT" : "DELETE_FAILED", msg);
        }
    };
    server.registerTool(toolName, { title: toolName, description: desc, inputSchema }, deleteHandler);
}
// Helper: compile structured inputs into a CDS query
// The function translates the validated MCP input into CQN safely,
// including a basic escape of string literals to avoid invalid syntax.
function buildQuery(CDS, args, resAnno, propKeys) {
    const { SELECT } = CDS.ql;
    const limitTop = args.top ?? 25;
    const limitSkip = args.skip ?? 0;
    let qy = SELECT.from(resAnno.target).limit(limitTop, limitSkip);
    if ((propKeys?.length ?? 0) === 0)
        return qy;
    if (args.select?.length) {
        qy = qy.columns(...args.select);
    }
    if (args.orderby?.length) {
        // Map to CQN-compatible order by fragments
        const orderFragments = args.orderby.map((o) => `${o.field} ${o.dir}`);
        qy = qy.orderBy(...orderFragments);
    }
    if ((typeof args.q === "string" && args.q.length > 0) || args.where?.length) {
        const ands = [];
        if (args.q) {
            const textFields = Array.from(resAnno.properties.keys()).filter((k) => /string/i.test(String(resAnno.properties.get(k))));
            const escaped = String(args.q).replace(/'/g, "''");
            const ors = textFields.map((f) => `contains(${f}, '${escaped}')`);
            if (ors.length) {
                const orExpr = ors.map((x) => `(${x})`).join(" or ");
                ands.push(CDS.parse.expr(orExpr));
            }
        }
        for (const c of args.where || []) {
            const { field, op, value } = c;
            // Field names are now consistent - use them directly
            const actualField = field;
            if (op === "in" && Array.isArray(value)) {
                const list = value
                    .map((v) => typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v))
                    .join(",");
                ands.push(CDS.parse.expr(`${actualField} in (${list})`));
                continue;
            }
            const lit = typeof value === "string"
                ? `'${String(value).replace(/'/g, "''")}'`
                : String(value);
            // Map OData operators to CDS/SQL operators
            const cdsOp = ODATA_TO_CDS_OPERATORS.get(op) ?? op;
            const expr = ["contains", "startswith", "endswith"].includes(op)
                ? `${op}(${actualField}, ${lit})`
                : `${actualField} ${cdsOp} ${lit}`;
            ands.push(CDS.parse.expr(expr));
        }
        if (ands.length) {
            // Apply each condition individually - CDS will AND them together
            for (const condition of ands) {
                qy = qy.where(condition);
            }
        }
    }
    return qy;
}
// Helper: execute query supporting return=count/aggregate
// Supports three modes:
// - rows (default): returns the selected rows
// - count: returns { count: number }
// - aggregate: returns aggregation result rows based on provided definitions
async function executeQuery(CDS, svc, args, baseQuery) {
    const { SELECT } = CDS.ql;
    switch (args.return) {
        case "count": {
            const countQuery = SELECT.from(baseQuery.SELECT.from)
                .columns("count(1) as count")
                .where(baseQuery.SELECT.where)
                .limit(baseQuery.SELECT.limit?.rows?.val, baseQuery.SELECT.limit?.offset?.val)
                .orderBy(baseQuery.SELECT.orderBy);
            const result = await svc.run(countQuery);
            const row = Array.isArray(result) ? result[0] : result;
            return { count: row?.count ?? 0 };
        }
        case "aggregate": {
            if (!args.aggregate?.length)
                return [];
            const cols = args.aggregate.map((a) => `${a.fn}(${a.field}) as ${a.fn}_${a.field}`);
            const aggQuery = SELECT.from(baseQuery.SELECT.from)
                .columns(...cols)
                .where(baseQuery.SELECT.where)
                .limit(baseQuery.SELECT.limit?.rows?.val, baseQuery.SELECT.limit?.offset?.val)
                .orderBy(baseQuery.SELECT.orderBy);
            return await svc.run(aggQuery);
        }
        default:
            return await svc.run(baseQuery);
    }
}
function constructHintMessage(resAnno, wrapAction) {
    if (!resAnno.wrap?.hint) {
        return "";
    }
    else if (typeof resAnno.wrap.hint === "string") {
        return ` Hint: ${resAnno.wrap?.hint}`;
    }
    if (typeof resAnno.wrap.hint !== "object") {
        throw new Error(`Unparseable hint provided for entity: ${resAnno.name}`);
    }
    return ` Hint: ${resAnno.wrap.hint[wrapAction] ?? ""}`;
}
