"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseUiAnnotations = parseUiAnnotations;
exports.hasUiAnnotations = hasUiAnnotations;

/**
 * Parses @UI.* and @Common.* Fiori annotations from a compiled CSN entity
 * definition into a UiMetadata object consumed by the MCP Apps template generator.
 *
 * IMPORTANT — CSN encoding the parser must cope with (verified against the
 * runtime `cds.model`, not the source CDS):
 *
 *   1. Struct-valued annotations are FLATTENED into dot-separated keys:
 *        @UI.HeaderInfo.TypeName, @UI.HeaderInfo.Title.Value,
 *        @UI.FieldGroup#Details.Label, @UI.FieldGroup#Details.Data,
 *        @UI.DataPoint#dp1.Value, @UI.DataPoint#dp1.Criticality
 *      Arrays are kept whole (@UI.LineItem, @UI.Facets, …Data).
 *
 *   2. Property paths are encoded as `{ "=": "field" }` (association traversal
 *      uses a dot: `{ "=": "status.criticality" }`). Expressions carry an extra
 *      `xpr` array, e.g. `{ "=": "size>0?3:1", xpr: [...] }`.
 *
 *   3. Enum values are encoded as `{ "#": "High" }`.
 *
 * Handles: @UI.LineItem(+qualifiers), @UI.LineItem@UI.Criticality (row-level),
 * @UI.FieldGroup#*, @UI.DataPoint#*, @UI.HeaderInfo, @UI.HeaderFacets,
 * @UI.Facets (Reference/Collection), @UI.Identification (actions),
 * @UI.SelectionFields, and element-level @UI.Hidden / @UI.HiddenFilter /
 * @UI.MultiLineText / @Common.Text / @Common.TextArrangement.
 *
 * DataField record variants: UI.DataField, UI.DataFieldWithCriticality,
 * UI.DataFieldWithUrl, UI.DataFieldForAction, UI.DataFieldForActionGroup,
 * UI.DataFieldForAnnotation.
 *
 * @param {object} def - Compiled CSN entity definition
 * @returns {UiMetadata|null}
 */
function parseUiAnnotations(def) {
    if (!def || def.kind !== "entity") return null;

    const lineItems = extractLineItems(def);
    const fieldGroups = extractFieldGroups(def);

    if (!lineItems.length && !Object.keys(fieldGroups).length) return null;

    return {
        lineItems,
        lineItemCriticality: extractLineItemCriticality(def),
        fieldGroups,
        dataPoints: extractDataPoints(def),
        headerInfo: extractHeaderInfo(def),
        headerFacets: extractHeaderFacets(def),
        facets: extractFacets(def),
        identification: extractIdentification(def),
        selectionFields: extractSelectionFields(def),
        ...extractElementMetadata(def),
    };
}

/**
 * Returns true when the entity carries a @UI.LineItem (any qualifier) or any
 * @UI.FieldGroup annotation usable for MCP App generation.
 * @param {object} def
 * @returns {boolean}
 */
