"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerApps = registerApps;

const logger_1 = require("../logger");
const ui_parser_1 = require("../annotations/ui-parser");
const template_generator_1 = require("./apps/template-generator");

/**
 * MCP Apps registration for CAP entities annotated with @UI.* Fiori annotations.
 *
 * For each entity in `annotations` that:
 *   a) is a McpResourceAnnotation with wrap.tools enabled, AND
 *   b) carries @UI.LineItem or @UI.FieldGroup# annotations in the CSN model
 *
 * this module registers two MCP resources:
 *   - ui://query/<entityKey>  — responsive table for query/list results
 *   - ui://detail/<entityKey> — field-group detail card for get results
 *
 * The corresponding `query` and `get` tools are patched with
 *   `_meta: { ui: { resourceUri: "ui://..." } }`
 * so compliant MCP clients (Claude, ChatGPT, VS Code) render the iframe UI
 * alongside the tool call result.
 *
 * MIME type: "text/html;profile=mcp-app" as per MCP Apps spec SEP-1865.
 *
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {Map<string, import("../annotations/structures").McpAnnotation>} annotations
 * @param {import("../config/loader").Config} config
 */
function registerApps(server, annotations, config) {
    if (!config.apps?.enabled) return;

    // Model is available globally after cds.loaded fires — createMcpServer is
    // always called after that lifecycle event so this is safe.
    const CDS = global.cds;
    const model = CDS?.model;
    if (!model?.definitions) return;

    let registered = 0;
    for (const [key, entry] of annotations.entries()) {
        // Only process resource annotations with tool wrapping
        const { McpResourceAnnotation } = require("../annotations/structures");
        if (!(entry instanceof McpResourceAnnotation)) continue;

        const globalWrap = !!config.wrap_entities_to_actions;
        const localWrap = entry.wrap?.tools;
        const wrapEnabled = localWrap === true || (localWrap === undefined && globalWrap);
        if (!wrapEnabled) continue;

        const entityTarget = `${entry.serviceName}.${entry.target}`;
        const def = model.definitions[entityTarget];
        if (!def) continue;

        const uiMeta = ui_parser_1.parseUiAnnotations(def);
        if (!uiMeta) continue;

        const modes = entry.wrap?.modes ?? config.wrap_entity_modes ?? ["query", "get"];
        const entityKey = `${entry.serviceName}_${entry.target}`;
        // Server/app name shown next to the SAP logo in the shell bar
        // (cds.mcp.name → falls back to the npm package name).
        const appTitle = config.name || "MCP";
        // Write capabilities (Create/Edit/Delete) the app can drive by calling
        // the entity's write tools back through the host.
        const writeSpec = _buildWriteSpec(entry, def, modes);

        if (uiMeta.lineItems.length > 0 && modes.includes("query")) {
            const uri = `ui://query/${entityKey}`;
            _registerAppResource(server, `${entry.target} list`, uri, uiMeta, "query", appTitle, writeSpec);
            _patchToolMeta(server, entry, "query", uri, config);
            registered++;
        }

        // Detail view: useful when fieldGroups, facets, or dataPoints are present
        const hasDetailContent =
            Object.keys(uiMeta.fieldGroups).length > 0 ||
            uiMeta.facets?.length > 0 ||
            Object.keys(uiMeta.dataPoints ?? {}).length > 0;
        if (hasDetailContent && modes.includes("get")) {
            const uri = `ui://detail/${entityKey}`;
            _registerAppResource(server, `${entry.target} detail`, uri, uiMeta, "detail", appTitle, writeSpec);
            _patchToolMeta(server, entry, "get", uri, config);
            registered++;
        }
    }

    if (registered > 0) {
        logger_1.LOGGER.debug(`[MCP Apps] Registered ${registered} UI resource(s) from @UI annotations`);
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const { toolNameFor } = require("./entity-tools");
const { applyToolNamePrefix } = require("../config/loader");
const { UI5_CDN_ORIGIN } = require("./apps/template-generator");

/**
 * MCP Apps CSP for the rendered iframe. The templates progressively enhance
 * with SAP UI5 Web Components fetched from a CDN, so the host must allow that
 * origin for scripts/styles/fonts (resourceDomains) and runtime asset fetches
 * (connectDomains). Hosts that ignore/deny this still get the self-contained
 * CSS fallback (no external load required).
 */
const APP_CSP = {
    // esm.sh — UI5 Web Components ESM; ui5.sap.com — official SAP logo asset
    // (and SAPUI5 framework if used as the rendering engine).
    resourceDomains: [UI5_CDN_ORIGIN, "https://ui5.sap.com"],
    connectDomains: [UI5_CDN_ORIGIN, "https://ui5.sap.com"],
};

/**
 * Registers an MCP resource with the HTML template as content.
 * @param {*} server
 * @param {string} name
 * @param {string} uri
 * @param {object} uiMeta
 * @param {"query"|"detail"} templateKind
 */
const _DRAFT_INTERNAL = new Set([
    "IsActiveEntity", "HasActiveEntity", "HasDraftEntity", "SiblingEntity",
    "SiblingEntity_ID", "DraftAdministrativeData", "DraftAdministrativeData_DraftUUID",
]);

/** Maps a CDS type to a coarse HTML-input category for the write form. */
function _simpleType(cdsType) {
    const t = String(cdsType || "").toLowerCase();
    if (/(integer|int16|int32|int64|uint8|decimal|double|float)/.test(t)) return "number";
    if (/boolean/.test(t)) return "boolean";
    if (/timestamp|datetime/.test(t)) return "datetime";
    if (/date/.test(t)) return "date";
    return "text";
}

/** Humanises a field/FK name for a form label. */
function _humanize(name) {
    return String(name)
        .replace(/_(ID|code|id|Code)$/, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Computes the write capabilities the MCP App can drive for an entity: which
 * actions are allowed (by @mcp.wrap.modes), the actual (prefixed) tool name for
 * each, and the writable form-field spec. Draft-enabled roots route create/edit
 * through the one-shot `draft-upsert` tool; non-draft roots use create/update.
 *
 * @param {import("../annotations/structures").McpResourceAnnotation} entry
 * @param {object} def - CSN entity definition
 * @param {string[]} modes - effective @mcp.wrap.modes
 * @returns {object} writeSpec
 */
function _buildWriteSpec(entry, def, modes) {
    const draft = !!(def && (def["@odata.draft.enabled"] === true || def["@fiori.draft.enabled"] === true));
    const nm = (suffix) =>
        applyToolNamePrefix(toolNameFor({ serviceName: entry.serviceName, target: entry.target, mcpName: entry.name }, suffix));

    const computed = entry.computedFields || new Set();
    const omitted = entry.omittedFields || new Set();
    const keysMap = entry.resourceKeys || new Map();
    const props = entry.properties || new Map();
    const fks = entry.foreignKeys || new Map();

    // Addressing keys for update/delete (exclude the draft selector).
    const keyFields = [];
    for (const [k, t] of keysMap.entries()) {
        if (k === "IsActiveEntity") continue;
        keyFields.push({ name: k, type: _simpleType(t), computed: computed.has(k) });
    }

    // Editable non-key fields: scalars + association FK columns.
    const fields = [];
    const seen = new Set();
    for (const [name, cdsType] of props.entries()) {
        if (_DRAFT_INTERNAL.has(name) || omitted.has(name) || keysMap.has(name)) continue;
        const lower = String(cdsType).toLowerCase();
        if (lower.includes("composition")) continue;
        if (lower.includes("association")) {
            const fk = `${name}_ID`;
            if (!seen.has(fk)) { seen.add(fk); fields.push({ name: fk, label: _humanize(name), type: "text", fk: true }); }
            continue;
        }
        if (computed.has(name) || seen.has(name)) continue;
        seen.add(name);
        fields.push({ name, label: _humanize(name), type: _simpleType(cdsType), fk: fks.has(name) });
    }

    return {
        draft,
        create: modes.includes("create") ? { tool: draft ? nm("draft-upsert") : nm("create") } : null,
        update: modes.includes("update") ? { tool: draft ? nm("draft-upsert") : nm("update") } : null,
        del: modes.includes("delete") ? { tool: nm("delete") } : null,
        queryTool: nm("query"),
        getTool: nm("get"),
        keyFields,
        fields,
    };
}

function _registerAppResource(server, name, uri, uiMeta, templateKind, appTitle, writeSpec) {
    try {
        const entityName = uri.split("/").pop() ?? name;
        const html =
            templateKind === "query"
                ? template_generator_1.buildQueryTemplate(entityName, uiMeta, appTitle, writeSpec)
                : template_generator_1.buildDetailTemplate(entityName, uiMeta, appTitle, writeSpec);

        server.registerResource(
            name,
            uri,
            { mimeType: MCP_APP_MIME_TYPE, _meta: { ui: { csp: APP_CSP } } },
            async (_uri) => ({
                contents: [
                    { uri: uri, mimeType: MCP_APP_MIME_TYPE, text: html, _meta: { ui: { csp: APP_CSP } } },
                ],
            }),
        );
        logger_1.LOGGER.debug(`[MCP Apps] Registered resource ${uri}`);
    } catch (e) {
        logger_1.LOGGER.warn(`[MCP Apps] Failed to register resource ${uri}:`, e?.message ?? e);
    }
}

/**
 * Patches the _meta on an already-registered tool to include the ui.resourceUri.
 * The MCP SDK stores registered tools on server._registeredTools; we update the
 * _meta property of the matching tool object after registration.
 * @param {*} server
 * @param {import("../annotations/structures").McpResourceAnnotation} entry
 * @param {"query"|"get"} mode
 * @param {string} uri
 * @param {object} config
 */
function _patchToolMeta(server, entry, mode, uri, config) {
    try {
        const baseName = toolNameFor(
            { serviceName: entry.serviceName, target: entry.target, mcpName: entry.name },
            mode
        );
        const prefixedName = applyToolNamePrefix(baseName);
        const registry = server._registeredTools;
        if (!registry) return;

        const tool = registry[prefixedName] ?? registry[baseName];
        if (!tool) {
            logger_1.LOGGER.debug(`[MCP Apps] Tool not found for meta-patch: ${prefixedName}`);
            return;
        }
        tool._meta = { ...(tool._meta ?? {}), ui: { resourceUri: uri } };
        logger_1.LOGGER.debug(`[MCP Apps] Patched tool ${prefixedName} with ui.resourceUri=${uri}`);
    } catch (e) {
        logger_1.LOGGER.warn(`[MCP Apps] Failed to patch tool meta for ${entry.target}/${mode}:`, e?.message ?? e);
    }
}
