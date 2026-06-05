"use strict";

/**
 * Column-spec rules for MCP App list views (LineItem / Hidden / service fields).
 */

global.cds = { log: () => ({ debug() {}, info() {}, warn() {}, error() {} }), env: { requires: { auth: { kind: "mocked" } } } };

const path = require("path");
const cds = require("@sap/cds");
const { parseUiAnnotations } = require("../../lib/annotations/ui-parser");
const { buildQueryTemplate } = require("../../lib/mcp/apps/template-generator");
const { _listExposableFields } = require("../../lib/mcp/apps");
const { parseDefinitions } = require("../../lib/annotations/parser");

const BOOKSHOP = path.join(__dirname, "../bookshop-ias");

function colsFromHtml(html) {
    return JSON.parse(html.match(/var COLS=([^;]+);/)[1]);
}

describe("MCP Apps list column rules (Genres)", () => {
    let genresDef;
    let genresEntry;
    let model;

    beforeAll(async () => {
        model = await cds.load("*", { root: BOOKSHOP });
        genresDef = model.definitions["AdminService.Genres"];
        const annotations = parseDefinitions(model);
        genresEntry = annotations.get("AdminService.Genres");
    });

    test("descr is service-exposed but not in LineItem", () => {
        const meta = parseUiAnnotations(genresDef);
        expect(meta.lineItems.map((c) => c.path)).toEqual(["name"]);
        const exposable = _listExposableFields(genresEntry, genresDef, model, meta);
        expect(exposable.some((f) => f.path === "descr")).toBe(true);
        expect(exposable.some((f) => f.path === "ID")).toBe(false);
    });

    test("generated COLS: name visible, descr optional, ID absent", () => {
        const meta = parseUiAnnotations(genresDef);
        const exposable = _listExposableFields(genresEntry, genresDef, model, meta);
        const html = buildQueryTemplate("Genres", meta, "Bookshop", null, { exposableFields: exposable });
        const cols = colsFromHtml(html);
        expect(cols.find((c) => c.path === "name")).toMatchObject({ visible: true });
        expect(cols.find((c) => c.path === "descr")).toMatchObject({ visible: false });
        expect(cols.find((c) => c.path === "ID")).toBeUndefined();
    });
});
