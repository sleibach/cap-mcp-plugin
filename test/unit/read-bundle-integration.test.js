"use strict";

/**
 * Integration test for read bundling against a real CAP runtime.
 *
 * Two layers:
 *   1. Factory orchestration — with `cds.mcp.read_bundle.enabled`, createMcpServer
 *      collapses per-entity query/get into one `<Service>_read` tool per service,
 *      while write/draft tools stay per-entity.
 *   2. Handler dispatch — registerReadBundleTool's handler resolves `resource`,
 *      runs query (filter/orderby/count), get-by-key, draft reads, and validates
 *      modes/fields, reusing the shared runQuery/runGet code path (incl. the new
 *      buildQuery `filterExpr` branch).
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), "cap-mcp-readbundle-"));
fs.mkdirSync(path.join(FIXTURE, "db"));
fs.mkdirSync(path.join(FIXTURE, "srv"));

fs.writeFileSync(
  path.join(FIXTURE, "db/schema.cds"),
  `
using { cuid } from '@sap/cds/common';
namespace demo;

entity Books {
  key ID : Integer;
  title  : String;
  stock  : Integer;
  price  : Integer;
}

entity Authors : cuid {
  name : String;
}
`,
);

fs.writeFileSync(
  path.join(FIXTURE, "srv/cat.cds"),
  `
using {demo} from '../db/schema';

service AdminService {
  entity Books   as projection on demo.Books;
  entity Authors as projection on demo.Authors;
}

service CatalogService {
  @readonly entity ListedBooks as projection on demo.Books;
}

annotate AdminService.Books with @mcp: {
  name       : 'admin-books',
  description: 'Book catalog',
  resource   : true
};
annotate AdminService.Books with @mcp.wrap: {
  tools: true,
  modes: ['query', 'get', 'create', 'update', 'delete']
};

annotate AdminService.Authors with @odata.draft.enabled;
annotate AdminService.Authors with @mcp: {
  name       : 'admin-authors',
  description: 'Book authors',
  resource   : true
};
annotate AdminService.Authors with @mcp.wrap: {
  tools: true,
  modes: ['query', 'get']
};

annotate CatalogService.ListedBooks with @mcp: {
  name       : 'listed-books',
  description: 'Read-only book listing',
  resource   : true
};
annotate CatalogService.ListedBooks with @mcp.wrap: {
  tools: true,
  modes: ['query']
};
`,
);

fs.writeFileSync(
  path.join(FIXTURE, "package.json"),
  JSON.stringify({
    name: "cap-mcp-readbundle-fixture",
    private: true,
    dependencies: { "@sap/cds": "^9" },
    cds: {
      requires: { db: { kind: "sqlite", credentials: { url: ":memory:" } } },
      mcp: {
        auth: "none",
        session_store: { kind: "stateless" },
        read_bundle: { enabled: true, group_by: "service" },
      },
    },
  }),
);

const cds = require("@sap/cds");
global.cds = cds;

describe("Read bundling against a real CAP runtime", () => {
  cds.test(FIXTURE);

  let annotations;
  let config;

  beforeAll(async () => {
    const { INSERT } = cds.ql;
    await cds.run(
      INSERT.into("demo.Books").entries(
        { ID: 1, title: "Wuthering Heights", stock: 12, price: 11 },
        { ID: 2, title: "Catweazle", stock: 0, price: 9 },
        { ID: 3, title: "Eleonora", stock: 5, price: 14 },
      ),
    );
    // Direct insert into the underlying entity creates active rows for the
    // draft-enabled Authors, bypassing the draft lifecycle for read tests.
    await cds.run(
      INSERT.into("demo.Authors").entries({
        ID: "11111111-1111-4111-8111-111111111111",
        name: "Emily Bronte",
      }),
    );

    const { parseDefinitions } = require("../../lib/annotations/parser");
    annotations = parseDefinitions(cds.model);
    const { loadConfiguration } = require("../../lib/config/loader");
    config = loadConfiguration();
  });

  // --- Layer 1: factory orchestration --------------------------------------

  describe("factory orchestration", () => {
    let toolNames;

    beforeAll(() => {
      const { createMcpServer } = require("../../lib/mcp/factory");
      const server = createMcpServer(config, annotations);
      toolNames = Object.keys(server._registeredTools || {});
    });

    test("bundling config is active", () => {
      expect(config.read_bundle.enabled).toBe(true);
      expect(config.read_bundle.group_by).toBe("service");
    });

    test("registers one read tool per service", () => {
      expect(toolNames).toEqual(
        expect.arrayContaining(["AdminService_read", "CatalogService_read"]),
      );
    });

    test("per-entity query/get tools are NOT registered", () => {
      for (const dead of [
        "admin-books_query",
        "admin-books_get",
        "admin-authors_query",
        "admin-authors_get",
        "listed-books_query",
        "listed-books_get",
      ]) {
        expect(toolNames).not.toContain(dead);
      }
    });

    test("write tools stay per-entity", () => {
      expect(toolNames).toEqual(
        expect.arrayContaining([
          "admin-books_create",
          "admin-books_update",
          "admin-books_delete",
        ]),
      );
    });

    test("draft tools stay per-entity for draft roots", () => {
      expect(toolNames).toEqual(
        expect.arrayContaining([
          "admin-authors_draft-new",
          "admin-authors_draft-edit",
          "admin-authors_draft-patch",
          "admin-authors_draft-activate",
          "admin-authors_draft-discard",
        ]),
      );
    });
  });

  // --- Layer 2: handler dispatch -------------------------------------------

  describe("bundle handler dispatch", () => {
    const captured = new Map();
    const stub = {
      registerTool(name, _meta, handler) {
        captured.set(name, handler);
      },
    };

    beforeAll(() => {
      const { registerReadBundleTool } = require("../../lib/mcp/entity-tools");
      const books = annotations.get("AdminService.Books");
      const authors = annotations.get("AdminService.Authors");
      registerReadBundleTool(
        "AdminService",
        [
          { resAnno: books, readModes: ["query", "get"] },
          { resAnno: authors, readModes: ["query", "get"] },
        ],
        stub,
        false,
        config,
      );
      // A query-only bundle to exercise the MODE_NOT_ALLOWED path.
      registerReadBundleTool(
        "CatalogService",
        [{ resAnno: books, readModes: ["query"] }],
        stub,
        false,
        config,
      );
    });

    const callAdmin = (args) => captured.get("AdminService_read")(args);
    const callCatalog = (args) => captured.get("CatalogService_read")(args);
    const rows = (res) => JSON.parse(res.content[0].text);

    test("query with filterExpr returns only matching rows", async () => {
      const res = await callAdmin({
        resource: "admin-books",
        mode: "query",
        filter: "stock > 0",
      });
      expect(res.isError).toBeFalsy();
      const data = rows(res);
      const ids = data.map((r) => r.ID).sort();
      expect(ids).toEqual([1, 3]);
    });

    test("query with orderby + top sorts and limits", async () => {
      const res = await callAdmin({
        resource: "admin-books",
        mode: "query",
        orderby: ["price desc"],
        top: 2,
      });
      const data = rows(res);
      expect(data).toHaveLength(2);
      expect(data[0].ID).toBe(3); // price 14
      expect(data[1].ID).toBe(1); // price 11
    });

    test("query return=count honours the filter", async () => {
      const res = await callAdmin({
        resource: "admin-books",
        mode: "query",
        filter: "stock > 0",
        return: "count",
      });
      expect(JSON.parse(res.content[0].text)).toEqual({ count: 2 });
    });

    test("get by key returns a single row", async () => {
      const res = await callAdmin({
        resource: "admin-books",
        mode: "get",
        key: 2,
      });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(res.content[0].text).title).toBe("Catweazle");
    });

    test("query reads active rows of a draft-enabled resource", async () => {
      const res = await callAdmin({
        resource: "admin-authors",
        mode: "query",
      });
      expect(res.isError).toBeFalsy();
      const data = rows(res);
      expect(data.some((r) => r.name === "Emily Bronte")).toBe(true);
    });

    test("unknown select field is rejected with INVALID_FIELD", async () => {
      const res = await callAdmin({
        resource: "admin-books",
        mode: "query",
        select: ["title", "bogus"],
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("INVALID_FIELD");
    });

    test("get on a query-only resource is rejected with MODE_NOT_ALLOWED", async () => {
      const res = await callCatalog({
        resource: "admin-books",
        mode: "get",
        key: 1,
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("MODE_NOT_ALLOWED");
    });

    test("a resource outside the bundle's enum fails validation", async () => {
      const res = await callAdmin({
        resource: "does-not-exist",
        mode: "query",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("INVALID_INPUT");
    });
  });
});
