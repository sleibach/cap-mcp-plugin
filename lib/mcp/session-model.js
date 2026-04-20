"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applySessionModel = applySessionModel;
const logger_1 = require("../logger");
/**
 * Programmatically injects a CSN entity definition that backs the DB-based
 * MCP session store. Called from cds.on('loaded') so the entity is present
 * before the model is compiled and before `cds deploy` creates the table.
 *
 * Mirrors the pattern used by cap-collaborative-draft's model-augmenter:
 * mutate `model.definitions` in place with a minimal entity CSN fragment.
 *
 * The entity intentionally carries no tenant column. When the hosting app is
 * multi-tenant, CAP's tenant middleware isolates reads/writes at query time
 * via the ambient `cds.context`, and the per-tenant schema / table prefix
 * keeps rows separated physically.
 *
 * @param {object} model - CSN model (cds.model or the argument of onLoaded)
 * @param {string} entityName - Fully-qualified entity name (e.g. "cap.mcp.Sessions")
 */
function applySessionModel(model, entityName) {
    if (!model || !model.definitions) {
        logger_1.LOGGER.warn(`[SESSION-STORE] Cannot inject ${entityName} — CSN model has no definitions map`);
        return;
    }
    if (model.definitions[entityName]) {
        // Someone else defined the same entity — trust them and don't overwrite.
        logger_1.LOGGER.debug(`[SESSION-STORE] Entity ${entityName} already present in CSN; skipping injection`);
        return;
    }
    model.definitions[entityName] = {
        kind: "entity",
        "@cds.persistence.skip": false,
        elements: {
            session_id:  { key: true, type: "cds.String", length: 64, notNull: true },
            created_at:  { type: "cds.Timestamp", notNull: true },
            last_access: { type: "cds.Timestamp", notNull: true },
        },
    };
    logger_1.LOGGER.debug(`[SESSION-STORE] Injected CSN entity ${entityName} for DB-backed session store`);
}
