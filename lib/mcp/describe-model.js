"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDescribeModelTool = registerDescribeModelTool;
exports.registerWhoAmITool = registerWhoAmITool;
const utils_1 = require("./utils");
const zod_1 = require("zod");
/**
 * Registers a `cap_whoami` introspection tool. Returns the plugin's view of
 * the caller — id, roles, tenant, privileged/anonymous flags — and the raw
 * auth headers the request arrived with. Indispensable for diagnosing
 * DRAFT_LOCKED / 403s where the on-call can't tell which principal CAP
 * actually resolved inside the MCP tool handler.
 *
 * Always registered (no @mcp annotation required) so it's available even
 * when all other tools reject the caller.
 */
function registerWhoAmITool(server) {
    server.registerTool("cap_whoami", {
        title: "cap_whoami",
        description: "Return the authenticated principal the plugin sees for this MCP call (id, roles, tenant, privileged / anonymous flags). Use this when DRAFT_LOCKED, 403, or authorization-related errors don't match the user you expect to be driving the call — the answer tells you exactly what identity CAP's auth middleware resolved, which is the one used for all downstream CAP service calls.",
        inputSchema: {},
    }, async () => {
        const CDS = global.cds;
        const ctx = CDS?.context;
        const u = ctx?.user;
        const snapshot = {
            context_present: !!ctx,
            user_present: !!u,
            user: u
                ? {
                    id: u.id ?? null,
                    is_privileged: !!u._is_privileged,
                    is_anonymous: !!u._is_anonymous,
                    tenant: u.tenant ?? ctx?.tenant ?? null,
                    roles: u.roles ? Object.keys(u.roles) : [],
                    attr: u.attr ?? null,
                }
                : null,
            tenant: ctx?.tenant ?? null,
            locale: ctx?.locale ?? null,
            diagnosis: !ctx
                ? "cds.context is undefined — the request never entered CAP's context middleware. Auth inheritance is broken on this route."
                : !u
                    ? "cds.context.user is undefined — CAP's auth middleware did not set a principal. MCP handlers will run as CAP's default (anonymous). Check that auth is enabled and the bearer token is valid."
                    : u._is_anonymous
                        ? "Caller is anonymous — CAP did not accept any bearer token on this request. DRAFT_LOCKED against any named user is expected."
                        : u._is_privileged
                            ? "Caller is privileged (internal system user). This is unusual for an interactive MCP call."
                            : `Caller resolved to '${u.id}'. DRAFT_LOCKED implies the holding user differs from this id.`,
        };
        return (0, utils_1.asMcpResult)(snapshot);
    });
}
/**
 * Registers a discovery tool that describes CAP services/entities and fields.
 * Helpful for models to plan correct tool calls without trial-and-error.
 */
function registerDescribeModelTool(server) {
    const inputZod = zod_1.z
        .object({
        service: zod_1.z.string().optional(),
        entity: zod_1.z.string().optional(),
        format: zod_1.z.enum(["concise", "detailed"]).default("concise").optional(),
    })
        .strict();
    const inputSchema = {
        service: inputZod.shape.service,
        entity: inputZod.shape.entity,
        format: inputZod.shape.format,
    };
    server.registerTool("cap_describe_model", {
        title: "cap_describe_model",
        description: "Describe CAP services/entities and their fields, keys, and example tool calls. Use this to guide LLMs how to call entity wrapper tools.",
        inputSchema,
    }, async (rawArgs) => {
        const args = inputZod.parse(rawArgs);
        const CDS = global.cds;
        const refl = CDS.reflect(CDS.model);
        const listServices = () => {
            const names = Object.values(CDS.services || {})
                .map((s) => s?.namespace || s?.definition?.name || s?.name)
                .filter(Boolean);
            return { services: [...new Set(names)].sort() };
        };
        const listEntities = (service) => {
            const all = Object.entries(refl.definitions || {})
                .filter((x) => x[1].kind == "entity" && !x[0].startsWith("cds.")) // ignore entities such as "cds.outbox.Messages"
                .map((x) => x[0]);
            const filtered = service
                ? all.filter((e) => e.startsWith(service + "."))
                : all;
            return {
                entities: filtered.sort(),
            };
        };
        const describeEntity = (service, entity) => {
            if (!entity)
                return { error: "Please provide 'entity'." };
            const fqn = service && !entity.includes(".") ? `${service}.${entity}` : entity;
            const ent = (refl.definitions || {})[fqn] || (refl.definitions || {})[entity];
            if (!ent)
                return {
                    error: `Entity not found: ${entity}${service ? ` (service ${service})` : ""}`,
                };
            const elements = Object.entries(ent.elements || {}).map(([name, el]) => ({
                name,
                type: el.type,
                key: !!el.key,
                target: el.target || undefined,
                isArray: !!el.items,
            }));
            const keys = elements.filter((e) => e.key).map((e) => e.name);
            const sampleTop = 5;
            // Prefer scalar fields for sample selects; exclude associations
            const scalarFields = elements
                .filter((e) => String(e.type).toLowerCase() !== "cds.association")
                .map((e) => e.name);
            const shortFields = scalarFields.slice(0, 5);
            // Match wrapper tool naming: Service_Entity_mode
            const entName = String(ent?.name || "entity");
            const svcPart = service || entName.split(".")[0] || "Service";
            const entityBase = entName.split(".").pop() || "Entity";
            const listName = `${svcPart}_${entityBase}_query`;
            const getName = `${svcPart}_${entityBase}_get`;
            return {
                service,
                entity: ent.name,
                keys,
                fields: elements,
                usage: {
                    rationale: "Entity wrapper tools expose CRUD-like operations for LLMs. Prefer query/get globally; create/update must be explicitly enabled by the developer.",
                    guidance: "Use the *_query tool for retrieval with filters and projections. All fields in select/where are consistent. For associations, use foreign key fields (e.g., author_ID not author). Use *_get with keys for a single record; use *_create/*_update only if enabled and necessary.",
                },
                examples: {
                    list_tool: listName,
                    list_tool_payload: {
                        top: sampleTop,
                        select: shortFields,
                    },
                    get_tool: getName,
                    get_tool_payload: keys.length ? { [keys[0]]: "<value>" } : {},
                },
            };
        };
        let json;
        if (!args.service && !args.entity) {
            json = { ...listServices(), ...listEntities(undefined) };
        }
        else if (args.service && !args.entity) {
            json = { service: args.service, ...listEntities(args.service) };
        }
        else {
            json = describeEntity(args.service, args.entity);
        }
        return (0, utils_1.asMcpResult)(json);
    });
}
