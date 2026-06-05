"use strict";

/**
 * Unit tests for lib/annotations/ui-parser.js and lib/mcp/apps/template-generator.js
 *
 * CRITICAL: these fixtures use the REAL runtime CSN encoding, not the source
 * CDS shape. Verified against `cds.load(...)` output:
 *   - struct annotations are flattened to dot-keys (@UI.HeaderInfo.TypeName,
 *     @UI.FieldGroup#Details.Data)
 *   - property paths are { "=": "field" } (assoc traversal: { "=": "a.b" })
 *   - enums are { "#": "High" }
 * A regression that re-introduces the nested-object / {$Path} assumption MUST
 * fail here. See ui-parser-integration.test.js for a live-compile cross-check.
 */

global.cds = {
    log: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    env: { requires: { auth: { kind: "mocked" } } },
};

const { parseUiAnnotations, hasUiAnnotations } = require("../../lib/annotations/ui-parser");
const { buildQueryTemplate, buildDetailTemplate } = require("../../lib/mcp/apps/template-generator");

// Real-CSN-shaped fixture (flattened keys, { "=" } paths, { "#" } enums)
const def = {
    kind: "entity",
    "@UI.HeaderInfo.TypeName": "Book",
    "@UI.HeaderInfo.TypeNamePlural": "Books",
    "@UI.HeaderInfo.Title.Value": { "=": "title" },
    "@UI.HeaderInfo.Description.Value": { "=": "descr" },
    "@UI.LineItem": [
        { $Type: "UI.DataField", Value: { "=": "ID" }, Label: "ID" },
        { $Type: "UI.DataField", Value: { "=": "title" }, Label: "Title", "@UI.Importance": { "#": "High" } },
        { $Type: "UI.DataField", Value: { "=": "stock" }, Criticality: { "=": "stockStatus" }, CriticalityRepresentation: { "#": "WithIcon" } },
        { $Type: "UI.DataFieldForAnnotation", Target: "@UI.FieldGroup#Details" }, // skipped from columns? no — kept as annotation ref
    ],
    "@UI.FieldGroup#General.Label": "General",
    "@UI.FieldGroup#General.Data": [
        { Value: { "=": "title" } },
        { Value: { "=": "descr" } },
    ],
    "@UI.FieldGroup#Details.Label": "Details",
    "@UI.FieldGroup#Details.Data": [
        { Value: { "=": "stock" } },
        { Value: { "=": "price" } },
    ],
    "@UI.SelectionFields": [{ "=": "title" }, { "=": "stock" }],
    elements: {
        ID: {}, title: {}, descr: {}, stock: {}, price: {},
        internalField: { "@UI.Hidden": true },
    },
};

