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
const _NUMERIC_CDS_TYPES = new Set([
    "cds.Integer", "cds.Int16", "cds.Int32", "cds.Int64",
    "cds.UInt8", "cds.Decimal", "cds.Double",
]);
/**
 * Normalises a scalar payload value to the CAP-expected wire representation
 * based on a resolved CDS type string (e.g. `"cds.String"`, `"cds.Date"`).
 * CAP's CSN validator is strict: a string-keyed FK column (like a SAP
 * material number "7500008") must stay a string, numeric columns expect
 * numbers, and temporal columns expect wire-format strings.
 *
 * Use this (not `coerceNumeric`) for any payload value whose target CSN
 * type is known — otherwise numeric-looking strings silently become numbers
 * and string-typed fields are rejected with ASSERT_DATA_TYPE.
 */
function coerceScalarForType(value, cdsType) {
    if (value === undefined || value === null) return value;
    const type = typeof cdsType === "string" ? cdsType : "";
    if (type === "cds.Date") return (0, utils_2.toCdsTemporalString)(value, "Date");
    if (type === "cds.DateTime") return (0, utils_2.toCdsTemporalString)(value, "DateTime");
    if (type === "cds.Timestamp") return (0, utils_2.toCdsTemporalString)(value, "Timestamp");
    if (_NUMERIC_CDS_TYPES.has(type)) return coerceNumeric(value);
    // Explicit string / UUID / Binary / Boolean / unknown — leave as-is so
    // a numeric-looking string ("7500008") stays a string for string keys.
    return value;
}
/**
 * Convenience wrapper: looks up the CSN element on the entity definition
 * and delegates to `coerceScalarForType`.
 */
function coerceScalarForField(value, propName, entityDef) {
    const el = entityDef?.elements?.[propName];
    return coerceScalarForType(value, typeof el?.type === "string" ? el.type : "");
}
/**
 * Resolves the compiled CSN definition for an MCP resource (service-local name).
 */
function resolveEntityDefinition(resAnno) {
    const CDS = global.cds;
    const qn = `${resAnno.serviceName}.${resAnno.target}`;
    const defs = CDS.model?.definitions;
    if (!defs)
        return undefined;
    return defs[qn] || defs[resAnno.target];
}
const _assocKeysFallbackWarned = new Set();
/**
 * Expands a CDS association property into its generated foreign-key columns.
 * For composite-key associations (e.g. `technicalObject → (TechnicalObject, ObjectType)`)
 * CAP emits one FK column per target key, named `{propName}_{targetKey}`. A
 * single-key association degenerates to `{propName}_{targetKey}` (typically `_ID`).
 *
 * Returns `[{fkColumn, targetKey, cdsType, isMandatory}]`. Fallback: when the
 * CSN association has no resolvable `keys` array (e.g. unresolved projection),
 * emit `{propName}_ID` so we keep behaving like the pre-v1.1.x handlers.
 */
function expandAssociationKeys(def, propName) {
    const assoc = def?.elements?.[propName];
    const keys = Array.isArray(assoc?.keys) ? assoc.keys : [];
    const targetName = assoc?.target;
    const CDS = global.cds;
    const targetDef = targetName ? CDS?.model?.definitions?.[targetName] : undefined;
    if (keys.length === 0) {
        const fqn = `${def?.name ?? "?"}.${propName}`;
        if (!_assocKeysFallbackWarned.has(fqn)) {
            _assocKeysFallbackWarned.add(fqn);
            logger_1.LOGGER.warn(`[expandAssociationKeys] association ${fqn} has no resolvable keys — falling back to ${propName}_ID. Composite-key associations must resolve in CSN to emit typed FK columns.`);
        }
        return [{ fkColumn: `${propName}_ID`, targetKey: "ID", cdsType: "String", fullCdsType: "cds.String", isMandatory: false }];
    }
    return keys.map((k) => {
        const targetKey = Array.isArray(k?.ref) ? k.ref[0] : k?.ref;
        const targetElement = targetDef?.elements?.[targetKey];
        const fullCdsType = typeof targetElement?.type === "string" ? targetElement.type : "cds.String";
        const cdsType = fullCdsType.replace(/^cds\./, "");
        const isMandatory = Boolean(assoc?.["@mandatory"] || targetElement?.["@mandatory"]);
        return { fkColumn: `${propName}_${targetKey}`, targetKey, cdsType, fullCdsType, isMandatory };
    });
}
/**
 * Draft-enabled root entities use a composite OData key (ID + IsActiveEntity).
 * CQN UPDATE/DELETE without IsActiveEntity can leave CAP event handlers with an
 * incomplete {@link cds.Request#params} map — e.g. `request.params.at(...)`
 * missing the entity slice. Default active-document addressing when callers
 * omit IsActiveEntity (typical MCP tools only pass UUID).
 */
function isDraftEnabledRoot(def) {
    if (!def?.elements?.IsActiveEntity)
        return false;
    if (def["@odata.draft.enabled"] === true)
        return true;
    if (def["@fiori.draft.enabled"] === true)
        return true;
    return false;
}
/**
 * Draft-bypass entities (annotated `@odata.draft.bypass`, or any draft root
 * when `cds.env.fiori.bypass_draft` is enabled globally) accept direct active
 * modifications without going through draftEdit → patch → activate. In that
 * case the DRAFT_REQUIRED short-circuit on update/delete must not trip.
 */
function isDraftBypassEnabled(def) {
    if (!def)
        return false;
    if (def["@odata.draft.bypass"] === true)
        return true;
    const CDS = global.cds;
    if (CDS?.env?.fiori?.bypass_draft === true)
        return true;
    return false;
}
/**
 * Ensures {@link keys} include IsActiveEntity for draft roots when omitted.
 * Pass `false` explicitly to target draft rows; otherwise defaults to `true` (active).
 */
