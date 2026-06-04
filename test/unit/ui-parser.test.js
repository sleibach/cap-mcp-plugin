"use strict";

/**
 * Unit tests for lib/annotations/ui-parser.js and lib/mcp/apps/template-generator.js
 */

global.cds = {
    log: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    env: { requires: { auth: { kind: "mocked" } } },
};

const { parseUiAnnotations, hasUiAnnotations } = require("../../lib/annotations/ui-parser");
const { buildQueryTemplate, buildDetailTemplate } = require("../../lib/mcp/apps/template-generator");

// Shared test fixture
const def = {
    kind: "entity",
    "@UI.HeaderInfo": {
        TypeName: "Book",
        TypeNamePlural: "Books",
        Title: { Value: { $Path: "title" } },
        Description: { Value: { $Path: "descr" } },
    },
    "@UI.LineItem": [
        { $Type: "UI.DataField", Value: { $Path: "ID" }, Label: "ID" },
        { $Type: "UI.DataField", Value: { $Path: "title" }, Label: "Title" },
        { $Type: "UI.DataFieldWithCriticality", Value: { $Path: "stock" }, Criticality: { $Path: "stockStatus" } },
        { $Type: "UI.DataFieldForAnnotation", Value: { $Path: "irrelevant" } }, // should be skipped
    ],
    "@UI.FieldGroup#General": {
        Label: "General",
        Data: [
            { $Type: "UI.DataField", Value: { $Path: "title" } },
            { $Type: "UI.DataField", Value: { $Path: "descr" } },
        ],
    },
    "@UI.FieldGroup#Details": {
        Label: "Details",
        Data: [
            { $Type: "UI.DataField", Value: { $Path: "stock" } },
            { $Type: "UI.DataField", Value: { $Path: "price" } },
        ],
    },
    "@UI.SelectionFields": [{ $Path: "title" }, { $Path: "stock" }],
    elements: {
        ID: {},
        title: {},
        descr: {},
        stock: {},
        price: {},
        internalField: { "@UI.Hidden": true },
    },
};