describe("parseUiAnnotations (real CSN encoding)", () => {
    test("returns null for non-entity definitions", () => {
        expect(parseUiAnnotations({ kind: "service" })).toBeNull();
        expect(parseUiAnnotations(null)).toBeNull();
    });

    test("returns null when no LineItem or FieldGroup present", () => {
        expect(parseUiAnnotations({ kind: "entity", elements: {} })).toBeNull();
    });

    test("extracts LineItem columns with { \"=\" } path encoding", () => {
        const meta = parseUiAnnotations(def);
        expect(meta).not.toBeNull();
        // 3 DataFields + 1 DataFieldForAnnotation
        const dataFields = meta.lineItems.filter((c) => c.dataFieldType === "DataField");
        expect(dataFields.map((c) => c.path)).toEqual(["ID", "title", "stock"]);
        expect(dataFields[0]).toMatchObject({ path: "ID", label: "ID" });
        expect(dataFields[2]).toMatchObject({ path: "stock", criticalityPath: "stockStatus", criticalityRepresentation: "WithIcon" });
    });

    test("captures @UI.Importance enum { \"#\": \"High\" }", () => {
        const meta = parseUiAnnotations(def);
        expect(meta.lineItems.find((c) => c.path === "title").importance).toBe("High");
    });

    test("reconstructs FieldGroups from flattened .Label / .Data keys", () => {
        const meta = parseUiAnnotations(def);
        expect(Object.keys(meta.fieldGroups).sort()).toEqual(["Details", "General"]);
        expect(meta.fieldGroups.General.label).toBe("General");
        expect(meta.fieldGroups.General.fields.map((f) => f.path)).toEqual(["title", "descr"]);
        expect(meta.fieldGroups.Details.fields.map((f) => f.path)).toEqual(["stock", "price"]);
    });

    test("reconstructs HeaderInfo from flattened keys", () => {
        const meta = parseUiAnnotations(def);
        expect(meta.headerInfo).toMatchObject({
            typeName: "Book", typeNamePlural: "Books", titlePath: "title", descriptionPath: "descr",
        });
    });

    test("extracts SelectionFields", () => {
        const meta = parseUiAnnotations(def);
        expect(meta.selectionFields).toEqual(["title", "stock"]);
    });

    test("collects @UI.Hidden fields", () => {
        const meta = parseUiAnnotations(def);
        expect(meta.hiddenFields.has("internalField")).toBe(true);
        expect(meta.hiddenFields.has("title")).toBe(false);
    });

    test("row criticality: pure path resolved, expression skipped", () => {
        const withPath = { ...def, "@UI.LineItem@UI.Criticality": { "=": "actionRequired" } };
        expect(parseUiAnnotations(withPath).lineItemCriticality).toBe("actionRequired");

        const withExpr = { ...def, "@UI.LineItem@UI.Criticality": { "=": "size>0?3:1", xpr: ["case"] } };
        expect(parseUiAnnotations(withExpr).lineItemCriticality).toBeNull();
    });

    test("parses DataFieldForAction in LineItem", () => {
        const d = { kind: "entity", "@UI.LineItem": [{ $Type: "UI.DataFieldForAction", Action: "Svc.doThing", Label: "Do Thing" }], elements: {} };
        const meta = parseUiAnnotations(d);
        expect(meta.lineItems[0]).toMatchObject({ dataFieldType: "DataFieldForAction", action: "Svc.doThing" });
    });

    test("parses DataFieldWithUrl in LineItem", () => {
        const d = { kind: "entity", "@UI.LineItem": [{ $Type: "UI.DataFieldWithUrl", Value: { "=": "name" }, Url: { "=": "link" } }], elements: {} };
        const meta = parseUiAnnotations(d);
        expect(meta.lineItems[0]).toMatchObject({ dataFieldType: "DataFieldWithUrl", path: "name", url: "link" });
    });

    test("parses DataFieldForAnnotation (keeps annotationTarget)", () => {
        const d = { kind: "entity", "@UI.LineItem": [{ $Type: "UI.DataFieldForAnnotation", Target: "@UI.FieldGroup#Processing" }], "@UI.FieldGroup#Processing.Data": [{ Value: { "=": "x" } }], elements: {} };
        const meta = parseUiAnnotations(d);
        expect(meta.lineItems[0]).toMatchObject({ dataFieldType: "DataFieldForAnnotation", annotationTarget: "@UI.FieldGroup#Processing" });
    });

    test("reconstructs DataPoints from flattened keys", () => {
        const d = {
            kind: "entity", "@UI.LineItem": [{ Value: { "=": "ID" } }],
            "@UI.DataPoint#status.Value": { "=": "status_ID" },
            "@UI.DataPoint#status.Title": "Status",
            "@UI.DataPoint#status.Criticality": { "=": "status.criticality" },
            elements: {},
        };
        const meta = parseUiAnnotations(d);
        expect(meta.dataPoints.status).toMatchObject({ title: "Status", valuePath: "status_ID", criticalityPath: "status.criticality" });
    });

    test("extracts HeaderFacets references", () => {
        const d = { kind: "entity", "@UI.LineItem": [{ Value: { "=": "ID" } }], "@UI.HeaderFacets": [{ $Type: "UI.ReferenceFacet", ID: "s", Target: "@UI.DataPoint#status" }], elements: {} };
        const meta = parseUiAnnotations(d);
        expect(meta.headerFacets[0].target).toBe("@UI.DataPoint#status");
    });

    test("extracts Facets hierarchy (CollectionFacet + ReferenceFacet)", () => {
        const d = {
            kind: "entity", "@UI.LineItem": [{ Value: { "=": "ID" } }],
            "@UI.Facets": [{ $Type: "UI.CollectionFacet", Label: "Gen", ID: "g", Facets: [{ $Type: "UI.ReferenceFacet", ID: "d", Target: "@UI.FieldGroup#Details" }] }],
            "@UI.FieldGroup#Details.Data": [{ Value: { "=": "title" } }],
            elements: {},
        };
        const meta = parseUiAnnotations(d);
        expect(meta.facets[0].type).toBe("CollectionFacet");
        expect(meta.facets[0].facets[0].target).toBe("@UI.FieldGroup#Details");
    });

    test("extracts Identification actions (incl. ActionGroup)", () => {
        const d = {
            kind: "entity", "@UI.LineItem": [{ Value: { "=": "ID" } }],
            "@UI.Identification": [
                { $Type: "UI.DataFieldForAction", Action: "Svc.exec", Label: "Execute" },
                { $Type: "UI.DataFieldForActionGroup", Label: "Change", Actions: [{ $Type: "UI.DataFieldForAction", Action: "Svc.done", Label: "Done" }] },
            ],
            elements: {},
        };
        const meta = parseUiAnnotations(d);
        expect(meta.identification[0].action).toBe("Svc.exec");
        expect(meta.identification[1].type).toBe("DataFieldForActionGroup");
        expect(meta.identification[1].actions).toHaveLength(1);
    });

    test("extracts @Common.Text / @Common.TextArrangement / @UI.MultiLineText", () => {
        const d = {
            kind: "entity", "@UI.LineItem": [{ Value: { "=": "status_ID" } }],
            elements: {
                status_ID: { "@Common.Text": { "=": "status.name" }, "@Common.TextArrangement": { "#": "TextOnly" } },
                notes: { "@UI.MultiLineText": true },
            },
        };
        const meta = parseUiAnnotations(d);
        expect(meta.commonText.get("status_ID")).toMatchObject({ textPath: "status.name", textArrangement: "TextOnly" });
        expect(meta.multiLineFields.has("notes")).toBe(true);
    });

    test("extracts @UI.HiddenFilter fields", () => {
        const d = { kind: "entity", "@UI.LineItem": [{ Value: { "=": "ID" } }], elements: { code: { "@UI.HiddenFilter": true }, name: {} } };
        const meta = parseUiAnnotations(d);
        expect(meta.hiddenFilterFields.has("code")).toBe(true);
    });
});

