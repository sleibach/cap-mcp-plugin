"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseUiAnnotations = parseUiAnnotations;
exports.hasUiAnnotations = hasUiAnnotations;

/**
 * Parses @UI.* and @Common.* Fiori annotations from a compiled CSN entity definition
 * into a UiMetadata object consumed by the MCP Apps template generator.
 *
 * Handles all common Fiori annotation types:
 *   @UI.LineItem / @UI.LineItem#<qualifier>
 *   @UI.FieldGroup#<qualifier>
 *   @UI.DataPoint#<qualifier>
 *   @UI.HeaderInfo, @UI.HeaderFacets
 *   @UI.Facets (ReferenceFacet, CollectionFacet)
 *   @UI.Identification (DataFieldForAction, DataFieldForActionGroup)
 *   @UI.SelectionFields
 *   @UI.LineItem@UI.Criticality  (row-level criticality)
 *   @UI.Hidden, @UI.HiddenFilter, @UI.MultiLineText (element-level)
 *   @Common.Text, @Common.TextArrangement, @Common.Label (element-level)
 *
 * DataField record variants supported:
 *   UI.DataField — basic value display
 *   UI.DataFieldWithCriticality / CriticalityRepresentation on DataField
 *   UI.DataFieldWithUrl — clickable link
 *   UI.DataFieldForAction — action trigger button
 *   UI.DataFieldForActionGroup — grouped action buttons
 *   UI.DataFieldForAnnotation — reference to FieldGroup / DataPoint
 *
 * @param {object} def - Compiled CSN entity definition (model.definitions[entityTarget])
 * @returns {UiMetadata|null}
 */