function ensureDraftIsActiveEntityKey(keys, resAnno) {
    if (!keys || keys.IsActiveEntity !== undefined)
        return;
    const def = resolveEntityDefinition(resAnno);
    if (!isDraftEnabledRoot(def))
        return;
    keys.IsActiveEntity = true;
    logger_1.LOGGER.debug(`Draft root ${resAnno.serviceName}.${resAnno.target}: defaulted IsActiveEntity=true for CQN keys`);
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
    const rawMsg = formatCapErrorMessage(error);
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
    if (capCode === "DRAFT_LOCKED_BY_ANOTHER_USER" ||
        rawMsg.includes("DRAFT_LOCKED_BY_ANOTHER_USER") ||
        rawMsg.includes("is currently locked by")) {
        // CAP often carries the holder id in error.args[0] or in the raw
        // message ("…currently locked by user alice"). Include whichever we
        // can surface so the caller knows who to ask (or whom to wait for).
        const holder = Array.isArray(error?.args) ? error.args[0] : undefined;
        const holderHint = holder
            ? ` (held by ${holder})`
            : rawMsg.match(/locked by\s+(\S+)/)
                ? ` (held by ${rawMsg.match(/locked by\s+(\S+)/)[1]})`
                : "";
        // Also surface the PRINCIPAL THE PLUGIN SEES AS THE CALLER. The
        // DRAFT_LOCKED error fires when CAP compares the lock holder to
        // `cds.context.user.id`; if those diverge despite the same human
        // driving both calls, it usually means MCP's handler ran outside
        // the authenticated context (anonymous / privileged / undefined),
        // or the caller used a different bearer token than the one that
        // opened the draft. Printing the caller id makes that obvious.
        const CDS = global.cds;
        const caller = CDS?.context?.user?.id ?? "<unknown — cds.context.user not populated>";
        const callerIsPrivileged = !!CDS?.context?.user?._is_privileged;
        const callerHint = callerIsPrivileged
            ? ` (you are '${caller}', a privileged system user)`
            : ` (you are '${caller}')`;
        const diagnostic = holder && caller && holder !== caller
            ? " Root cause: the lock holder and the current MCP principal are different identities. If you expected the same human to drive both calls, check whether the MCP bearer token's `sub` / `user_name` claim matches the holder, and whether CAP's auth middleware runs on `/mcp` (enable DEBUG=mcp.draft to trace)."
            : "";
        return {
            code: "DRAFT_LOCKED",
            msg: `${toolName}: draft is locked by another user${holderHint}${callerHint}.${diagnostic} Retry as that user or wait for cds.env.drafts.cancellationTimeout (default 15 min), then ${toolName.replace(/_[^_]+$/, "_draft-discard")} to release.`,
        };
    }
    if (capCode === "DRAFT_ALREADY_EXISTS" || rawMsg.includes("DRAFT_ALREADY_EXISTS")) {
        return { code: "DRAFT_ALREADY_EXISTS", msg: `${toolName}: draft already exists for this row` };
    }
    // ASSERT_DATA_TYPE is CAP core's generic "shape of payload does not match
    // CSN" failure. CAP usually carries the offending element name on
    // `error.target` / `error.element` or in details[] — extract it so the
    // LLM can pinpoint which field failed instead of re-submitting the whole
    // payload blindly.
    if (capCode === "ASSERT_DATA_TYPE" || rawMsg.includes("ASSERT_DATA_TYPE")) {
        const details = Array.isArray(error?.details) ? error.details : [];
        const fields = new Set();
        if (error?.target) fields.add(String(error.target));
        if (error?.element) fields.add(String(error.element));
        for (const d of details) {
            if (d?.target) fields.add(String(d.target));
            if (d?.element) fields.add(String(d.element));
        }
        const fieldHint = fields.size > 0 ? ` [field: ${Array.from(fields).join(", ")}]` : "";
        return {
            code: "ASSERT_DATA_TYPE",
            msg: `${toolName}: ${rawMsg}${fieldHint}. Payload shape did not match CSN — check that the value type matches the CDS type (Date expects "YYYY-MM-DD" string, not a datetime) and every composite-key FK column is supplied.`,
        };
    }
    // @assert.* / @mandatory violations raised by CAP's generic validator.
    // Draft pipeline: deferred constraints surface on SAVE; inline ones on
    // NEW/PATCH. Either way, expose as DRAFT_VALIDATION_FAILED when we're
    // inside a draft handler so the LLM knows a retry with different field
    // values (not a different tool) is the right response.
    const isDraftOp = /_draft-(new|edit|patch|activate|discard|upsert)$/.test(toolName || "");
    const isAssertCode = typeof capCode === "string" && capCode.startsWith("ASSERT_");
    if (isAssertCode ||
        rawMsg.includes("ASSERT_NOT_NULL") ||
        rawMsg.includes("ASSERT_MANDATORY") ||
        rawMsg.includes("Value is required") ||
        rawMsg.includes("@mandatory")) {
        if (isDraftOp) {
            // CAP's default ASSERT_MANDATORY message is opaque ("@mandatory:
            // Value is required") — the offending field name lives on
            // `error.target`, `error.element`, or as a details[].target.
            // Pluck whichever we can and splice it in.
            const details = Array.isArray(error?.details) ? error.details : [];
            const fields = new Set();
            if (error?.target) fields.add(String(error.target));
            if (error?.element) fields.add(String(error.element));
            for (const d of details) {
                if (d?.target) fields.add(String(d.target));
                if (d?.element) fields.add(String(d.element));
            }
            const fieldHint = fields.size > 0 ? ` [field: ${Array.from(fields).join(", ")}]` : "";
            const onActivate = /draft-activate$/.test(toolName);
            const onUpsert = /draft-upsert$/.test(toolName);
            let code;
            let remedy;
            if (onUpsert) {
                code = "DRAFT_UPSERT_FAILED";
                remedy = "Retry the draft-upsert call with the missing field filled in.";
            } else if (onActivate) {
                code = "DRAFT_ACTIVATE_FAILED";
                remedy = "Fill missing @mandatory / @assert.* fields via draft-patch before activating.";
            } else {
                code = "DRAFT_VALIDATION_FAILED";
                remedy = "Adjust field values and retry the draft-patch/new call.";
            }
            return {
                code,
                msg: `${toolName}: ${rawMsg}${fieldHint}. ${remedy}`,
            };
        }
    }
    if (capCode === 404)
        return { code: "NOT_FOUND", msg: `${toolName}: ${rawMsg}` };
    if (capCode === 409 || capCode === 412)
        return { code: "CONFLICT", msg: `${toolName}: ${rawMsg}` };
    return { code: defaultCode, msg: `${defaultCode}: ${rawMsg}` };
}
/**
 * Flattens a CAP error into a single message string, unpacking nested
 * `details` entries (e.g. MULTIPLE_ERRORS from validation) so the LLM sees
 * every violation instead of a useless "MULTIPLE_ERRORS" placeholder.
 * Recurses one level deep — CAP details may themselves carry details when
 * deep-insert validations fan out.
 */