describe("hasUiAnnotations", () => {
    test("true when LineItem present", () => {
        expect(hasUiAnnotations({ kind: "entity", "@UI.LineItem": [{}] })).toBe(true);
    });
    test("true when qualified LineItem present", () => {
        expect(hasUiAnnotations({ kind: "entity", "@UI.LineItem#X": [{}] })).toBe(true);
    });
    test("true when FieldGroup present (flattened)", () => {
        expect(hasUiAnnotations({ kind: "entity", "@UI.FieldGroup#T.Data": [] })).toBe(true);
    });
    test("false for non-entity", () => {
        expect(hasUiAnnotations({ kind: "service" })).toBe(false);
    });
});

describe("buildQueryTemplate", () => {
    const uiMeta = parseUiAnnotations(def);

    test("produces valid HTML with column headers from LineItem", () => {
        const html = buildQueryTemplate("Books", uiMeta);
        expect(html).toContain("<!DOCTYPE html>");
        expect(html).toContain("Books");
        expect(html).toContain("Title");
    });

    test("embeds MCP Apps protocol bootstrap", () => {
        const html = buildQueryTemplate("Books", uiMeta);
        expect(html).toContain("ui/initialize");
        expect(html).toContain("ui/notifications/tool-result");
        expect(html).toContain("2026-01-26");
    });

    test("includes criticality column spec", () => {
        const html = buildQueryTemplate("Books", uiMeta);
        expect(html).toContain("critPath");
        expect(html).toContain("stockStatus");
    });

    test("no external CDN references", () => {
        const html = buildQueryTemplate("Books", uiMeta);
        expect(html).not.toMatch(/cdn\.|unpkg\.com|jsdelivr/);
    });

    test("applies column visibility rules (LineItem / Hidden / service fields)", () => {
        const genresMeta = parseUiAnnotations({
            kind: "entity",
            "@UI.LineItem": [{ $Type: "UI.DataField", Value: { "=": "name" }, Label: "Name" }],
            elements: {
                name: {},
                ID: { "@UI.Hidden": true },
                descr: { "@title": "Description" },
            },
        });
        const html = buildQueryTemplate("Genres", genresMeta, "Bookshop", null, {
            exposableFields: [{ path: "descr", label: "Description" }],
        });
        expect(html).toContain('"path":"name"');
        expect(html).not.toContain('"path":"ID"');
        expect(html).toMatch(/"path":"descr"[^}]*"visible":false/);
    });
});

describe("buildDetailTemplate", () => {
    const uiMeta = parseUiAnnotations(def);

    test("produces field group sections", () => {
        const html = buildDetailTemplate("Books", uiMeta);
        expect(html).toContain("General");
        expect(html).toContain("Details");
    });

    test("embeds MCP Apps protocol bootstrap", () => {
        const html = buildDetailTemplate("Books", uiMeta);
        expect(html).toContain("ui/initialize");
        expect(html).toContain("ui/notifications/tool-result");
    });

    test("uses HeaderInfo title/description paths", () => {
        const html = buildDetailTemplate("Books", uiMeta);
        expect(html).toContain('"title"');
        expect(html).toContain('"descr"');
    });
});
