"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerEntityWrappers = registerEntityWrappers;
const zod_1 = require("zod");
const utils_1 = require("../auth/utils");
const logger_1 = require("../logger");
const utils_2 = require("./utils");
const expand_parser_1 = require("./expand-parser");
const loader_1 = require("../config/loader");
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
/**
 * Coerces numeric-looking strings to Number, but preserves the original string
 * when the value exceeds JS safe-integer precision. CAP handles BigInt/UUID IDs
 * fine as strings; silently truncating them produces wrong-row reads and writes.
 */
function coerceNumeric(raw) {
    if (typeof raw !== "string" || !/^\d+$/.test(raw))
        return raw;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : raw;
}
/**
 * Maps CAP runtime errors to a stable tool-error code + message. Keeps the
 * raw CAP error visible for log-side debugging while giving the LLM a
 * structured code it can reason about. Recognized:
 *   - Timeout (internal withTimeout wrapper)
 *   - ENTITY_IS_READ_ONLY (CAP's generic readOnly auth check, HTTP 405)
 *   - 409/412 = concurrency (ETag)
 *   - 404 = not found
 */
function classifyCapError(error, defaultCode, toolName) {
    const rawMsg = error?.message || String(error);
    if (rawMsg.includes("timed out")) {
        return { code: "TIMEOUT", msg: `${toolName} timed out after ${TIMEOUT_MS}ms` };
    }
    const capCode = error?.code;
    if (capCode === "ENTITY_IS_READ_ONLY" || rawMsg.includes("ENTITY_IS_READ_ONLY")) {
        return {
            code: "ENTITY_IS_READ_ONLY",
            msg: `Entity is read-only at the service level (e.g. sap.common.CodeList, @readonly, or @Capabilities.InsertRestrictions.Insertable:false). Remove create/update/delete from @mcp.wrap.modes for this entity.`,
        };
    }
    if (capCode === 404)
        return { code: "NOT_FOUND", msg: `${toolName}: ${rawMsg}` };
    if (capCode === 409 || capCode === 412)
        return { code: "CONFLICT", msg: `${toolName}: ${rawMsg}` };
    return { code: defaultCode, msg: `${defaultCode}: ${rawMsg}` };
}
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
 * Builds a per-tool description of the `expand` parameter, listing the
 * nav props actually declared on this entity so the LLM sees valid values.
 */
function buildExpandDescription(resAnno) {
    const comps = [];
    const assocs = [];
    for (const [name, info] of (resAnno.navigations || new Map()).entries()) {
        if (info.kind === "Composition") comps.push(name);
        else if (info.kind === "Association") assocs.push(name);
    }
    const parts = [];
    parts.push('OData $expand with subqueries (e.g. "children($top=5;$filter=active eq true)").');
    parts.push("Supported in subqueries: $select, $filter, $top, $skip, $orderby, $expand (nested).");
    if (comps.length) parts.push(`Compositions on ${resAnno.target}: ${comps.join(", ")}.`);
    if (assocs.length) parts.push(`Associations on ${resAnno.target}: ${assocs.join(", ")}.`);
    parts.push('Pass "" to suppress the runtime default of auto-expanding Compositions.');
    return parts.join(" ");
}
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
 * When `@mcp.name` is set on the entity resource, use `{name}_{suffix}` so IDs stay short
 * (many MCP clients cap tool names at 64 chars; `AttachmentAnalyticsService_BusinessDocumentProcessingEvents_query` exceeds that).
 * Fallback: `{Service}_{Entity}_{suffix}` for backwards compatibility when `name` is omitted.
 *
 * @param {import("../annotations/structures").McpResourceAnnotation} resAnno
 * @param {string} suffix
 */
function nameFor(resAnno, suffix) {
    const entityName = resAnno.target.split(".").pop();
    const serviceName = resAnno.serviceName.split(".").pop();
    const legacy = `${serviceName}_${entityName}_${suffix}`;
    const fromAnno = resAnno.name && typeof resAnno.name === "string"
        ? `${resAnno.name}_${suffix}`
        : null;
    /** @type {string[]} */
    const candidates = [];
    if (fromAnno)
        candidates.push(fromAnno);
    candidates.push(legacy);
    const fits = candidates.find((n) => n.length <= 64);
    if (fits)
        return fits;
    const best = candidates.reduce((a, b) => (a.length <= b.length ? a : b));
    logger_1.LOGGER.warn(`[MCP] Tool name exceeds 64 chars — shortening for strict clients: ${best}`);
    return best.slice(0, 64);
}
/**
 * Registers the list/query tool for an entity.
 * Supports select/where/orderby/top/skip and simple text search (q).
 */