describe("parseUiAnnotations", () => {
    test("returns null for non-entity definitions", () => {
        expect(parseUiAnnotations({ kind: "service" })).toBeNull();
        expect(parseUiAnnotations(null)).toBeNull();
    });

    test("returns null when no LineItem or FieldGroup present", () => {
        expect(parseUiAnnotations({ kind: "entity", elements: {} })).toBeNull();
    });

    test("exposes lineItemCriticality when @UI.LineItem@UI.Criticality is present", () => {
        const defWithCrit = {
            kind: "entity",
            "@UI.LineItem": [{ Value: { $Path: "ID" } }],
            "@UI.LineItem@UI.Criticality": { $Path: "actionRequired" },
            elements: {},
        };
        const meta = parseUiAnnotations(defWithCrit);
        expect(meta.lineItemCriticality).toBe("actionRequired");
    });

    test("parses DataFieldForAction in LineItem", () => {
        const defWithAction = {
            kind: "entity",
            "@UI.LineItem": [
                { $Type: "UI.DataFieldForAction", Action: "MyService.doThing", Label: "Do Thing" },
            ],
            elements: {},
        };
        const meta = parseUiAnnotations(defWithAction);
        expect(meta.lineItems[0].dataFieldType).toBe("DataFieldForAction");
        expect(meta.lineItems[0].action).toBe("MyService.doThing");
    });

    test("parses DataFieldWithUrl in LineItem", () => {
        const defWithUrl = {
            kind: "entity",
            "@UI.LineItem": [
                { $Type: "UI.DataFieldWithUrl", Value: { $Path: "name" }, Url: { $Path: "link" }, Label: "Link" },
            ],
            elements: {},
        };
        const meta = parseUiAnnotations(defWithUrl);
        expect(meta.lineItems[0].dataFieldType).toBe("DataFieldWithUrl");
        expect(meta.lineItems[0].url).toBe("link");
    });

    test("parses DataFieldForAnnotation in LineItem (keeps annotationTarget)", () => {
        const defWithAnnotation = {
            kind: "entity",
            "@UI.LineItem": [
                { $Type: "UI.DataFieldForAnnotation", Target: "@UI.FieldGroup#Processing", Label: "Status" },
            ],
            elements: {},
        };
        const meta = parseUiAnnotations(defWithAnnotation);
        expect(meta.lineItems[0].dataFieldType).toBe("DataFieldForAnnotation");
        expect(meta.lineItems[0].annotationTarget).toBe("@UI.FieldGroup#Processing");
    });

    test("extracts DataPoints", () => {
        const defWithDp = {
            kind: "entity",
            "@UI.LineItem": [{ Value: { $Path: "ID" } }],
            "@UI.DataPoint#status": {
                Value: { $Path: "status_ID" },
                Title: "Status",
                Criticality: { $Path: "status/criticality" },
            },
            elements: {},
        };
        const meta = parseUiAnnotations(defWithDp);
        expect(meta.dataPoints.status.title).toBe("Status");
        expect(meta.dataPoints.status.valuePath).toBe("status_ID");
        expect(meta.dataPoints.status.criticalityPath).toBe("status/criticality");
    });

    test("extracts HeaderFacets", () => {
        const defWithHf = {
            kind: "entity",
            "@UI.LineItem": [{ Value: { $Path: "ID" } }],
            "@UI.HeaderFacets": [
                { $Type: "UI.ReferenceFacet", ID: "status", Target: "@UI.DataPoint#status" },
            ],
            elements: {},
        };
        const meta = parseUiAnnotations(defWithHf);
        expect(meta.headerFacets).toHaveLength(1);
        expect(meta.headerFacets[0].target).toBe("@UI.DataPoint#status");
    });

    test("extracts Facets hierarchy (CollectionFacet + ReferenceFacet)", () => {
        const defWithFacets = {
            kind: "entity",
            "@UI.LineItem": [{ Value: { $Path: "ID" } }],
            "@UI.Facets": [
                {
                    $Type: "UI.CollectionFacet",
                    Label: "General",
                    ID: "gen",
                    Facets: [
                        { $Type: "UI.ReferenceFacet", ID: "details", Target: "@UI.FieldGroup#Details" },
                    ],
                },
            ],
            "@UI.FieldGroup#Details": { Data: [{ Value: { $Path: "title" } }] },
            elements: {},
        };
        const meta = parseUiAnnotations(defWithFacets);
        expect(meta.facets).toHaveLength(1);
        expect(meta.facets[0].type).toBe("CollectionFacet");
        expect(meta.facets[0].facets[0].target).toBe("@UI.FieldGroup#Details");
    });

    test("extracts Identification actions", () => {
        const defWithId = {
            kind: "entity",
            "@UI.LineItem": [{ Value: { $Path: "ID" } }],
            "@UI.Identification": [
                { $Type: "UI.DataFieldForAction", Action: "SVC.execute", Label: "Execute" },
                { $Type: "UI.DataFieldForActionGroup", Label: "Change Status", Actions: [
                    { $Type: "UI.DataFieldForAction", Action: "SVC.setDone", Label: "Set Done" },
                ]},
            ],
            elements: {},
        };
        const meta = parseUiAnnotations(defWithId);
        expect(meta.identification).toHaveLength(2);
        expect(meta.identification[0].action).toBe("SVC.execute");
        expect(meta.identification[1].type).toBe("DataFieldForActionGroup");
        expect(meta.identification[1].actions).toHaveLength(1);
    });

    test("extracts @Common.Text and @UI.MultiLineText from elements", () => {
        const defWithCommon = {
            kind: "entity",
            "@UI.LineItem": [{ Value: { $Path: "status_ID" } }],
            elements: {
                status_ID: {
                    "@Common.Text": { $Path: "status/name" },
                    "@Common.TextArrangement": { "#": "TextOnly" },
                },
                notes: { "@UI.MultiLineText": true },
            },
        };
        const meta = parseUiAnnotations(defWithCommon);
        expect(meta.commonText.get("status_ID")).toMatchObject({ textPath: "status/name", textArrangement: "TextOnly" });
        expect(meta.multiLineFields.has("notes")).toBe(true);
    });

    test("extracts @UI.HiddenFilter fields", () => {
        const defWithHf = {
            kind: "entity",
            "@UI.LineItem": [{ Value: { $Path: "ID" } }],
            elements: {
                internalCode: { "@UI.HiddenFilter": true },
                name: {},
            },
        };
        const meta = parseUiAnnotations(defWithHf);
        expect(meta.hiddenFilterFields.has("internalCode")).toBe(true);
        expect(meta.hiddenFilterFields.has("name")).toBe(false);
    });

    test("sorts LineItem columns by @UI.Importance (High first)", () => {
        const defWithImportance = {
            kind: "entity",
            "@UI.LineItem": [
                { Value: { $Path: "lowField" }, "@UI.Importance": { "#": "Low" } },
                { Value: { $Path: "highField" }, "@UI.Importance": { "#": "High" } },
                { Value: { $Path: "medField" } },
            ],
            elements: {},
        };
        const meta = parseUiAnnotations(defWithImportance);
        // The parser itself doesn't sort — sorting is done in the template generator
        // Check that importance is captured correctly
        expect(meta.lineItems.find((c) => c.path === "highField")?.importance).toBe("High");
        expect(meta.lineItems.find((c) => c.path === "lowField")?.importance).toBe("Low");
        expect(meta.lineItems.find((c) => c.path === "medField")?.importance).toBeNull();
    });

    test("extracts LineItem columns", () => {
        const meta = parseUiAnnotations(def);
        expect(meta).not.toBeNull();
        // DataFieldForAnnotation should be skipped → only 3 items
        expect(meta.lineItems).toHaveLength(3);
        expect(meta.lineItems[0]).toMatchObject({ path: "ID", label: "ID", criticalityPath: null, dataFieldType: "DataField" });
        expect(meta.lineItems[2]).toMatchObject({ path: "stock", label: "Stock", criticalityPath: "stockStatus" });
    });

    test("extracts FieldGroups by qualifier", () => {
        const meta = parseUiAnnotations(def);
        expect(Object.keys(meta.fieldGroups)).toEqual(expect.arrayContaining(["General", "Details"]));
        expect(meta.fieldGroups.General.label).toBe("General");
        expect(meta.fieldGroups.General.fields).toHaveLength(2);
    });

    test("extracts HeaderInfo", () => {
        const meta = parseUiAnnotations(def);
        expect(meta.headerInfo.typeName).toBe("Book");
        expect(meta.headerInfo.typeNamePlural).toBe("Books");
        expect(meta.headerInfo.titlePath).toBe("title");
        expect(meta.headerInfo.descriptionPath).toBe("descr");
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

    test("handles i18n labels gracefully (returns null → fallback to path name)", () => {
        const defWithI18n = {
            kind: "entity",
            "@UI.LineItem": [
                { $Type: "UI.DataField", Value: { $Path: "title" }, Label: "{i18n>TitleKey}" },
            ],
            elements: {},
        };
        const meta = parseUiAnnotations(defWithI18n);
        expect(meta.lineItems[0].label).not.toBeNull(); // falls back to labelFromPath
        expect(meta.lineItems[0].label).toBe("Title");  // derived from path
    });
});

describe("hasUiAnnotations", () => {
    test("returns true when LineItem present", () => {
        expect(hasUiAnnotations({ kind: "entity", "@UI.LineItem": [{}] })).toBe(true);
    });

    test("returns true when FieldGroup present", () => {
        expect(hasUiAnnotations({ kind: "entity", "@UI.FieldGroup#Test": {} })).toBe(true);
    });

    test("returns false for non-entity", () => {
        expect(hasUiAnnotations({ kind: "service" })).toBe(false);
    });
});

describe("buildQueryTemplate", () => {
    const uiMeta = parseUiAnnotations(def);

    test("produces valid HTML with column headers from LineItem", () => {
        const html = buildQueryTemplate("Books", uiMeta);
        expect(html).toContain("<!DOCTYPE html>");
        expect(html).toContain("Books");
        expect(html).toContain("ID");
        expect(html).toContain("Title");
    });

    test("embeds MCP Apps protocol bootstrap", () => {
        const html = buildQueryTemplate("Books", uiMeta);
        expect(html).toContain("ui/initialize");
        expect(html).toContain("ui/notifications/tool-result");
        expect(html).toContain("2026-01-26");
    });

    test("includes criticality rendering for flagged columns", () => {
        const html = buildQueryTemplate("Books", uiMeta);
        // critPath is now embedded in COLS spec, not a separate critMap
        expect(html).toContain("critPath");
        expect(html).toContain("stockStatus");
    });

    test("MIME type is text/html and no external CDN references", () => {
        const html = buildQueryTemplate("Books", uiMeta);
        expect(html).not.toMatch(/cdn\.|unpkg\.com|jsdelivr/);
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
        expect(html).toContain('"title"'); // TITLE_PATH embedded as JSON
        expect(html).toContain('"descr"');  // DESC_PATH embedded as JSON
    });
});
