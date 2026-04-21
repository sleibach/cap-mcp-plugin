"use strict";

/**
 * Integration-style test for the $expand feature. Boots a real CAP runtime
 * via `cds.test` against an inline schema with compositions, registers the
 * plugin's MCP tools programmatically, and calls the tool handlers
 * end-to-end (no HTTP).
 *
 * What we assert:
 *   - No `expand` arg → compositions are implicitly included (the Mail2Edi fix).
 *   - `expand: ""` → implicit expansion is suppressed, scalars only.
 *   - `expand: "identifiers($top=1)"` → selective, schema-aware expand works.
 *   - `expand: "bogus"` → schema-aware rejection.
 *   - get-by-key honors the same runtime default.
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

// Isolate this fixture: each test run gets its own tempdir so the inline
// schema / data don't leak into another working directory.
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), "cap-mcp-expand-"));
fs.mkdirSync(path.join(FIXTURE, "db"));
fs.mkdirSync(path.join(FIXTURE, "srv"));

fs.writeFileSync(path.join(FIXTURE, "db/schema.cds"), `
using { cuid } from '@sap/cds/common';
namespace demo;

entity PartnerProfiles : cuid {
  name        : String;
  identifiers : Composition of many Identifier on identifiers.owner = $self;
  systems     : Composition of many System     on systems.owner     = $self;
}

entity Identifier : cuid {
  scheme : String;
  value  : String;
  owner  : Association to PartnerProfiles;
}

entity System : cuid {
  name  : String;
  owner : Association to PartnerProfiles;
}
`);

fs.writeFileSync(path.join(FIXTURE, "srv/cat.cds"), `
using {demo} from '../db/schema';

service CatalogService {
  entity PartnerProfiles as projection on demo.PartnerProfiles;
}

annotate CatalogService.PartnerProfiles with @mcp: {
  name       : 'partner-profiles',
  description: 'Partner profiles with compositions',
  resource   : true
};

annotate CatalogService.PartnerProfiles with @mcp.wrap: {
  tools: true,
  modes: ['query', 'get']
};
`);

fs.writeFileSync(path.join(FIXTURE, "package.json"), JSON.stringify({
  name: "cap-mcp-expand-fixture",
  private: true,
  dependencies: { "@sap/cds": "^9" },
  cds: {
    requires: { db: { kind: "sqlite", credentials: { url: ":memory:" } } },
    mcp: { auth: "none", session_store: { kind: "stateless" } },
  },
}));

const cds = require("@sap/cds");
// Emulate what the plugin's cds-plugin.js expects: one global cds instance.
global.cds = cds;

describe("$expand integration against a real CAP runtime", () => {
  // cds.test starts the server in the fixture dir; all events fire.
  cds.test(FIXTURE);

  let queryHandler;
  let getHandler;
  let resAnno;
  const capturedTools = new Map();

  beforeAll(async () => {
    // Parse annotations once the model is loaded.
    const { parseDefinitions } = require("../../lib/annotations/parser");
    const annotations = parseDefinitions(cds.model);
    resAnno = annotations.get("CatalogService.PartnerProfiles");
    expect(resAnno).toBeDefined();

    // Minimal MCP server stub: captures registered tools so we can invoke
    // them directly. This avoids spinning up an HTTP MCP client just to
    // assert handler behavior.
    const server = {
      registerTool(name, _meta, handler) {
        capturedTools.set(name, handler);
      },
    };
    const { registerEntityWrappers } = require("../../lib/mcp/entity-tools");
    registerEntityWrappers(resAnno, server, false, ["query", "get"], {
      canRead: true, canCreate: false, canUpdate: false, canDelete: false,
    });

    // When @mcp.name is set, wrapper tools use `{name}_{mode}` (short names for 64-char client limits).
    queryHandler = capturedTools.get("partner-profiles_query");
    getHandler = capturedTools.get("partner-profiles_get");
    expect(queryHandler).toBeDefined();
    expect(getHandler).toBeDefined();

    // Seed.
    await cds.run(INSERT.into("CatalogService.PartnerProfiles").entries({
      ID: "11111111-1111-4111-1111-111111111111",
      name: "ACME GmbH",
      identifiers: [
        { ID: "22222222-2222-4222-2222-222222222201", scheme: "GLN", value: "4012345678901" },
        { ID: "22222222-2222-4222-2222-222222222202", scheme: "DUNS", value: "123456789" },
      ],
      systems: [
        { ID: "33333333-3333-4333-3333-333333333301", name: "SAP S/4" },
      ],
    }));
  });

  // Helper: unpack a McpResult -> rows array.
  const rowsFrom = (res) => res.content.map((c) => JSON.parse(c.text));

  test("implicit composition expansion returns identifiers + systems by default", async () => {
    const res = await queryHandler({ top: 5 });
    const rows = rowsFrom(res);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.name).toBe("ACME GmbH");
    expect(Array.isArray(row.identifiers)).toBe(true);
    expect(row.identifiers).toHaveLength(2);
    expect(Array.isArray(row.systems)).toBe(true);
    expect(row.systems).toHaveLength(1);
  });

  test("expand='' opts out — scalars only, no compositions", async () => {
    const res = await queryHandler({ top: 5, expand: "" });
    const row = rowsFrom(res)[0];
    expect(row.name).toBe("ACME GmbH");
    expect(row.identifiers).toBeUndefined();
    expect(row.systems).toBeUndefined();
  });

  test("selective expand 'identifiers($top=1)' pulls only identifiers, capped", async () => {
    const res = await queryHandler({ top: 5, expand: "identifiers($top=1)" });
    const row = rowsFrom(res)[0];
    expect(row.identifiers).toHaveLength(1);
    expect(row.systems).toBeUndefined();
  });

  test("unknown nav prop is rejected with EXPAND_PARSE_ERROR", async () => {
    const res = await queryHandler({ expand: "bogus" });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error).toBe("EXPAND_PARSE_ERROR");
    expect(payload.message).toMatch(/unknown navigation property/);
  });

  test("get-by-key includes compositions by default", async () => {
    const res = await getHandler({ ID: "11111111-1111-4111-1111-111111111111" });
    const row = JSON.parse(res.content[0].text);
    expect(row.name).toBe("ACME GmbH");
    expect(row.identifiers).toHaveLength(2);
    expect(row.systems).toHaveLength(1);
  });

  test("get-by-key with expand='' returns scalars only", async () => {
    const res = await getHandler({ ID: "11111111-1111-4111-1111-111111111111", expand: "" });
    const row = JSON.parse(res.content[0].text);
    expect(row.name).toBe("ACME GmbH");
    expect(row.identifiers).toBeUndefined();
    expect(row.systems).toBeUndefined();
  });
});