function registerQueryTool(resAnno, server, authEnabled) {
    const toolName = nameFor(resAnno, "query");
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
        expand: zod_1.z
            .string()
            .max(2000)
            .optional()
            .describe(buildExpandDescription(resAnno)),
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
        expand: inputZod.shape.expand,
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
            const msg = e?.message || String(e);
            const code = msg.startsWith("$expand") ? "EXPAND_PARSE_ERROR" : "FILTER_PARSE_ERROR";
            return (0, utils_2.toolError)(code, msg);
        }
        try {
            const t0 = Date.now();
            const response = await withTimeout(executeQuery(CDS, svc, args, q), TIMEOUT_MS, toolName);
            // response shape depends on args.return:
            //   - "rows" (default): array of rows
            //   - "count": { count: number } scalar object
            //   - "aggregate": array of one aggregation row (or empty)
            // Only iterate with omission filter when the result is a row array.
            const result = Array.isArray(response)
                ? response.map((obj) => (0, utils_2.applyOmissionFilter)(obj, resAnno))
                : response;
            logger_1.LOGGER.debug(`[EXECUTION TIME] Query tool completed: ${toolName} in ${Date.now() - t0}ms`, { resultKind: args.return ?? "rows" });
            if (args.explain) {
                return (0, utils_2.asMcpResult)({
                    data: result,
                    plan: {
                        mode: args.return ?? "rows",
                        cqn: q?.SELECT ? { SELECT: q.SELECT } : q,
                    },
                });
            }
            return (0, utils_2.asMcpResult)(result);
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
    const toolName = nameFor(resAnno, "get");
    const inputSchema = {};
    for (const [k, cdsType] of resAnno.resourceKeys.entries()) {
        inputSchema[k] = (0, utils_2.determineMcpParameterType)(cdsType).describe(`Key ${k}. ${resAnno.propertyHints.get(k) ?? ""}`);
    }
    // `expand` mirrors the query tool: optional OData $expand with subqueries.
    // Clients that want the "lean" (no-compositions) shape can pass "" to
    // explicitly opt out of the runtime default.
    inputSchema.expand = zod_1.z
        .string()
        .max(2000)
        .optional()
        .describe(buildExpandDescription(resAnno));
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
            keys[k] = coerceNumeric(provided);
        }
        logger_1.LOGGER.debug(`Executing READ on ${resAnno.target} with keys`, keys);
        try {
            const { SELECT } = CDS.ql;
            const runtimeCfg = (0, loader_1.loadConfiguration)();
            const modelDefs = CDS.model?.definitions ?? {};
            const entityDef = modelDefs[`${resAnno.serviceName}.${resAnno.target}`] || modelDefs[resAnno.target];
            let expandColumns = [];
            try {
                expandColumns = (0, expand_parser_1.resolveExpand)({
                    userExpand: args?.expand,
                    defaultMode: resAnno.expandMode ?? runtimeCfg.expand.default,
                    entityDef,
                    modelDefs,
                    limits: { max_depth: runtimeCfg.expand.max_depth, max_breadth: runtimeCfg.expand.max_breadth },
                });
            }
            catch (e) {
                return (0, utils_2.toolError)("EXPAND_PARSE_ERROR", e?.message || String(e));
            }
            let query = SELECT.from(resAnno.target).where(keys);
            if (expandColumns.length > 0) {
                query = query.columns(["*", ...expandColumns]);
            }
            let response = await withTimeout(svc.run(query), TIMEOUT_MS, `${toolName}`);
            // svc.run(SELECT … where(keys)) returns an array; unwrap to a single row.
            if (Array.isArray(response)) response = response[0] ?? null;
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
    const toolName = nameFor(resAnno, "create");
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
    const desc = `Resource description: ${resAnno.description}. Create a new ${resAnno.target}. Provide fields; service applies defaults. Note: auto-generated integer keys are not returned in the response — if you need the new key, follow up with a query by the fields you supplied.${hint}`;
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
                    data[fkName] = coerceNumeric(args[fkName]);
                }
                continue;
            }
            if (args[propName] !== undefined) {
                data[propName] = coerceNumeric(args[propName]);
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
            await tx.commit();
            // CAP's `INSERT.entries` returns the enriched input (handler-added
            // fields like `IsActiveEntity`), but NOT auto-generated integer PKs.
            // Merge data + response so the client sees every known field.
            const merged = { ...data, ...(response && typeof response === "object" ? response : {}) };
            const result = (0, utils_2.applyOmissionFilter)(merged, resAnno);
            return (0, utils_2.asMcpResult)(result ?? {});
        }
        catch (error) {
            try {
                await tx.rollback();
            }
            catch { }
            const cls = classifyCapError(error, "CREATE_FAILED", toolName);
            logger_1.LOGGER.error(cls.msg, error);
            return (0, utils_2.toolError)(cls.code, cls.msg);
        }
    };
    server.registerTool(toolName, { title: toolName, description: desc, inputSchema }, createHandler);
}
/**
 * Registers the update tool for an entity.
 * Keys are required; non-key fields are optional. Associations via <assoc>_ID.
 */
