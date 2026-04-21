"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseExpand = parseExpand;
exports.resolveExpand = resolveExpand;
exports.listExpandableNavigations = listExpandableNavigations;
const validation_1 = require("./validation");
/* @ts-ignore */
const cds = global.cds || require("@sap/cds");

/**
 * Lightweight recursive-descent parser for a safe subset of OData v4 $expand.
 *
 * Grammar:
 *   expand      := expandItem ("," expandItem)*
 *   expandItem  := navProp ("(" option (";" option)* ")")?
 *   option      := "$select=" selectList
 *                | "$filter=" filterExpr
 *                | "$top=" posInt
 *                | "$skip=" nonNegInt
 *                | "$orderby=" orderByList
 *                | "$expand=" expand
 *
 * Why hand-rolled instead of delegating to `@sap/cds/libx/odata/parse/`:
 * that path is not a public CAP API. The grammar here is small and
 * deterministic, so keeping it in-plugin avoids leaning on internals.
 */

function isNavCharStart(ch) {
    return /[A-Za-z_]/.test(ch);
}
function isNavChar(ch) {
    return /[A-Za-z0-9_]/.test(ch);
}

/**
 * Parse an $expand string into an array of CQN expand column specs.
 * Schema-aware: rejects nav props that don't exist on the provided entity,
 * and recursively descends through the CSN for nested expands.
 *
 * @param {string} input — raw $expand value from the client
 * @param {object} ctx — { entityDef, modelDefs, maxDepth, maxBreadth }
 * @returns {Array<object>} CQN column specs like
 *   `{ ref: ['books'], expand: ['*'|subcolumns], where, limit, orderBy }`
 */
function parseExpand(input, ctx) {
    if (typeof input !== "string" || input.trim().length === 0) {
        return [];
    }
    const maxDepth = ctx?.maxDepth ?? 3;
    const maxBreadth = ctx?.maxBreadth ?? 20;
    const state = {
        src: input,
        pos: 0,
        depth: 0,
        maxDepth,
        maxBreadth,
        modelDefs: ctx?.modelDefs,
    };
    const columns = parseExpandList(state, ctx.entityDef);
    skipWs(state);
    if (state.pos < state.src.length) {
        throw new Error(`$expand: unexpected trailing input at position ${state.pos} ("${state.src.slice(state.pos, state.pos + 16)}")`);
    }
    return columns;
}

function parseExpandList(state, entityDef) {
    if (state.depth > state.maxDepth) {
        throw new Error(`$expand: nesting depth exceeds max_depth=${state.maxDepth}`);
    }
    const items = [];
    while (true) {
        skipWs(state);
        const item = parseExpandItem(state, entityDef);
        items.push(item);
        if (items.length > state.maxBreadth) {
            throw new Error(`$expand: breadth at one level exceeds max_breadth=${state.maxBreadth}`);
        }
        skipWs(state);
        if (state.src[state.pos] === ",") {
            state.pos++;
            continue;
        }
        break;
    }
    return items;
}

function parseExpandItem(state, entityDef) {
    const navName = readIdent(state);
    if (!navName) {
        throw new Error(`$expand: expected navigation property at position ${state.pos}`);
    }
    const navDef = entityDef?.elements?.[navName];
    if (!navDef || (navDef.type !== "cds.Composition" && navDef.type !== "cds.Association")) {
        const allowed = Object.entries(entityDef?.elements ?? {})
            .filter(([, v]) => v.type === "cds.Composition" || v.type === "cds.Association")
            .map(([k]) => k)
            .join(", ") || "(none)";
        throw new Error(`$expand: unknown navigation property "${navName}". Allowed: ${allowed}`);
    }
    const targetDef = state.modelDefs?.[navDef.target];
    const col = { ref: [navName] };
    skipWs(state);
    if (state.src[state.pos] !== "(") {
        // No subquery — flat expand with all scalars, no recursion.
        col.expand = ["*"];
        return col;
    }
    // consume "(" … ")"
    state.pos++;
    const options = parseOptionList(state, targetDef);
    skipWs(state);
    if (state.src[state.pos] !== ")") {
        throw new Error(`$expand: expected ")" at position ${state.pos}`);
    }
    state.pos++;
    applyOptionsToColumn(col, options, targetDef);
    return col;
}

