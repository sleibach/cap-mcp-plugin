"use strict";

/**
 * Live-compile cross-check for the UI annotation parser.
 *
 * Compiles a real CDS model via @sap/cds and runs parseUiAnnotations against
 * the resulting runtime CSN — the exact shape the plugin sees at runtime. This
 * is the guard that catches CSN-encoding drift (flattened struct keys, { "=" }
 * paths, { "#" } enums) that hand-written fixtures might miss.
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const cds = require("@sap/cds");
const { parseUiAnnotations } = require("../../lib/annotations/ui-parser");

let meta;

beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-mcp-uiparse-"));
    fs.mkdirSync(path.join(dir, "db"));
    fs.mkdirSync(path.join(dir, "srv"));

    fs.writeFileSync(path.join(dir, "db/schema.cds"), `
namespace t;
entity Items {
  key ID : Integer;
  name   : String;
  size   : Integer;
  url    : String;
  notes  : String;
  status : Association to Stat;
}
entity Stat { key ID : String; name : String; criticality : Integer; }
`);

    fs.writeFileSync(path.join(dir, "srv/svc.cds"), `
using { t } from '../db/schema';
service S { entity Items as projection on t.Items; entity Stats as projection on t.Stat; }
annotate S.Items with @(
  UI.LineItem : [
    { $Type: 'UI.DataField', Value: name, Label: 'Name', ![@UI.Importance]: #High },
    { $Type: 'UI.DataField', Value: status_ID, Criticality: status.criticality, CriticalityRepresentation: #WithIcon },
    { $Type: 'UI.DataFieldWithUrl', Value: name, Url: url },
    { $Type: 'UI.DataFieldForAction', Action: 'S.doThing', Label: 'Do Thing' },
  ],
  UI.FieldGroup #G : { Data: [ { Value: name }, { Value: status_ID, Criticality: status.criticality } ] },
  UI.HeaderInfo : { TypeName: 'Item', TypeNamePlural: 'Items', Title: { Value: name }, Description: { Value: url } },
  UI.DataPoint #dp1 : { Value: status_ID, Title: 'St', Criticality: status.criticality },
  UI.Facets : [
    { $Type: 'UI.CollectionFacet', Label: 'Coll', ID: 'c1', Facets: [
      { $Type: 'UI.ReferenceFacet', ID: 'r1', Target: '@UI.FieldGroup#G' }
    ]}
  ],
  UI.Identification : [ { $Type: 'UI.DataFieldForAction', Action: 'S.act1', Label: 'Act1' } ],
);
annotate S.Items with { notes @UI.MultiLineText; status @Common.Text: status.name @Common.TextArrangement: #TextOnly; };
`);

    const model = await cds.load(path.join(dir, "srv"));
    meta = parseUiAnnotations(model.definitions["S.Items"]);
});

test("parses LineItem columns from live-compiled CSN", () => {
    expect(meta).not.toBeNull();
    const df = meta.lineItems.filter((c) => c.dataFieldType === "DataField");
    expect(df.map((c) => c.path)).toEqual(["name", "status_ID"]);
    expect(df.find((c) => c.path === "name").importance).toBe("High");
    expect(df.find((c) => c.path === "status_ID").criticalityPath).toBe("status.criticality");
});

test("parses DataFieldWithUrl and DataFieldForAction", () => {
    const url = meta.lineItems.find((c) => c.dataFieldType === "DataFieldWithUrl");
    expect(url).toMatchObject({ path: "name", url: "url" });
    const act = meta.lineItems.find((c) => c.dataFieldType === "DataFieldForAction");
    expect(act.action).toBe("S.doThing");
});

test("reconstructs FieldGroup from flattened keys", () => {
    expect(meta.fieldGroups.G.fields.map((f) => f.path)).toEqual(["name", "status_ID"]);
});

test("reconstructs HeaderInfo from flattened keys", () => {
    expect(meta.headerInfo).toMatchObject({ typeName: "Item", titlePath: "name", descriptionPath: "url" });
});

test("reconstructs DataPoint from flattened keys", () => {
    expect(meta.dataPoints.dp1).toMatchObject({ title: "St", valuePath: "status_ID", criticalityPath: "status.criticality" });
});

test("parses Facets hierarchy and Identification", () => {
    expect(meta.facets[0].type).toBe("CollectionFacet");
    expect(meta.facets[0].facets[0].target).toBe("@UI.FieldGroup#G");
    expect(meta.identification[0].action).toBe("S.act1");
});

test("parses element-level @Common.Text and @UI.MultiLineText", () => {
    expect(meta.commonText.get("status")).toMatchObject({ textPath: "status.name", textArrangement: "TextOnly" });
    expect(meta.multiLineFields.has("notes")).toBe(true);
});