function hasUiAnnotations(def) {
    if (!def || def.kind !== "entity") return false;
    return Object.keys(def).some(
        (k) => /^@UI\.LineItem(#|@|$)/.test(k) || k.startsWith("@UI.FieldGroup")
    );
}

// ---------------------------------------------------------------------------
// LineItem
// ---------------------------------------------------------------------------

/**
 * Extracts @UI.LineItem (default + qualifiers) as a column list.
 * Prefers the unqualified LineItem; falls back to the first qualified variant.
 * @param {object} def
 * @returns {Array<LineItemColumn>}
 */
function extractLineItems(def) {
    const candidates = ["@UI.LineItem"];
    // Qualified line items: @UI.LineItem#Foo (but NOT annotation-on-annotation
    // keys like @UI.LineItem.@UI.Criticality or @UI.LineItem@UI.Criticality)
    for (const k of Object.keys(def)) {
        if (/^@UI\.LineItem#[^.@]+$/.test(k)) candidates.push(k);
    }
    for (const key of candidates) {
        const raw = def[key];
        if (Array.isArray(raw) && raw.length) {
            return raw.flatMap((item) => {
                const col = parseDataFieldItem(item);
                return col ? [col] : [];
            });
        }
    }
    return [];
}

/**
 * Extracts the row-level criticality from @UI.LineItem@UI.Criticality.
 * Returns a usable property path when the annotation is a pure path; returns
 * null for complex expressions (which cannot be safely evaluated client-side).
 * @param {object} def
 * @returns {string|null}
 */
function extractLineItemCriticality(def) {
    const val =
        def["@UI.LineItem@UI.Criticality"] ??
        def["@UI.LineItem.@UI.Criticality"] ??
        def["@UI.LineItem@Criticality"];
    if (val === null || val === undefined) return null;
    // Expression (has xpr) — too complex to evaluate in the browser; skip.
    if (typeof val === "object" && Array.isArray(val.xpr)) return null;
    return resolveAnnotationPath(val);
}

// ---------------------------------------------------------------------------
// FieldGroup (reconstructed from flattened keys)
// ---------------------------------------------------------------------------

/**
 * Extracts all @UI.FieldGroup#<qualifier> definitions, reconstructing each from
 * its flattened `.Label` / `.Data` keys.
 * @param {object} def
 * @returns {Object<string, FieldGroupDef>}
 */
function extractFieldGroups(def) {
    const result = {};
    for (const qualifier of annotationQualifiers(def, "@UI.FieldGroup")) {
        const obj = readAnnotationObject(def, qualifierKey("@UI.FieldGroup", qualifier));
        if (!obj) continue;
        const fields = Array.isArray(obj.Data)
            ? obj.Data.flatMap((item) => {
                  const col = parseDataFieldItem(item);
                  return col ? [col] : [];
              })
            : [];
        result[qualifier] = { label: resolveLabel(obj.Label) ?? qualifier, fields };
    }
    return result;
}

// ---------------------------------------------------------------------------
// DataPoint (reconstructed from flattened keys)
// ---------------------------------------------------------------------------

/**
 * Extracts all @UI.DataPoint#<qualifier> definitions.
 * @param {object} def
 * @returns {Object<string, DataPointDef>}
 */
function extractDataPoints(def) {
    const result = {};
    for (const qualifier of annotationQualifiers(def, "@UI.DataPoint")) {
        const obj = readAnnotationObject(def, qualifierKey("@UI.DataPoint", qualifier));
        if (!obj) continue;
        result[qualifier] = {
            title: resolveLabel(obj.Title) ?? qualifier,
            valuePath: resolveAnnotationPath(obj.Value) ?? null,
            criticalityPath: resolveAnnotationPath(obj.Criticality) ?? null,
            trendPath: resolveAnnotationPath(obj.Trend) ?? null,
        };
    }
    return result;
}

// ---------------------------------------------------------------------------
// HeaderInfo (reconstructed from flattened keys)
// ---------------------------------------------------------------------------

/**
 * Extracts @UI.HeaderInfo for entity title, subtitle, and image.
 * @param {object} def
 * @returns {HeaderInfoDef|null}
 */
function extractHeaderInfo(def) {
    const raw = readAnnotationObject(def, "@UI.HeaderInfo");
    if (!raw) return null;
    return {
        typeName: resolveLabel(raw.TypeName) ?? null,
        typeNamePlural: resolveLabel(raw.TypeNamePlural) ?? null,
        titlePath: resolveAnnotationPath(raw.Title?.Value) ?? resolveAnnotationPath(raw.Title) ?? null,
        descriptionPath: resolveAnnotationPath(raw.Description?.Value) ?? resolveAnnotationPath(raw.Description) ?? null,
        imagePath: resolveAnnotationPath(raw.ImageUrl) ?? null,
    };
}

// ---------------------------------------------------------------------------
// HeaderFacets
// ---------------------------------------------------------------------------

/**
 * Extracts @UI.HeaderFacets references (DataPoints / FieldGroups shown on top).
 * @param {object} def
 * @returns {Array<HeaderFacetRef>}
 */
function extractHeaderFacets(def) {
    const raw = def["@UI.HeaderFacets"];
    if (!Array.isArray(raw)) return [];
    return raw
        .map((item) => ({
            id: item.ID ?? null,
            label: resolveLabel(item.Label) ?? null,
            target: resolveAnnotationTarget(item.Target),
        }))
        .filter((f) => f.target);
}

// ---------------------------------------------------------------------------
// Facets (page section hierarchy)
// ---------------------------------------------------------------------------

/**
 * Extracts @UI.Facets — the object-page section hierarchy.
 * @param {object} def
 * @returns {Array<FacetDef>}
 */
function extractFacets(def) {
    const raw = def["@UI.Facets"];
    if (!Array.isArray(raw)) return [];
    return raw.map(parseFacetEntry).filter(Boolean);
}

/** Recursively parses a single facet entry. */
function parseFacetEntry(item) {
    if (!item) return null;
    const type = String(resolveEnumValue(item.$Type) ?? item.$Type ?? "");
    const id = item.ID ?? null;
    const label = resolveLabel(item.Label) ?? null;

    if (type.endsWith("CollectionFacet")) {
        return {
            type: "CollectionFacet",
            id,
            label,
            target: null,
            facets: Array.isArray(item.Facets) ? item.Facets.map(parseFacetEntry).filter(Boolean) : [],
        };
    }
    // Treat anything else (ReferenceFacet, or untyped with a Target) as a reference
    if (type.endsWith("ReferenceFacet") || item.Target) {
        return { type: "ReferenceFacet", id, label, target: resolveAnnotationTarget(item.Target), facets: null };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Identification (actions)
// ---------------------------------------------------------------------------

/**
 * Extracts @UI.Identification — DataFieldForAction / DataFieldForActionGroup.
 * @param {object} def
 * @returns {Array<ActionDef>}
 */
function extractIdentification(def) {
    const raw = def["@UI.Identification"];
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
        const type = String(resolveEnumValue(item.$Type) ?? item.$Type ?? "UI.DataField");
        const label = resolveLabel(item.Label) ?? null;
        if (type.endsWith("DataFieldForActionGroup")) {
            const actions = Array.isArray(item.Actions)
                ? item.Actions.flatMap((a) => {
                      const aType = String(resolveEnumValue(a.$Type) ?? a.$Type ?? "");
                      if (!aType.endsWith("DataFieldForAction")) return [];
                      return [{ type: "DataFieldForAction", action: a.Action ?? null, label: resolveLabel(a.Label) ?? null, actions: null }];
                  })
                : [];
            return [{ type: "DataFieldForActionGroup", action: null, label, actions }];
        }
        if (type.endsWith("DataFieldForAction")) {
            return [{ type: "DataFieldForAction", action: item.Action ?? null, label, actions: null }];
        }
        return [];
    });
}

// ---------------------------------------------------------------------------
// SelectionFields
// ---------------------------------------------------------------------------

/**
 * Extracts @UI.SelectionFields as a list of property paths.
 * @param {object} def
 * @returns {string[]}
 */
function extractSelectionFields(def) {
    const raw = def["@UI.SelectionFields"];
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
        const path = resolveAnnotationPath(item);
        return path ? [path] : [];
    });
}