function parseOptionList(state, targetDef) {
    const opts = {};
    skipWs(state);
    // Empty option list is allowed: `nav()` → same as `nav`.
    if (state.src[state.pos] === ")") return opts;
    while (true) {
        skipWs(state);
        const key = readOptionKey(state);
        if (!key) {
            throw new Error(`$expand: expected option (e.g. $select, $filter, …) at position ${state.pos}`);
        }
        if (state.src[state.pos] !== "=") {
            throw new Error(`$expand: expected "=" after "${key}" at position ${state.pos}`);
        }
        state.pos++;
        const value = readOptionValue(state);
        switch (key) {
            case "$select":
                opts.select = value;
                break;
            case "$filter":
                opts.filter = value;
                break;
            case "$top": {
                const n = Number(value);
                if (!Number.isInteger(n) || n < 1) {
                    throw new Error(`$expand: $top must be a positive integer, got "${value}"`);
                }
                opts.top = n;
                break;
            }
            case "$skip": {
                const n = Number(value);
                if (!Number.isInteger(n) || n < 0) {
                    throw new Error(`$expand: $skip must be a non-negative integer, got "${value}"`);
                }
                opts.skip = n;
                break;
            }
            case "$orderby":
                opts.orderby = value;
                break;
            case "$expand":
                // Recurse: parse the nested expand string against the nav's target.
                state.depth++;
                try {
                    const sub = {
                        src: value,
                        pos: 0,
                        depth: state.depth,
                        maxDepth: state.maxDepth,
                        maxBreadth: state.maxBreadth,
                        modelDefs: state.modelDefs,
                    };
                    opts.expand = parseExpandList(sub, targetDef);
                    skipWs(sub);
                    if (sub.pos < sub.src.length) {
                        throw new Error(`$expand: trailing input in nested expand at sub-position ${sub.pos}`);
                    }
                }
                finally {
                    state.depth--;
                }
                break;
            default:
                throw new Error(`$expand: unknown option "${key}"`);
        }
        skipWs(state);
        if (state.src[state.pos] === ";") {
            state.pos++;
            continue;
        }
        break;
    }
    return opts;
}

function applyOptionsToColumn(col, options, targetDef) {
    // Build the inner `expand` array: $select → specific columns; else '*' + nested expands.
    const inner = [];
    if (options.select) {
        // Validate $select using the subquery entity's allowed properties.
        const props = new Map(Object.entries(targetDef?.elements ?? {})
            .filter(([, v]) => v.type && !["cds.Composition", "cds.Association"].includes(v.type))
            .map(([k, v]) => [k, String(v.type).replace("cds.", "")]));
        const validator = new validation_1.ODataQueryValidator(props);
        const cols = validator.validateSelect(options.select);
        for (const c of cols) inner.push({ ref: [c] });
    }
    else {
        inner.push("*");
    }
    if (options.expand && options.expand.length > 0) {
        for (const sub of options.expand) inner.push(sub);
    }
    col.expand = inner;
    if (options.filter) {
        // Validate inside the subquery's property scope, then translate to CDS.
        const props = new Map(Object.entries(targetDef?.elements ?? {})
            .filter(([, v]) => v.type && !["cds.Composition", "cds.Association"].includes(v.type))
            .map(([k, v]) => [k, String(v.type).replace("cds.", "")]));
        const validator = new validation_1.ODataQueryValidator(props);
        const cdsExpr = validator.validateFilter(options.filter);
        const parsed = (global.cds || cds).parse.expr(cdsExpr);
        col.where = parsed.xpr ?? parsed;
    }
    if (options.top !== undefined || options.skip !== undefined) {
        col.limit = {
            rows: { val: options.top ?? 200 },
            offset: options.skip !== undefined ? { val: options.skip } : undefined,
        };
    }
    if (options.orderby) {
        const props = new Map(Object.entries(targetDef?.elements ?? {})
            .filter(([, v]) => v.type && !["cds.Composition", "cds.Association"].includes(v.type))
            .map(([k, v]) => [k, String(v.type).replace("cds.", "")]));
        const validator = new validation_1.ODataQueryValidator(props);
        const validated = validator.validateOrderBy(options.orderby);
        col.orderBy = validated.split(",").map((frag) => {
            const [field, dir] = frag.trim().split(/\s+/);
            return { ref: [field], sort: (dir || "asc").toLowerCase() };
        });
    }
}