function registerUpdateTool(resAnno, server, authEnabled) {
    const toolName = nameFor(resAnno, "update");
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
                    updates[fkName] = coerceNumeric(args[fkName]);
                }
                continue;
            }
            if (args[propName] !== undefined) {
                updates[propName] = coerceNumeric(args[propName]);
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
            await tx.commit();
            const result = (0, utils_2.applyOmissionFilter)(response, resAnno);
            return (0, utils_2.asMcpResult)(result ?? {});
        }
        catch (error) {
            try {
                await tx.rollback();
            }
            catch { }
            const cls = classifyCapError(error, "UPDATE_FAILED", toolName);
            logger_1.LOGGER.error(cls.msg, error);
            return (0, utils_2.toolError)(cls.code, cls.msg);
        }
    };
    server.registerTool(toolName, { title: toolName, description: desc, inputSchema }, updateHandler);
}
/**
 * Registers the delete tool for an entity.
 * Requires keys to identify the entity to delete.
 */
function registerDeleteTool(resAnno, server, authEnabled) {
    const toolName = nameFor(resAnno, "delete");
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
            keys[k] = coerceNumeric(provided);
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
            await tx.commit();
            // DELETE returns an affected-row count (0 or 1) on most adapters.
            // Surface that as an explicit `deleted` flag so the client knows
            // whether a row was actually removed (0 = key not found).
            const affected = typeof response === "number" ? response : (response?.affectedRows ?? null);
            return (0, utils_2.asMcpResult)({ deleted: affected !== 0, affectedRows: affected, keys });
        }
        catch (error) {
            try {
                await tx.rollback();
            }
            catch { }
            const cls = classifyCapError(error, "DELETE_FAILED", toolName);
            logger_1.LOGGER.error(cls.msg, error);
            return (0, utils_2.toolError)(cls.code, cls.msg);
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
    // Resolve $expand (user-supplied string or runtime default) so expand
    // column specs can be merged with whatever $select the client asked for.
    const runtimeCfg = (0, loader_1.loadConfiguration)();
    const modelDefs = CDS.model?.definitions ?? {};
    const entityDef = modelDefs[`${resAnno.serviceName}.${resAnno.target}`] || modelDefs[resAnno.target];
    const expandColumns = (0, expand_parser_1.resolveExpand)({
        userExpand: args.expand,
        defaultMode: resAnno.expandMode ?? runtimeCfg.expand.default,
        entityDef,
        modelDefs,
        limits: { max_depth: runtimeCfg.expand.max_depth, max_breadth: runtimeCfg.expand.max_breadth },
    });
    if (args.select?.length) {
        qy = qy.columns([...args.select, ...expandColumns]);
    }
    else if (expandColumns.length > 0) {
        qy = qy.columns(["*", ...expandColumns]);
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
    const baseWhere = baseQuery.SELECT?.where;
    switch (args.return) {
        case "count": {
            // count ignores top/skip/orderby — they don't change the cardinality.
            let countQuery = SELECT.from(baseQuery.SELECT.from).columns("count(1) as count");
            if (baseWhere)
                countQuery = countQuery.where(baseWhere);
            const result = await svc.run(countQuery);
            const row = Array.isArray(result) ? result[0] : result;
            return { count: row?.count ?? 0 };
        }
        case "aggregate": {
            if (!args.aggregate?.length)
                return [];
            const cols = args.aggregate.map((a) => `${a.fn}(${a.field}) as ${a.fn}_${a.field}`);
            let aggQuery = SELECT.from(baseQuery.SELECT.from).columns(...cols);
            if (baseWhere)
                aggQuery = aggQuery.where(baseWhere);
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