// ---------------------------------------------------------------------------
// Element-level metadata
// ---------------------------------------------------------------------------

/**
 * Extracts per-element annotations: @UI.Hidden, @UI.HiddenFilter,
 * @UI.MultiLineText, @Common.Text (+ @Common.TextArrangement).
 * @param {object} def
 * @returns {{hiddenFields:Set, hiddenFilterFields:Set, multiLineFields:Set, commonText:Map}}
 */
function extractElementMetadata(def) {
    const hiddenFields = new Set();
    const hiddenFilterFields = new Set();
    const multiLineFields = new Set();
    const commonText = new Map();

    for (const [name, el] of Object.entries(def.elements ?? {})) {
        if (!el || typeof el !== "object") continue;
        if (el["@UI.Hidden"] === true) hiddenFields.add(name);
        if (el["@UI.HiddenFilter"] === true) hiddenFilterFields.add(name);
        if (el["@UI.MultiLineText"] === true) multiLineFields.add(name);

        const textPath = resolveAnnotationPath(el["@Common.Text"]);
        if (textPath) {
            commonText.set(name, {
                textPath,
                textArrangement: resolveEnumValue(el["@Common.TextArrangement"]) ?? null,
            });
        }
    }
    return { hiddenFields, hiddenFilterFields, multiLineFields, commonText };
}

// ---------------------------------------------------------------------------
// DataField item parser (shared by LineItem + FieldGroup.Data)
// ---------------------------------------------------------------------------

/**
 * Parses a single DataField record. Returns null for unhandled record types.
 * @param {object} item
 * @returns {LineItemColumn|null}
 */