function skipWs(state) {
    while (state.pos < state.src.length && /\s/.test(state.src[state.pos])) state.pos++;
}

function readIdent(state) {
    skipWs(state);
    if (state.pos >= state.src.length) return "";
    if (!isNavCharStart(state.src[state.pos])) return "";
    let start = state.pos;
    while (state.pos < state.src.length && isNavChar(state.src[state.pos])) state.pos++;
    return state.src.slice(start, state.pos);
}

function readOptionKey(state) {
    skipWs(state);
    if (state.src[state.pos] !== "$") return "";
    let start = state.pos;
    state.pos++;
    while (state.pos < state.src.length && /[a-zA-Z]/.test(state.src[state.pos])) state.pos++;
    return state.src.slice(start, state.pos);
}

/**
 * Read until we hit `;` or `)` at the current paren level. Supports nested
 * parens — required because nested $expand subqueries introduce them.
 */
function readOptionValue(state) {
    let depth = 0;
    let start = state.pos;
    while (state.pos < state.src.length) {
        const ch = state.src[state.pos];
        if (ch === "(") depth++;
        else if (ch === ")") {
            if (depth === 0) break;
            depth--;
        }
        else if (ch === ";" && depth === 0) break;
        state.pos++;
    }
    return state.src.slice(start, state.pos).trim();
}

/**
 * Return the list of nav props on an entity that would be expanded if the
 * given mode were applied. Used both at tool-description build time (to
 * document what is available) and at runtime for implicit expansion.
 */
function listExpandableNavigations(entityDef, mode) {
    const out = [];
    if (mode === "none") return out;
    for (const [name, el] of Object.entries(entityDef?.elements ?? {})) {
        if (el.type === "cds.Composition") {
            out.push({ name, kind: "Composition", target: el.target });
        }
        else if (el.type === "cds.Association" && mode === "all") {
            out.push({ name, kind: "Association", target: el.target });
        }
    }
    return out;
}

/**
 * Combined entry point for the runtime hot path: either parse a
 * user-supplied $expand or fall back to the default policy for the entity.
 *
 * `userExpand === ""` is treated as an explicit opt-out (no expand at all),
 * letting clients call `{ expand: "" }` to override `expand.default`.
 *
 * @param {object} opts
 * @param {string|undefined} opts.userExpand — raw client input, if any
 * @param {"compositions"|"none"|"all"} opts.defaultMode
 * @param {object} opts.entityDef — CSN entity being queried
 * @param {Record<string,object>} opts.modelDefs — full model definitions for nav-target lookup
 * @param {{max_depth:number, max_breadth:number}} opts.limits
 * @returns {Array<object>} CQN column specs to merge into SELECT.columns(...)
 */
function resolveExpand(opts) {
    const { userExpand, defaultMode, entityDef, modelDefs, limits } = opts;
    if (typeof userExpand === "string") {
        if (userExpand.trim().length === 0) return [];
        return parseExpand(userExpand, {
            entityDef,
            modelDefs,
            maxDepth: limits?.max_depth ?? 3,
            maxBreadth: limits?.max_breadth ?? 20,
        });
    }
    const navs = listExpandableNavigations(entityDef, defaultMode || "compositions");
    return navs.map((n) => ({ ref: [n.name], expand: ["*"] }));
}