function formatCapErrorMessage(error) {
    if (!error) return "";
    const top = error.message || String(error);
    const details = Array.isArray(error.details) ? error.details : [];
    if (details.length === 0) return top;
    const parts = details.map((d) => {
        const msg = d?.message || d?.code || String(d);
        const target = d?.target ? ` [${d.target}]` : "";
        const nested = Array.isArray(d?.details) && d.details.length
            ? ` (${d.details.map((n) => n?.message || n?.code || String(n)).join("; ")})`
            : "";
        return `${msg}${target}${nested}`;
    });
    return `${top} — ${parts.join("; ")}`;
}
/**
 * Standardised DRAFT_REQUIRED payload for active-row update/delete on a
 * draft-enabled root. Steers the LLM to the draft-lifecycle tools instead of
 * letting CAP surface an opaque "request.params.at(...)" destructure error.
 */
function draftRequiredError(resAnno, op) {
    const baseName = nameFor(resAnno, "placeholder").replace(/_placeholder$/, "");
    const create = `${baseName}_draft-new`;
    const edit = `${baseName}_draft-edit`;
    const patch = `${baseName}_draft-patch`;
    const activate = `${baseName}_draft-activate`;
    const discard = `${baseName}_draft-discard`;
    let steer;
    if (op === "delete") {
        steer = `Use ${discard} to drop an existing draft, or ${edit} + ${activate} if you need to activate a pending draft first.`;
    }
    else if (op === "create") {
        steer = `Use ${create} to create a new draft, ${patch} to apply further changes, then ${activate} to publish. Draft-enabled roots defer @assert.target / FK validation until activation, so FK fields whose target is resolved remotely are accepted on the draft.`;
    }
    else {
        steer = `Use ${edit} to create a draft, ${patch} to apply changes, then ${activate} to publish.`;
    }
    return (0, utils_2.toolError)("DRAFT_REQUIRED", `${resAnno.target} is draft-enabled; active-row ${op} is not allowed. ${steer}`);
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
    const explicitModes = resAnno.wrap?.modes;
    const draftEnabled = isDraftEnabledRoot(resolveEntityDefinition(resAnno));
    // Auto-enable draft lifecycle tools for `@odata.draft.enabled` roots,
    // regardless of whether the caller supplied explicit `@mcp.wrap.modes`.
    // The active-row create/update/delete tools short-circuit with
    // DRAFT_REQUIRED for these entities, so the draft-* tools MUST be
    // registered — otherwise the error message points to tools that don't
    // exist. Users who explicitly list draft modes get them without
    // duplication via the Set below.
    const baseModes = explicitModes ?? defaultModes;
    const DRAFT_MODES = ["draft-new", "draft-edit", "draft-patch", "draft-activate", "draft-discard", "draft-upsert"];
    const modes = draftEnabled
        ? Array.from(new Set([...baseModes, ...DRAFT_MODES]))
        : baseModes;
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
    // Draft lifecycle tools — only registered when the entity is actually a
    // draft-enabled root. Skipping non-draft entities prevents dead tools in
    // the client's list even if a caller mistakenly puts `draft-*` in
    // `@mcp.wrap.modes`.
    if (draftEnabled) {
        if (modes.includes("draft-new") && accesses.canCreate) {
            registerDraftNewTool(resAnno, server, authEnabled);
        }
        if (modes.includes("draft-edit") &&
            resAnno.resourceKeys && resAnno.resourceKeys.size > 0 &&
            accesses.canUpdate) {
            registerDraftEditTool(resAnno, server, authEnabled);
        }
        if (modes.includes("draft-patch") &&
            resAnno.resourceKeys && resAnno.resourceKeys.size > 0 &&
            accesses.canUpdate) {
            registerDraftPatchTool(resAnno, server, authEnabled);
        }
        if (modes.includes("draft-activate") &&
            resAnno.resourceKeys && resAnno.resourceKeys.size > 0 &&
            accesses.canUpdate) {
            registerDraftActivateTool(resAnno, server, authEnabled);
        }
        if (modes.includes("draft-discard") &&
            resAnno.resourceKeys && resAnno.resourceKeys.size > 0 &&
            accesses.canDelete) {
            registerDraftDiscardTool(resAnno, server, authEnabled);
        }
        if (modes.includes("draft-upsert") &&
            accesses.canCreate && accesses.canUpdate) {
            registerDraftUpsertTool(resAnno, server, authEnabled);
        }
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
        ...(isDraftEnabledRoot(resolveEntityDefinition(resAnno)) && {
            IsActiveEntity: zod_1.z
                .boolean()
                .optional()
                .describe("Draft selector: true = active rows only, false = draft rows only. Omit to return both active and pending drafts."),
        }),
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
    if (inputZod.shape.IsActiveEntity) {
        inputSchema.IsActiveEntity = inputZod.shape.IsActiveEntity;
    }
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
            const response = await withTimeout(svc.tx({ user: (0, utils_1.getAccessRights)(authEnabled) }, (tx) => executeQuery(CDS, tx, args, q)), TIMEOUT_MS, toolName);
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
            const msg = `QUERY_FAILED: ${formatCapErrorMessage(error)}`;
            return (0, utils_2.toolError)("QUERY_FAILED", msg, undefined, error);
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
    const draftEnabled = isDraftEnabledRoot(resolveEntityDefinition(resAnno));
    for (const [k, cdsType] of resAnno.resourceKeys.entries()) {
        if (draftEnabled && k === "IsActiveEntity") {
            // Draft roots: make IsActiveEntity optional and default to true so
            // the LLM only has to pass the business keys to read the active
            // row. Callers can pass `false` to read the draft sibling instead.
            inputSchema[k] = zod_1.z
                .boolean()
                .optional()
                .default(true)
                .describe("Draft selector: true (default) reads the active row, false reads the draft sibling.");
            continue;
        }
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
            if (provided === undefined && k === "IsActiveEntity" &&
                isDraftEnabledRoot(resolveEntityDefinition(resAnno))) {
                // Draft roots: default to the active row when caller omits the
                // selector. Matches the get-tool input schema's default.
                provided = true;
            }
            if (provided === undefined) {
                logger_1.LOGGER.warn(`Get tool missing required key`, { key: k, toolName });
                return (0, utils_2.toolError)("MISSING_KEY", `Missing key '${k}'`);
            }
            keys[k] = coerceNumeric(provided);
        }
        ensureDraftIsActiveEntityKey(keys, resAnno);
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
            let response = await withTimeout(svc.tx({ user: (0, utils_1.getAccessRights)(authEnabled) }, (tx) => tx.run(query)), TIMEOUT_MS, `${toolName}`);
            // svc.run(SELECT … where(keys)) returns an array; unwrap to a single row.
            if (Array.isArray(response)) response = response[0] ?? null;
            logger_1.LOGGER.debug(`[EXECUTION TIME] Get tool completed: ${toolName} in ${Date.now() - startTime}ms`, { found: !!response });
            const result = (0, utils_2.applyOmissionFilter)(response, resAnno);
            return (0, utils_2.asMcpResult)(result ?? null);
        }
        catch (error) {
            const msg = `GET_FAILED: ${formatCapErrorMessage(error)}`;
            return (0, utils_2.toolError)("GET_FAILED", msg, undefined, error);
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
    const entityDef = resolveEntityDefinition(resAnno);
    for (const [propName, cdsType] of resAnno.properties.entries()) {
        const isAssociation = String(cdsType).toLowerCase().includes("association");
        const isComputed = resAnno.computedFields?.has(propName);
        if (isAssociation) {
            // Composite-key associations surface one flat MCP parameter per
            // generated FK column (e.g. technicalObject → technicalObject_TechnicalObject
            // + technicalObject_ObjectType). Single-key associations degenerate to
            // `<propName>_ID`, preserving the existing contract.
            for (const fk of expandAssociationKeys(entityDef, propName)) {
                inputSchema[fk.fkColumn] = (0, utils_2.determineMcpParameterType)(fk.cdsType)
                    .optional()
                    .describe(`FK to ${propName}.${fk.targetKey}. ${resAnno.propertyHints.get(propName) ?? ""}`);
            }
            continue;
        }
        if (isComputed) continue;
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
        // Active-row INSERT on a draft-enabled root triggers synchronous
        // @assert.target FK validation against association sources (incl.
        // remote/S/4 services) that may not resolve outside the draft
        // pipeline. Route the caller to draft-new, which defers those checks
        // until draft-activate — matching how the Fiori UI creates drafts.
        // Skip when @odata.draft.bypass is active.
        {
            const def = resolveEntityDefinition(resAnno);
            if (isDraftEnabledRoot(def) && !isDraftBypassEnabled(def)) {
                return draftRequiredError(resAnno, "create");
            }
        }
        // Build data object from provided args, limited to known properties.
        // Association FKs are expanded per-target-key so composite keys write
        // every generated column (not just `_ID`). Coercion is type-aware:
        // a string-keyed FK (e.g. SAP material number "7500008") stays a
        // string, numeric columns coerce "42" → 42, temporal columns get
        // wire-format strings.
        const def = resolveEntityDefinition(resAnno);
        const data = {};
        for (const [propName, cdsType] of resAnno.properties.entries()) {
            const isAssociation = String(cdsType)
                .toLowerCase()
                .includes("association");
            if (isAssociation) {
                for (const fk of expandAssociationKeys(def, propName)) {
                    if (args[fk.fkColumn] !== undefined) {
                        data[fk.fkColumn] = coerceScalarForType(args[fk.fkColumn], fk.fullCdsType);
                    }
                }
                continue;
            }
            if (args[propName] !== undefined) {
                data[propName] = coerceScalarForField(args[propName], propName, def);
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
            return (0, utils_2.toolError)(cls.code, cls.msg, undefined, error);
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
    const entityDef = resolveEntityDefinition(resAnno);
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
        if (isAssociation) {
            for (const fk of expandAssociationKeys(entityDef, propName)) {
                inputSchema[fk.fkColumn] = (0, utils_2.determineMcpParameterType)(fk.cdsType)
                    .optional()
                    .describe(`FK to ${propName}.${fk.targetKey}. ${resAnno.propertyHints.get(propName) ?? ""}`);
            }
            continue;
        }
        if (isComputed) continue;
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
        // Active-row UPDATE on a draft-enabled root fails inside CAP's draft
        // pipeline with an opaque "request.params.at(...)" destructure error.
        // Surface a clear DRAFT_REQUIRED up front so the LLM picks the right
        // draft-* tool instead — unless @odata.draft.bypass is in effect, in
        // which case CAP allows direct active-row mutation.
        {
            const def = resolveEntityDefinition(resAnno);
            if (isDraftEnabledRoot(def) && !isDraftBypassEnabled(def)) {
                return draftRequiredError(resAnno, "update");
            }
        }
        // Extract keys and update fields
        const keys = {};
        for (const [k] of resAnno.resourceKeys.entries()) {
            let provided = args[k];
            if (provided === undefined && k === "IsActiveEntity") {
                const def = resolveEntityDefinition(resAnno);
                if (isDraftEnabledRoot(def))
                    provided = true;
            }
            if (provided === undefined) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Missing key '${k}'` }],
                };
            }
            keys[k] = coerceNumeric(provided);
        }
        ensureDraftIsActiveEntityKey(keys, resAnno);
        // Normalize updates: expand composite-key associations into all
        // generated FK columns and coerce values against the CSN type of
        // each target field.
        const updates = {};
        const defForUpdate = resolveEntityDefinition(resAnno);
        for (const [propName, cdsType] of resAnno.properties.entries()) {
            if (resAnno.resourceKeys.has(propName))
                continue;
            const isAssociation = String(cdsType)
                .toLowerCase()
                .includes("association");
            if (isAssociation) {
                for (const fk of expandAssociationKeys(defForUpdate, propName)) {
                    if (args[fk.fkColumn] !== undefined) {
                        updates[fk.fkColumn] = coerceScalarForType(args[fk.fkColumn], fk.fullCdsType);
                    }
                }
                continue;
            }
            if (args[propName] !== undefined) {
                updates[propName] = coerceScalarForField(args[propName], propName, defForUpdate);
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
            return (0, utils_2.toolError)(cls.code, cls.msg, undefined, error);
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
        // Draft-enabled roots: discard a draft via `draft-discard`; to remove
        // the active row you must go through draft-edit + draft-activate
        // (CAP doesn't expose a direct "delete active" path while a draft
        // workflow is in force). Emit DRAFT_REQUIRED — unless the entity
        // opts out via @odata.draft.bypass / cds.env.fiori.bypass_draft.
        {
            const def = resolveEntityDefinition(resAnno);
            if (isDraftEnabledRoot(def) && !isDraftBypassEnabled(def)) {
                return draftRequiredError(resAnno, "delete");
            }
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
            if (provided === undefined && k === "IsActiveEntity") {
                const def = resolveEntityDefinition(resAnno);
                if (isDraftEnabledRoot(def))
                    provided = true;
            }
            if (provided === undefined) {
                logger_1.LOGGER.warn(`Delete tool missing required key`, { key: k, toolName });
                return (0, utils_2.toolError)("MISSING_KEY", `Missing key '${k}'`);
            }
            keys[k] = coerceNumeric(provided);
        }
        ensureDraftIsActiveEntityKey(keys, resAnno);
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
            return (0, utils_2.toolError)(cls.code, cls.msg, undefined, error);
        }
    };
    server.registerTool(toolName, { title: toolName, description: desc, inputSchema }, deleteHandler);
}
/**
 * Helpers shared by the draft lifecycle tools.
 *
 * Key extraction intentionally ignores `IsActiveEntity`: draft handlers set
 * that selector explicitly (false for patch/discard on drafts; true for edit
 * on active rows) so the caller only needs to pass the business keys.
 */
/**
 * Emits a single debug line on the `mcp.draft` channel describing the draft
 * operation about to run. Opt-in noise — enable with `DEBUG=mcp.draft`.
 * Surfaces the authenticated principal so on-call can correlate lock holders
 * across calls without spelunking through CAP's own logs.
 */
function logDraftOp(op, resAnno, keysOrData) {
    try {
        const CDS = global.cds;
        const u = CDS?.context?.user;
        const user = u?.id || "unknown";
        logger_1.DRAFT_LOGGER.debug(`[draft-${op}] entity=${resAnno.serviceName}.${resAnno.target} keys=${JSON.stringify(keysOrData ?? {})} user=${user}`);
        // Parallel auth-channel trace: gives on-call the full principal
        // snapshot on every draft op without needing to enable mcp.draft.
        logAuthContext(`draft-${op}`);
    }
    catch { }
}
/**
 * Logs the effective principal at the exact instant a draft operation is
 * about to dispatch inside `svc.tx(…)`. Designed to catch the case where
 * `cds.context.user` resolved by the auth middleware (outside the tx) does
 * NOT match the principal CAP will stamp into `DraftAdministrativeData`
 * (`req.user.id` inside lean-draft's onNew / PATCH). Three identities are
 * reported side-by-side so drift is obvious:
 *   - outer = cds.context.user.id at the moment the express handler ran
 *   - tx    = tx.user.id — the user we explicitly handed svc.tx({user})
 *   - inner = cds.context.user.id as observed inside the tx callback
 * Opt-in via `DEBUG=mcp.auth`.
 */
function logDraftTxDispatch(op, outerUserId, tx) {
    try {
        const CDS = global.cds;
        const innerUserId = CDS?.context?.user?.id ?? "<none>";
        const txUserId = tx?.user?.id ?? tx?.context?.user?.id ?? "<none>";
        logger_1.AUTH_LOGGER.debug(`[draft-${op}] dispatch outer='${outerUserId ?? "<none>"}' tx='${txUserId}' inner='${innerUserId}' — this is the id CAP will stamp into DraftAdministrativeData.InProcessByUser`);
    }
    catch { }
}
/**
 * Writes one line on the `mcp.auth` channel describing the principal the
 * plugin will pass to `svc.tx({user})`. Opt-in via `DEBUG=mcp.auth`.
 *
 * Reports: user id, roles, tenant, privileged flag, anonymous flag, and a
 * short explanation when `cds.context.user` is undefined — which usually
 * means the request bypassed CAP's auth / context middleware and the draft
 * lifecycle will run as anonymous-or-default. That's the exact shape
 * behind many EAM-style "DRAFT_LOCKED by other user" confusions.
 */
function logAuthContext(label) {
    try {
        const CDS = global.cds;
        const ctx = CDS?.context;
        if (!ctx) {
            logger_1.AUTH_LOGGER.debug(`[${label}] cds.context is undefined — request did NOT go through CAP's context middleware. The tool handler is running outside the authenticated request scope.`);
            return;
        }
        const u = ctx.user;
        if (!u) {
            logger_1.AUTH_LOGGER.debug(`[${label}] cds.context.user is undefined — auth middleware did not populate a principal. CAP will fall back to its default (usually 'anonymous').`);
            return;
        }
        const roles = u.roles ? Object.keys(u.roles) : [];
        logger_1.AUTH_LOGGER.debug(`[${label}] caller id='${u.id}' privileged=${!!u._is_privileged} anonymous=${!!u._is_anonymous} tenant='${u.tenant ?? ctx.tenant ?? "<none>"}' roles=[${roles.join(", ")}]`);
    }
    catch { }
}
function extractBusinessKeys(args, resAnno, toolName, op) {
    const keys = {};
    for (const [k] of resAnno.resourceKeys.entries()) {
        if (k === "IsActiveEntity")
            continue;
        let provided = args?.[k];
        if (provided === undefined) {
            const alt = Object.entries(args || {}).find(([kk]) => String(kk).toLowerCase() === String(k).toLowerCase());
            if (alt)
                provided = args[alt[0]];
        }
        if (provided === undefined) {
            logger_1.LOGGER.warn(`${toolName} missing required key`, { key: k, op });
            return { error: (0, utils_2.toolError)("MISSING_KEY", `Missing key '${k}'`) };
        }
        keys[k] = coerceNumeric(provided);
    }
    return { keys };
}
/**
 * Registers the `draft-new` tool: creates a pending draft row without
 * activating it. Backed by `INSERT.into(<Entity>.drafts)` — CAP's lean-draft
 * runtime routes the insert through the NEW event and initialises
 * DraftAdministrativeData.
 */
function registerDraftNewTool(resAnno, server, authEnabled) {
    const toolName = nameFor(resAnno, "draft-new");
    const inputSchema = {};
    const entityDef = resolveEntityDefinition(resAnno);
    for (const [propName, cdsType] of resAnno.properties.entries()) {
        const isAssociation = String(cdsType).toLowerCase().includes("association");
        const isComputed = resAnno.computedFields?.has(propName);
        if (isAssociation) {
            for (const fk of expandAssociationKeys(entityDef, propName)) {
                inputSchema[fk.fkColumn] = (0, utils_2.determineMcpParameterType)(fk.cdsType)
                    .optional()
                    .describe(`FK to ${propName}.${fk.targetKey}. ${resAnno.propertyHints.get(propName) ?? ""}`);
            }
            continue;
        }
        if (isComputed) continue;
        // Business keys are optional on draft-new — CAP fills UUIDs for us if
        // the caller omits them. Scalars stay optional to accept partial drafts.
        inputSchema[propName] = (0, utils_2.determineMcpParameterType)(cdsType, propName, `${resAnno.serviceName}.${resAnno.target}`)
            .optional()
            .describe(resAnno.foreignKeys.has(propName)
            ? `Foreign key to ${resAnno.foreignKeys.get(propName)} on ${propName}. ${resAnno.propertyHints.get(propName) ?? ""}`
            : `Field ${propName}. ${resAnno.propertyHints.get(propName) ?? ""}`);
    }
    const hint = constructHintMessage(resAnno, "create");
    const desc = `Resource description: ${resAnno.description}. Create a new draft of ${resAnno.target} (IsActiveEntity=false). Follow up with ${nameFor(resAnno, "draft-patch")} to edit fields and ${nameFor(resAnno, "draft-activate")} to publish.${hint}`;
    const handler = async (args) => {
        const svc = await resolveServiceInstance(resAnno.serviceName);
        if (!svc) {
            return (0, utils_2.toolError)("ERR_MISSING_SERVICE", `Service not found: ${resAnno.serviceName}`);
        }
        const data = {};
        const def = resolveEntityDefinition(resAnno);
        for (const [propName, cdsType] of resAnno.properties.entries()) {
            const isAssociation = String(cdsType).toLowerCase().includes("association");
            if (isAssociation) {
                for (const fk of expandAssociationKeys(def, propName)) {
                    if (args[fk.fkColumn] !== undefined) {
                        data[fk.fkColumn] = coerceScalarForType(args[fk.fkColumn], fk.fullCdsType);
                    }
                }
                continue;
            }
            if (args[propName] !== undefined)
                data[propName] = coerceScalarForField(args[propName], propName, def);
        }
        logDraftOp("new", resAnno, data);
        const outerUserIdNew = global.cds?.context?.user?.id;
        try {
            // Route through CAP's 'NEW' event via the callback form of srv.tx
            // so cds.context (an AsyncLocalStorage) is established around the
            // dispatch. The lean-draft onNew handler reads cds.context.timestamp.
            const response = await withTimeout(svc.tx({ user: (0, utils_1.getAccessRights)(authEnabled) }, (tx) => {
                logDraftTxDispatch("new", outerUserIdNew, tx);
                return tx.send("NEW", `${resAnno.target}.drafts`, data);
            }), TIMEOUT_MS, toolName);
            const merged = { ...data, ...(response && typeof response === "object" ? response : {}) };
            return (0, utils_2.asMcpResult)((0, utils_2.applyOmissionFilter)(merged, resAnno) ?? {});
        }
        catch (error) {
            const cls = classifyCapError(error, "DRAFT_NEW_FAILED", toolName);
            return (0, utils_2.toolError)(cls.code, cls.msg, undefined, error);
        }
    };
    server.registerTool(toolName, { title: toolName, description: desc, inputSchema }, handler);
}
/**
 * Registers the `draft-edit` tool: produces a draft copy of an existing
 * active row via CAP's 'EDIT' event. The returned payload carries
 * IsActiveEntity=false so the LLM can follow up with draft-patch.
 */
function registerDraftEditTool(resAnno, server, authEnabled) {
    const toolName = nameFor(resAnno, "draft-edit");
    const inputSchema = {};
    for (const [k, cdsType] of resAnno.resourceKeys.entries()) {
        if (k === "IsActiveEntity")
            continue;
        inputSchema[k] = (0, utils_2.determineMcpParameterType)(cdsType).describe(`Key ${k}. ${resAnno.propertyHints.get(k) ?? ""}`);
    }
    const keyList = Array.from(resAnno.resourceKeys.keys()).filter((k) => k !== "IsActiveEntity").join(", ");
    const hint = constructHintMessage(resAnno, "update");
    const desc = `Resource description: ${resAnno.description}. Start editing ${resAnno.target} by key(s): ${keyList} — creates a draft copy of the active row. Follow up with ${nameFor(resAnno, "draft-patch")} and ${nameFor(resAnno, "draft-activate")}.${hint}`;
    const handler = async (args) => {
        const svc = await resolveServiceInstance(resAnno.serviceName);
        if (!svc) {
            return (0, utils_2.toolError)("ERR_MISSING_SERVICE", `Service not found: ${resAnno.serviceName}`);
        }
        const extracted = extractBusinessKeys(args, resAnno, toolName, "edit");
        if (extracted.error)
            return extracted.error;
        logDraftOp("edit", resAnno, extracted.keys);
        try {
            const response = await withTimeout(svc.tx({ user: (0, utils_1.getAccessRights)(authEnabled) }, (tx) => tx.send("EDIT", resAnno.target, extracted.keys)), TIMEOUT_MS, toolName);
            return (0, utils_2.asMcpResult)((0, utils_2.applyOmissionFilter)(response, resAnno) ?? {});
        }
        catch (error) {
            const cls = classifyCapError(error, "DRAFT_EDIT_FAILED", toolName);
            return (0, utils_2.toolError)(cls.code, cls.msg, undefined, error);
        }
    };
    server.registerTool(toolName, { title: toolName, description: desc, inputSchema }, handler);
}
/**
 * Registers the `draft-patch` tool: updates fields on an existing draft row.
 * Runs plain CQN with `IsActiveEntity=false` in the WHERE — CAP's draft
 * handlers route this to the draft sibling and persist the change. Returns
 * the re-read draft row so the LLM can see the applied state.
 */
function registerDraftPatchTool(resAnno, server, authEnabled) {
    const toolName = nameFor(resAnno, "draft-patch");
    const inputSchema = {};
    const entityDef = resolveEntityDefinition(resAnno);
    for (const [k, cdsType] of resAnno.resourceKeys.entries()) {
        if (k === "IsActiveEntity")
            continue;
        inputSchema[k] = (0, utils_2.determineMcpParameterType)(cdsType).describe(`Key ${k}. ${resAnno.propertyHints.get(k) ?? ""}`);
    }
    for (const [propName, cdsType] of resAnno.properties.entries()) {
        if (resAnno.resourceKeys.has(propName))
            continue;
        const isComputed = resAnno.computedFields?.has(propName);
        const isAssociation = String(cdsType).toLowerCase().includes("association");
        if (isAssociation) {
            for (const fk of expandAssociationKeys(entityDef, propName)) {
                inputSchema[fk.fkColumn] = (0, utils_2.determineMcpParameterType)(fk.cdsType)
                    .optional()
                    .describe(`FK to ${propName}.${fk.targetKey}. ${resAnno.propertyHints.get(propName) ?? ""}`);
            }
            continue;
        }
        if (isComputed) continue;
        inputSchema[propName] = (0, utils_2.determineMcpParameterType)(cdsType, propName, `${resAnno.serviceName}.${resAnno.target}`)
            .optional()
            .describe(resAnno.foreignKeys.has(propName)
            ? `Foreign key to ${resAnno.foreignKeys.get(propName)} on ${propName}. ${resAnno.propertyHints.get(propName) ?? ""}`
            : `Field ${propName}. ${resAnno.propertyHints.get(propName) ?? ""}`);
    }
    const keyList = Array.from(resAnno.resourceKeys.keys()).filter((k) => k !== "IsActiveEntity").join(", ");
    const hint = constructHintMessage(resAnno, "update");
    const desc = `Resource description: ${resAnno.description}. Patch an existing draft of ${resAnno.target} by key(s): ${keyList}. Requires a draft to already exist — call ${nameFor(resAnno, "draft-new")} or ${nameFor(resAnno, "draft-edit")} first. Follow up with ${nameFor(resAnno, "draft-activate")} to publish.${hint}`;
    const handler = async (args) => {
        const CDS = global.cds;
        const { UPDATE, SELECT } = CDS.ql;
        const svc = await resolveServiceInstance(resAnno.serviceName);
        if (!svc) {
            return (0, utils_2.toolError)("ERR_MISSING_SERVICE", `Service not found: ${resAnno.serviceName}`);
        }
        const extracted = extractBusinessKeys(args, resAnno, toolName, "patch");
        if (extracted.error)
            return extracted.error;
        const keys = { ...extracted.keys, IsActiveEntity: false };
        const updates = {};
        const def = resolveEntityDefinition(resAnno);
        for (const [propName, cdsType] of resAnno.properties.entries()) {
            if (resAnno.resourceKeys.has(propName))
                continue;
            const isAssociation = String(cdsType).toLowerCase().includes("association");
            if (isAssociation) {
                for (const fk of expandAssociationKeys(def, propName)) {
                    if (args[fk.fkColumn] !== undefined) {
                        updates[fk.fkColumn] = coerceScalarForType(args[fk.fkColumn], fk.fullCdsType);
                    }
                }
                continue;
            }
            if (args[propName] !== undefined)
                updates[propName] = coerceScalarForField(args[propName], propName, def);
        }
        if (Object.keys(updates).length === 0) {
            return (0, utils_2.toolError)("NO_FIELDS", "No fields provided to patch");
        }
        logDraftOp("patch", resAnno, keys);
        const outerUserIdPatch = global.cds?.context?.user?.id;
        try {
            const row = await withTimeout(svc.tx({ user: (0, utils_1.getAccessRights)(authEnabled) }, async (tx) => {
                logDraftTxDispatch("patch", outerUserIdPatch, tx);
                await tx.run(UPDATE(resAnno.target).set(updates).where(keys));
                // Re-read the draft so the LLM sees the concrete row (CAP's
                // UPDATE returns an affected-row count, not the row itself).
                return tx.run(SELECT.from(resAnno.target).where(keys));
            }), TIMEOUT_MS, toolName);
            const result = Array.isArray(row) ? row[0] ?? null : row ?? null;
            return (0, utils_2.asMcpResult)((0, utils_2.applyOmissionFilter)(result, resAnno) ?? null);
        }
        catch (error) {
            const cls = classifyCapError(error, "DRAFT_PATCH_FAILED", toolName);
            return (0, utils_2.toolError)(cls.code, cls.msg, undefined, error);
        }
    };
    server.registerTool(toolName, { title: toolName, description: desc, inputSchema }, handler);
}
/**
 * Registers the `draft-activate` tool: activates an existing draft via
 * CAP's 'SAVE' event (aka draftActivate). Returns the freshly activated
 * row. Validation failures (`@mandatory`, `@assert.*`) surface as
 * DRAFT_ACTIVATE_FAILED with the CAP message passed through.
 */
function registerDraftActivateTool(resAnno, server, authEnabled) {
    const toolName = nameFor(resAnno, "draft-activate");
    const inputSchema = {};
    for (const [k, cdsType] of resAnno.resourceKeys.entries()) {
        if (k === "IsActiveEntity")
            continue;
        inputSchema[k] = (0, utils_2.determineMcpParameterType)(cdsType).describe(`Key ${k}. ${resAnno.propertyHints.get(k) ?? ""}`);
    }
    const keyList = Array.from(resAnno.resourceKeys.keys()).filter((k) => k !== "IsActiveEntity").join(", ");
    const hint = constructHintMessage(resAnno, "update");
    const desc = `Resource description: ${resAnno.description}. Activate (publish) the pending draft of ${resAnno.target} by key(s): ${keyList}. Requires a draft to exist; otherwise returns DRAFT_NOT_FOUND.${hint}`;
    const handler = async (args) => {
        const svc = await resolveServiceInstance(resAnno.serviceName);
        if (!svc) {
            return (0, utils_2.toolError)("ERR_MISSING_SERVICE", `Service not found: ${resAnno.serviceName}`);
        }
        const extracted = extractBusinessKeys(args, resAnno, toolName, "activate");
        if (extracted.error)
            return extracted.error;
        logDraftOp("activate", resAnno, extracted.keys);
        try {
            const response = await withTimeout(svc.tx({ user: (0, utils_1.getAccessRights)(authEnabled) }, (tx) => tx.send("SAVE", resAnno.target, extracted.keys)), TIMEOUT_MS, toolName);
            return (0, utils_2.asMcpResult)((0, utils_2.applyOmissionFilter)(response, resAnno) ?? {});
        }
        catch (error) {
            const cls = classifyCapError(error, "DRAFT_ACTIVATE_FAILED", toolName);
            return (0, utils_2.toolError)(cls.code, cls.msg, undefined, error);
        }
    };
    server.registerTool(toolName, { title: toolName, description: desc, inputSchema }, handler);
}
/**
 * Registers the `draft-discard` tool: deletes a pending draft without
 * touching the active row. Implemented as DELETE on the draft selector;
 * CAP routes this through the CANCEL/DISCARD draft handlers.
 */
function registerDraftDiscardTool(resAnno, server, authEnabled) {
    const toolName = nameFor(resAnno, "draft-discard");
    const inputSchema = {};
    for (const [k, cdsType] of resAnno.resourceKeys.entries()) {
        if (k === "IsActiveEntity")
            continue;
        inputSchema[k] = (0, utils_2.determineMcpParameterType)(cdsType).describe(`Key ${k}. ${resAnno.propertyHints.get(k) ?? ""}`);
    }
    const keyList = Array.from(resAnno.resourceKeys.keys()).filter((k) => k !== "IsActiveEntity").join(", ");
    const hint = constructHintMessage(resAnno, "delete");
    const desc = `Resource description: ${resAnno.description}. Discard the pending draft of ${resAnno.target} by key(s): ${keyList}. The active row is untouched. This operation cannot be undone.${hint}`;
    const handler = async (args) => {
        const svc = await resolveServiceInstance(resAnno.serviceName);
        if (!svc) {
            return (0, utils_2.toolError)("ERR_MISSING_SERVICE", `Service not found: ${resAnno.serviceName}`);
        }
        const extracted = extractBusinessKeys(args, resAnno, toolName, "discard");
        if (extracted.error)
            return extracted.error;
        logDraftOp("discard", resAnno, extracted.keys);
        try {
            // Route through CAP's 'CANCEL' event on the .drafts sibling — the
            // draft runtime wires CANCEL to onCancel, which handles lock
            // validation + cascading deletes of nested draft compositions.
            await withTimeout(svc.tx({ user: (0, utils_1.getAccessRights)(authEnabled) }, (tx) => tx.send("CANCEL", `${resAnno.target}.drafts`, extracted.keys)), TIMEOUT_MS, toolName);
            return (0, utils_2.asMcpResult)({ discarded: true, keys: extracted.keys });
        }
        catch (error) {
            const cls = classifyCapError(error, "DRAFT_DISCARD_FAILED", toolName);
            return (0, utils_2.toolError)(cls.code, cls.msg, undefined, error);
        }
    };
    server.registerTool(toolName, { title: toolName, description: desc, inputSchema }, handler);
}
/**
 * Registers the `draft-upsert` tool: creates a draft AND activates it in a
 * single server-side transaction. Purpose-built for stateless MCP clients
 * where draft-new and draft-activate would otherwise run in separate HTTP
 * requests — any drift in `cds.context.user.id` between those requests
 * surfaces as DRAFT_LOCKED on the second call (the lock holder set by NEW
 * no longer matches the principal attempting the SAVE).
 *
 * Inside this handler the `svc.tx({user}, async tx => …)` callback runs NEW
 * then SAVE on the same `tx`, so the authenticated principal is guaranteed
 * stable across both events. Throwing inside the callback rolls the draft
 * back — the caller never sees an orphan pending draft from a failed SAVE.
 *
 * Accepts the same input shape as `draft-new`. Returns the activated row.
 * Prefer this tool for "one-shot" create flows where the LLM has all the
 * required fields up front; use the discrete draft-new / draft-patch /
 * draft-activate trio only when the caller needs to inspect the pending
 * draft or fill fields iteratively across turns.
 */
function registerDraftUpsertTool(resAnno, server, authEnabled) {
    const toolName = nameFor(resAnno, "draft-upsert");
    const inputSchema = {};
    const entityDef = resolveEntityDefinition(resAnno);
    for (const [propName, cdsType] of resAnno.properties.entries()) {
        const isAssociation = String(cdsType).toLowerCase().includes("association");
        const isComputed = resAnno.computedFields?.has(propName);
        if (isAssociation) {
            for (const fk of expandAssociationKeys(entityDef, propName)) {
                inputSchema[fk.fkColumn] = (0, utils_2.determineMcpParameterType)(fk.cdsType)
                    .optional()
                    .describe(`FK to ${propName}.${fk.targetKey}. ${resAnno.propertyHints.get(propName) ?? ""}`);
            }
            continue;
        }
        if (isComputed) continue;
        inputSchema[propName] = (0, utils_2.determineMcpParameterType)(cdsType, propName, `${resAnno.serviceName}.${resAnno.target}`)
            .optional()
            .describe(resAnno.foreignKeys.has(propName)
            ? `Foreign key to ${resAnno.foreignKeys.get(propName)} on ${propName}. ${resAnno.propertyHints.get(propName) ?? ""}`
            : `Field ${propName}. ${resAnno.propertyHints.get(propName) ?? ""}`);
    }
    const hint = constructHintMessage(resAnno, "create");
    const desc = `Resource description: ${resAnno.description}. One-shot create: opens a draft of ${resAnno.target} and immediately activates it in a single transaction. Use this when you have all required fields up front — safer than ${nameFor(resAnno, "draft-new")} + ${nameFor(resAnno, "draft-activate")} across two calls, because the principal stays consistent (no cross-call DRAFT_LOCKED).${hint}`;
    const handler = async (args) => {
        const svc = await resolveServiceInstance(resAnno.serviceName);
        if (!svc) {
            return (0, utils_2.toolError)("ERR_MISSING_SERVICE", `Service not found: ${resAnno.serviceName}`);
        }
        const data = {};
        const def = resolveEntityDefinition(resAnno);
        for (const [propName, cdsType] of resAnno.properties.entries()) {
            const isAssociation = String(cdsType).toLowerCase().includes("association");
            if (isAssociation) {
                for (const fk of expandAssociationKeys(def, propName)) {
                    if (args[fk.fkColumn] !== undefined) {
                        data[fk.fkColumn] = coerceScalarForType(args[fk.fkColumn], fk.fullCdsType);
                    }
                }
                continue;
            }
            if (args[propName] !== undefined)
                data[propName] = coerceScalarForField(args[propName], propName, def);
        }
        logDraftOp("upsert", resAnno, data);
        try {
            const activated = await withTimeout(svc.tx({ user: (0, utils_1.getAccessRights)(authEnabled) }, async (tx) => {
                // 1. NEW — returns the inserted draft row with any CAP-generated keys.
                const draftRow = await tx.send("NEW", `${resAnno.target}.drafts`, data);
                // 2. Gather business keys for SAVE, preferring what the caller supplied
                //    and falling back to whatever CAP put on the draft row (UUIDs for
                //    @cuid roots, etc.). IsActiveEntity is never a business key here.
                const saveKeys = {};
                for (const k of resAnno.resourceKeys.keys()) {
                    if (k === "IsActiveEntity") continue;
                    if (data[k] !== undefined) saveKeys[k] = data[k];
                    else if (draftRow && draftRow[k] !== undefined) saveKeys[k] = draftRow[k];
                }
                // 3. SAVE on the SAME tx — same user, no cross-call lock check.
                return await tx.send("SAVE", resAnno.target, saveKeys);
            }), TIMEOUT_MS, toolName);
            return (0, utils_2.asMcpResult)((0, utils_2.applyOmissionFilter)(activated, resAnno) ?? {});
        }
        catch (error) {
            const cls = classifyCapError(error, "DRAFT_UPSERT_FAILED", toolName);
            return (0, utils_2.toolError)(cls.code, cls.msg, undefined, error);
        }
    };
    server.registerTool(toolName, { title: toolName, description: desc, inputSchema }, handler);
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
    // Draft-aware WHERE: only applied on draft-enabled roots (enforced by the
    // Zod schema — `IsActiveEntity` isn't in the shape for non-draft entities).
    if (typeof args.IsActiveEntity === "boolean") {
        qy = qy.where({ IsActiveEntity: args.IsActiveEntity });
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