function parseDataFieldItem(item) {
    if (!item || typeof item !== "object") return null;
    const type = String(resolveEnumValue(item.$Type) ?? item.$Type ?? "UI.DataField");
    const label = resolveLabel(item.Label) ?? null;
    const importance = resolveEnumValue(item["@UI.Importance"] ?? item["![@UI.Importance]"] ?? item.Importance) ?? null;

    const base = {
        path: null,
        label,
        criticalityPath: null,
        criticalityRepresentation: null,
        importance,
        dataFieldType: "DataField",
        url: null,
        action: null,
        annotationTarget: null,
    };

    if (type.endsWith("DataFieldForActionGroup")) {
        return { ...base, dataFieldType: "DataFieldForActionGroup", label: label ?? item.ID ?? "Actions" };
    }
    if (type.endsWith("DataFieldForAction")) {
        if (!item.Action) return null;
        return { ...base, dataFieldType: "DataFieldForAction", action: item.Action, label: label ?? item.Action };
    }
    if (type.endsWith("DataFieldForAnnotation")) {
        const target = resolveAnnotationTarget(item.Target);
        if (!target) return null;
        return { ...base, dataFieldType: "DataFieldForAnnotation", annotationTarget: target, label: label ?? target };
    }
    if (type.endsWith("DataFieldWithUrl")) {
        const path = resolveAnnotationPath(item.Value);
        if (!path) return null;
        return { ...base, path, label: label ?? labelFromPath(path), dataFieldType: "DataFieldWithUrl", url: resolveAnnotationPath(item.Url) ?? null };
    }
    // UI.DataField and UI.DataFieldWithCriticality (and any other value-bearing field)
    const path = resolveAnnotationPath(item.Value);
    if (!path) return null;
    return {
        ...base,
        path,
        label: label ?? labelFromPath(path),
        criticalityPath: resolveAnnotationPath(item.Criticality) ?? null,
        criticalityRepresentation: resolveEnumValue(item.CriticalityRepresentation) ?? null,
    };
}

// ---------------------------------------------------------------------------
// Flattened-annotation reconstruction helpers
// ---------------------------------------------------------------------------

/**
 * Reconstructs a nested annotation object from CSN's flattened dot-keys.
 *
 * Given baseKey "@UI.HeaderInfo" and flattened keys
 *   "@UI.HeaderInfo.TypeName", "@UI.HeaderInfo.Title.Value"
 * returns { TypeName: ..., Title: { Value: ... } }.
 *
 * If the annotation is stored whole (rare — some compilers keep small structs
 * intact), that object is returned directly. Array sub-values (e.g. `.Data`)
 * are assigned as-is.
 *
 * @param {object} def
 * @param {string} baseKey
 * @returns {object|null}
 */
function readAnnotationObject(def, baseKey) {
    // Whole object stored under the exact key
    const whole = def[baseKey];
    if (whole && typeof whole === "object" && !Array.isArray(whole) && !("=" in whole) && !("#" in whole)) {
        // Could already be a full struct; still merge any dot-keys below.
        const merged = { ...whole };
        mergeDotKeys(def, baseKey, merged);
        return Object.keys(merged).length ? merged : null;
    }
    const result = {};
    const found = mergeDotKeys(def, baseKey, result);
    return found ? result : null;
}

/**
 * Merges all `${baseKey}.${rest}` flattened keys from def into target as a
 * nested structure. Returns true if at least one key was merged.
 * @param {object} def
 * @param {string} baseKey
 * @param {object} target
 * @returns {boolean}
 */
function mergeDotKeys(def, baseKey, target) {
    const prefix = baseKey + ".";
    let found = false;
    for (const [k, v] of Object.entries(def)) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        // Skip annotation-on-annotation keys (contain '@') — not part of the struct
        if (rest.includes("@")) continue;
        setNested(target, rest.split("."), v);
        found = true;
    }
    return found;
}

/** Sets target[seg0][seg1]... = value, creating intermediate objects. */
function setNested(target, segs, value) {
    let cur = target;
    for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i];
        if (typeof cur[s] !== "object" || cur[s] === null) cur[s] = {};
        cur = cur[s];
    }
    cur[segs[segs.length - 1]] = value;
}