function parseUiAnnotations(def) {
    if (!def || def.kind !== "entity") return null;

    const lineItems = extractLineItems(def);
    const fieldGroups = extractFieldGroups(def);

    // Require at least line items or field groups to warrant an MCP App
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
 * Returns true when the entity carries at least one @UI annotation usable for
 * MCP App generation (LineItem or FieldGroup).
 * @param {object} def
 * @returns {boolean}
 */
function hasUiAnnotations(def) {
    if (!def || def.kind !== "entity") return false;
    if (def["@UI.LineItem"]?.length) return true;
    // Qualified variants like @UI.LineItem#Attachments
    if (Object.keys(def).some((k) => /^@UI\.LineItem(#|$)/.test(k) && Array.isArray(def[k]))) return true;
    return Object.keys(def).some((k) => k.startsWith("@UI.FieldGroup"));
}

// ---------------------------------------------------------------------------
// LineItem extraction
// ---------------------------------------------------------------------------

/**
 * Extracts @UI.LineItem (default + all qualifiers) as a column list.
 * Prefers the default (unqualified) LineItem; falls back to the first
 * qualified variant when none exists.
 *
 * Per-item metadata extracted: label, criticality path, criticality
 * representation, importance, URL, action, annotation target.
 *
 * @param {object} def
 * @returns {Array<LineItemColumn>}
 */
function extractLineItems(def) {
    // Collect all @UI.LineItem keys: unqualified first, then qualifiers
    const defaultKey = "@UI.LineItem";
    const keys = [defaultKey, ...Object.keys(def).filter((k) => k !== defaultKey && /^@UI\.LineItem(#.+)?$/.test(k))];
    for (const key of keys) {
        const raw = def[key];
        if (Array.isArray(raw) && raw.length) {
            return raw.flatMap((item) => parseDataFieldItem(item)).filter(Boolean);
        }
    }
    return [];
}

/**
 * Extracts the row-level criticality expression from @UI.LineItem@UI.Criticality.
 * This annotation colors entire table rows (e.g. "actionRequired ? 2 : 0").
 * Returns a human-readable string representation of the expression, or null.
 * @param {object} def
 * @returns {string|null}
 */
function extractLineItemCriticality(def) {
    // CSN key for annotation-on-annotation: @UI.LineItem@UI.Criticality
    const val = def["@UI.LineItem@UI.Criticality"] ?? def["@UI.LineItem@Criticality"];
    if (val === null || val === undefined) return null;
    return serializeCdsExpression(val);
}

// ---------------------------------------------------------------------------
// FieldGroup extraction
// ---------------------------------------------------------------------------

/**
 * Extracts all @UI.FieldGroup#<qualifier> definitions.
 * @param {object} def
 * @returns {Object<string, FieldGroupDef>}
 */
function extractFieldGroups(def) {
    const result = {};
    for (const [key, value] of Object.entries(def)) {
        if (!key.startsWith("@UI.FieldGroup")) continue;
        const qualifier = key.includes("#") ? key.split("#").slice(1).join("#") : "_default";
        const label = resolveLabel(value?.Label) ?? qualifier;
        const fields = Array.isArray(value?.Data)
            ? value.Data.flatMap((item) => {
                  const col = parseDataFieldItem(item);
                  return col ? [col] : [];
              })
            : [];
        result[qualifier] = { label, fields };
    }
    return result;
}

// ---------------------------------------------------------------------------
// DataPoint extraction
// ---------------------------------------------------------------------------

/**
 * Extracts all @UI.DataPoint#<qualifier> definitions.
 * DataPoints represent KPI tiles / status indicators.
 * @param {object} def
 * @returns {Object<string, DataPointDef>}
 */
function extractDataPoints(def) {
    const result = {};
    for (const [key, value] of Object.entries(def)) {
        if (!key.startsWith("@UI.DataPoint")) continue;
        const qualifier = key.includes("#") ? key.split("#").slice(1).join("#") : "_default";
        result[qualifier] = {
            title: resolveLabel(value?.Title) ?? qualifier,
            valuePath: resolveAnnotationPath(value?.Value) ?? null,
            criticalityPath: resolveAnnotationPath(value?.Criticality) ?? null,
            trendPath: resolveAnnotationPath(value?.Trend) ?? null,
        };
    }
    return result;
}

// ---------------------------------------------------------------------------
// HeaderInfo extraction
// ---------------------------------------------------------------------------

/**
 * Extracts @UI.HeaderInfo for entity title, subtitle, and image.
 * @param {object} def
 * @returns {HeaderInfoDef|null}
 */
function extractHeaderInfo(def) {
    const raw = def["@UI.HeaderInfo"];
    if (!raw) return null;
    return {
        typeName: resolveLabel(raw.TypeName) ?? null,
        typeNamePlural: resolveLabel(raw.TypeNamePlural) ?? null,
        // Title/Description can be a plain path or a nested DataField
        titlePath:
            resolveAnnotationPath(raw.Title?.Value) ??
            resolveAnnotationPath(raw.Title) ??
            null,
        descriptionPath:
            resolveAnnotationPath(raw.Description?.Value) ??
            resolveAnnotationPath(raw.Description) ??
            null,
        imagePath: resolveAnnotationPath(raw.ImageUrl) ?? null,
    };
}

// ---------------------------------------------------------------------------
// HeaderFacets extraction
// ---------------------------------------------------------------------------

/**
 * Extracts @UI.HeaderFacets — the prominent indicators shown at the top
 * of an object page (usually DataPoints and status FieldGroups).
 * @param {object} def
 * @returns {Array<HeaderFacetRef>}
 */
function extractHeaderFacets(def) {
    const raw = def["@UI.HeaderFacets"];
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => ({
        id: item.ID ?? null,
        label: resolveLabel(item.Label) ?? null,
        target: resolveAnnotationTarget(item.Target),
    })).filter((f) => f.target);
}

// ---------------------------------------------------------------------------
// Facets (page structure) extraction
// ---------------------------------------------------------------------------

/**
 * Extracts @UI.Facets — the full object page section hierarchy.
 * @param {object} def
 * @returns {Array<FacetDef>}
 */
function extractFacets(def) {
    const raw = def["@UI.Facets"];
    if (!Array.isArray(raw)) return [];
    return raw.map(parseFacetEntry).filter(Boolean);
}

/**
 * Recursively parses a single facet entry.
 * @param {object} item
 * @returns {FacetDef|null}
 */
function parseFacetEntry(item) {
    if (!item) return null;
    const type = resolveEnumValue(item.$Type) ?? item.$Type ?? "";
    const id = item.ID ?? null;
    const label = resolveLabel(item.Label) ?? null;

    if (type === "UI.CollectionFacet" || type.endsWith(".CollectionFacet")) {
        return {
            type: "CollectionFacet",
            id,
            label,
            target: null,
            facets: Array.isArray(item.Facets)
                ? item.Facets.map(parseFacetEntry).filter(Boolean)
                : [],
        };
    }
    if (type === "UI.ReferenceFacet" || type.endsWith(".ReferenceFacet") || !type || !item.Facets) {
        return {
            type: "ReferenceFacet",
            id,
            label,
            target: resolveAnnotationTarget(item.Target),
            facets: null,
        };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Identification (actions) extraction
// ---------------------------------------------------------------------------

/**
 * Extracts @UI.Identification — the list of actions available on the entity.
 * Includes DataFieldForAction and DataFieldForActionGroup entries.
 * @param {object} def
 * @returns {Array<ActionDef>}
 */
function extractIdentification(def) {
    const raw = def["@UI.Identification"];
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
        const type = resolveEnumValue(item.$Type) ?? item.$Type ?? "UI.DataField";
        const label = resolveLabel(item.Label) ?? null;

        if (type === "UI.DataFieldForAction" || type.endsWith(".DataFieldForAction")) {
            return [{ type: "DataFieldForAction", action: item.Action ?? null, label, isCritical: false, actions: null }];
        }
        if (type === "UI.DataFieldForActionGroup" || type.endsWith(".DataFieldForActionGroup")) {
            const actions = Array.isArray(item.Actions)
                ? item.Actions.flatMap((a) => {
                      const aType = resolveEnumValue(a.$Type) ?? a.$Type ?? "";
                      if (!aType.endsWith("DataFieldForAction")) return [];
                      return [{ type: "DataFieldForAction", action: a.Action ?? null, label: resolveLabel(a.Label) ?? null, isCritical: false, actions: null }];
                  })
                : [];
            return [{ type: "DataFieldForActionGroup", action: null, label, isCritical: false, actions }];
        }
        return [];
    });
}

// ---------------------------------------------------------------------------
// SelectionFields extraction
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
// Element-level metadata extraction
// ---------------------------------------------------------------------------

/**
 * Extracts per-element annotations: @UI.Hidden, @UI.HiddenFilter, @UI.MultiLineText,
 * @Common.Text, @Common.TextArrangement, @Common.Label.
 * @param {object} def
 * @returns {{ hiddenFields: Set, hiddenFilterFields: Set, multiLineFields: Set, commonText: Map }}
 */
function extractElementMetadata(def) {
    const hiddenFields = new Set();
    const hiddenFilterFields = new Set();
    const multiLineFields = new Set();
    const commonText = new Map();

    const elements = def.elements ?? {};
    for (const [name, el] of Object.entries(elements)) {
        if (!el || typeof el !== "object") continue;

        if (el["@UI.Hidden"] === true) hiddenFields.add(name);
        if (el["@UI.HiddenFilter"] === true) hiddenFilterFields.add(name);
        if (el["@UI.MultiLineText"] === true) multiLineFields.add(name);

        // @Common.Text: usually { $Path: "textFieldName" } or a plain string
        const textVal = el["@Common.Text"];
        if (textVal) {
            const textPath = resolveAnnotationPath(textVal);
            if (textPath) {
                const arrangement = el["@Common.TextArrangement"];
                const arrangementStr = arrangement
                    ? (resolveEnumValue(arrangement) ?? null)
                    : null;
                commonText.set(name, { textPath, textArrangement: arrangementStr });
            }
        }
    }

    return { hiddenFields, hiddenFilterFields, multiLineFields, commonText };
}

// ---------------------------------------------------------------------------
// DataField item parser (shared between LineItem and FieldGroup)
// ---------------------------------------------------------------------------

/**
 * Parses a single DataField record from a LineItem or FieldGroup Data array.
 * Returns null for unhandled record types.
 * @param {object} item
 * @returns {LineItemColumn|null}
 */
function parseDataFieldItem(item) {
    if (!item || typeof item !== "object") return null;
    const type = resolveEnumValue(item.$Type) ?? item.$Type ?? "UI.DataField";
    const label = resolveLabel(item.Label) ?? null;
    const importance = resolveEnumValue(
        item["@UI.Importance"] ?? item["![@UI.Importance]"] ?? item["Importance"]
    ) ?? null;

    switch (true) {
        case type === "UI.DataField" || type.endsWith(".DataField"): {
            const path = resolveAnnotationPath(item.Value);
            if (!path) return null;
            return {
                path,
                label: label ?? labelFromPath(path),
                criticalityPath: resolveAnnotationPath(item.Criticality) ?? null,
                criticalityRepresentation: resolveEnumValue(item.CriticalityRepresentation) ?? null,
                importance,
                dataFieldType: "DataField",
                url: null,
                action: null,
                annotationTarget: null,
            };
        }

        case type === "UI.DataFieldWithCriticality" || type.endsWith(".DataFieldWithCriticality"): {
            const path = resolveAnnotationPath(item.Value);
            if (!path) return null;
            return {
                path,
                label: label ?? labelFromPath(path),
                criticalityPath: resolveAnnotationPath(item.Criticality) ?? null,
                criticalityRepresentation: resolveEnumValue(item.CriticalityRepresentation) ?? null,
                importance,
                dataFieldType: "DataField",
                url: null,
                action: null,
                annotationTarget: null,
            };
        }

        case type === "UI.DataFieldWithUrl" || type.endsWith(".DataFieldWithUrl"): {
            const path = resolveAnnotationPath(item.Value);
            if (!path) return null;
            return {
                path,
                label: label ?? labelFromPath(path),
                criticalityPath: null,
                criticalityRepresentation: null,
                importance,
                dataFieldType: "DataFieldWithUrl",
                url: resolveAnnotationPath(item.Url) ?? null,
                action: null,
                annotationTarget: null,
            };
        }

        case type === "UI.DataFieldForAction" || type.endsWith(".DataFieldForAction"): {
            const action = item.Action ?? null;
            if (!action) return null;
            return {
                path: null,
                label: label ?? action,
                criticalityPath: null,
                criticalityRepresentation: null,
                importance,
                dataFieldType: "DataFieldForAction",
                url: null,
                action,
                annotationTarget: null,
            };
        }

        case type === "UI.DataFieldForActionGroup" || type.endsWith(".DataFieldForActionGroup"): {
            // Render the group as a single "action group" placeholder
            return {
                path: null,
                label: label ?? item.ID ?? "Actions",
                criticalityPath: null,
                criticalityRepresentation: null,
                importance,
                dataFieldType: "DataFieldForActionGroup",
                url: null,
                action: null,
                annotationTarget: null,
            };
        }

        case type === "UI.DataFieldForAnnotation" || type.endsWith(".DataFieldForAnnotation"): {
            // Points to another annotation (e.g. FieldGroup or DataPoint) — capture the target
            const target = resolveAnnotationTarget(item.Target);
            if (!target) return null;
            return {
                path: null,
                label: label ?? target,
                criticalityPath: null,
                criticalityRepresentation: null,
                importance,
                dataFieldType: "DataFieldForAnnotation",
                url: null,
                action: null,
                annotationTarget: target,
            };
        }

        default:
            return null;
    }
}

// ---------------------------------------------------------------------------
// Annotation value resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a CDS annotation path value to a string.
 * CSN encodes property paths as { $Path: "field" } objects.
 * Association traversal paths may use "/" as separator.
 * Plain strings and { $value } are also handled.
 * @param {*} value
 * @returns {string|null}
 */
function resolveAnnotationPath(value) {
    if (!value) return null;
    if (typeof value === "string") return value;
    if (typeof value !== "object") return null;
    if (typeof value.$Path === "string") return value.$Path;
    if (typeof value.$path === "string") return value.$path;
    if (typeof value.$value === "string") return value.$value;
    // Some compilers emit { val: "field" } for simple paths
    if (typeof value.val === "string") return value.val;
    return null;
}

/**
 * Resolves a CDS annotation target path (annotation reference).
 * E.g. '@UI.FieldGroup#Details' or { AnnotationPath: '@UI.DataPoint#status' }
 * @param {*} value
 * @returns {string|null}
 */
function resolveAnnotationTarget(value) {
    if (!value) return null;
    if (typeof value === "string") return value;
    if (typeof value !== "object") return null;
    // { AnnotationPath: '...' } or { $AnnotationPath: '...' }
    if (typeof value.AnnotationPath === "string") return value.AnnotationPath;
    if (typeof value.$AnnotationPath === "string") return value.$AnnotationPath;
    if (typeof value.$Path === "string") return value.$Path;
    return null;
}

/**
 * Resolves a CDS label value to a human-readable string.
 * Silently drops i18n placeholder keys (e.g. '{i18n>TitleKey}') since they
 * cannot be resolved at parse time — callers fall back to the field name.
 * @param {*} value
 * @returns {string|null}
 */
function resolveLabel(value) {
    if (!value) return null;
    const str = typeof value === "string" ? value
        : typeof value === "object" && typeof value.$value === "string" ? value.$value
        : typeof value === "object" && typeof value.val === "string" ? value.val
        : null;
    if (!str) return null;
    // i18n placeholder — cannot resolve, drop it
    if (str.startsWith("{") && str.includes("}")) return null;
    return str;
}

/**
 * Resolves a CDS enum reference to its string value.
 * CSN encodes enum values as { "#": "High" } or, in some compilers, as
 * plain strings like "High". Both forms are handled.
 * @param {*} value
 * @returns {string|null}
 */
function resolveEnumValue(value) {
    if (!value) return null;
    if (typeof value === "string") {
        // Strip leading # if present (raw CDS literal that slipped through)
        return value.startsWith("#") ? value.slice(1) : value;
    }
    if (typeof value === "object") {
        if (typeof value["#"] === "string") return value["#"];
        if (typeof value.enum === "string") return value.enum;
    }
    return null;
}

/**
 * Serializes a compiled CDS expression to a human-readable string.
 * Used for row-level criticality annotations like "actionRequired ? 2 : 0".
 * The actual computation is done in the template at runtime; here we just
 * extract a path reference or a simple expression string for reference.
 * @param {*} value
 * @returns {string|null}
 */
function serializeCdsExpression(value) {
    if (!value) return null;
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    const path = resolveAnnotationPath(value);
    if (path) return path;
    // Ternary / CDS xpr — return a placeholder string for template reference
    if (typeof value === "object" && Array.isArray(value.xpr)) {
        // Pull out any path references from the expression
        const paths = value.xpr.flatMap((t) => {
            if (typeof t === "object" && t.ref) return [t.ref.join("/")];
            return [];
        });
        return paths.length ? paths[0] : null;
    }
    return null;
}

/**
 * Converts a camelCase/PascalCase field path to a human-readable label.
 * "authorName" → "Author Name", "author_ID" → "Author", "processingStatus_ID" → "Processing Status"
 * Association traversal paths like "processingStatus/criticality" → "Processing Status"
 * @param {string} path
 * @returns {string}
 */
function labelFromPath(path) {
    if (!path) return "";
    // Use only the first segment of association traversal paths
    const name = path.split(/[/.]/).shift() ?? path;
    // Strip common FK suffixes
    const stripped = name.replace(/_(ID|code|id|Code)$/, "");
    return stripped
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}