/**
 * Returns the distinct qualifiers used for a qualified annotation family.
 * For prefix "@UI.FieldGroup" and keys "@UI.FieldGroup#A.Label",
 * "@UI.FieldGroup#A.Data", "@UI.FieldGroup#B.Data" → ["A", "B"].
 * An unqualified occurrence ("@UI.FieldGroup.Data") yields "_default".
 * @param {object} def
 * @param {string} prefix
 * @returns {string[]}
 */
function annotationQualifiers(def, prefix) {
    const quals = new Set();
    for (const k of Object.keys(def)) {
        if (k === prefix || k.startsWith(prefix + ".")) {
            quals.add("_default");
        } else if (k.startsWith(prefix + "#")) {
            const after = k.slice(prefix.length + 1); // e.g. "A.Label" or "A"
            const qual = after.split(".")[0];
            if (qual) quals.add(qual);
        }
    }
    return Array.from(quals);
}

/** Builds the base annotation key for a qualifier ("_default" → unqualified). */
function qualifierKey(prefix, qualifier) {
    return qualifier === "_default" ? prefix : `${prefix}#${qualifier}`;
}

// ---------------------------------------------------------------------------
// Value resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a CSN annotation value to a property-path string.
 * Real CSN encodes paths as `{ "=": "field" }` (association traversal uses a
 * dot: `{ "=": "status.criticality" }`). Also handles `{$Path}`, `{ref:[...]}`,
 * `{$value}`, `{val}` and plain strings for robustness across CSN flavors.
 * Pure expression values (with `xpr`) are NOT treated as paths → returns null.
 * @param {*} value
 * @returns {string|null}
 */
function resolveAnnotationPath(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (typeof value !== "object") return null;
    // Expression, not a plain path
    if (Array.isArray(value.xpr)) {
        // If the '=' field is a bare identifier path (no operators), keep it.
        if (typeof value["="] === "string" && /^[A-Za-z_][\w.]*$/.test(value["="])) return value["="];
        return null;
    }
    if (typeof value["="] === "string") return value["="];
    if (typeof value.$Path === "string") return value.$Path;
    if (typeof value.$path === "string") return value.$path;
    if (Array.isArray(value.ref)) return value.ref.map((r) => (typeof r === "object" ? r.id ?? "" : r)).join(".");
    if (typeof value.$value === "string") return value.$value;
    if (typeof value.val === "string") return value.val;
    return null;
}

/**
 * Resolves an annotation target reference, e.g. '@UI.FieldGroup#Details'.
 * @param {*} value
 * @returns {string|null}
 */
function resolveAnnotationTarget(value) {
    if (!value) return null;
    if (typeof value === "string") return value;
    if (typeof value !== "object") return null;
    if (typeof value["="] === "string") return value["="];
    if (typeof value.AnnotationPath === "string") return value.AnnotationPath;
    if (typeof value.$AnnotationPath === "string") return value.$AnnotationPath;
    if (typeof value.$Path === "string") return value.$Path;
    return null;
}

/**
 * Resolves a label value to a display string, dropping unresolved i18n
 * placeholders (`{i18n>Key}`) so callers fall back to the field name.
 * @param {*} value
 * @returns {string|null}
 */
function resolveLabel(value) {
    if (value === null || value === undefined) return null;
    const str =
        typeof value === "string" ? value
        : typeof value === "object" && typeof value.$value === "string" ? value.$value
        : typeof value === "object" && typeof value.val === "string" ? value.val
        : null;
    if (!str) return null;
    if (str.startsWith("{") && str.includes("}")) return null; // i18n placeholder
    return str;
}

/**
 * Resolves a CSN enum reference. Real CSN encodes enums as `{ "#": "High" }`;
 * plain strings (with or without a leading '#') are also accepted.
 * @param {*} value
 * @returns {string|null}
 */
function resolveEnumValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value.startsWith("#") ? value.slice(1) : value;
    if (typeof value === "object") {
        if (typeof value["#"] === "string") return value["#"];
        if (typeof value.enum === "string") return value.enum;
    }
    return null;
}

/**
 * Converts a property/association path to a human-readable label.
 * "authorName" → "Author Name"; "author_ID" → "Author";
 * "status.criticality" → "Status".
 * @param {string} path
 * @returns {string}
 */
function labelFromPath(path) {
    if (!path) return "";
    const name = path.split(/[/.]/).shift() ?? path;
    const stripped = name.replace(/_(ID|code|id|Code)$/, "");
    return stripped
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}
