"use strict";

/**
 * Comprehensive end-to-end MCP protocol tests.
 *
 * Boots a CAP runtime via `cds.test` against a synthesised fixture that
 * covers every tool-surface category the plugin produces:
 *   - Non-draft entity CRUD (Authors)
 *   - Draft-enabled entity with composition (Orders → OrderItems)
 *   - Unbound action (submitOrder)
 *   - Bound action on entity (reviseStock on Books)
 *   - Pure @mcp.resource (Books — no wrap.tools)
 *   - Role-gated service (@requires:'admin' on AdminService)
 *
 * Each test talks to the real MCP HTTP transport via the `createMcpClient`
 * helper, so the full path (HTTP → auth middleware → session manager →
 * tool → CAP handler) is exercised.
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), "cap-mcp-comprehensive-"));
fs.mkdirSync(path.join(FIXTURE, "db"));
fs.mkdirSync(path.join(FIXTURE, "srv"));

fs.writeFileSync(path.join(FIXTURE, "db/schema.cds"), `
using { cuid, managed } from '@sap/cds/common';
namespace e2e;

entity Authors : cuid, managed {
  name         : String @mandatory;
  dateOfBirth  : Date;
  placeOfBirth : String;
}

entity Books : cuid, managed {
  title  : String @mandatory;
  stock  : Integer;
  price  : Decimal(9,2);
  author : Association to Authors;
}

entity Orders : cuid, managed {
  orderNo      : String @mandatory;
  customerName : String @mandatory;
  status       : String enum { open; submitted; fulfilled; cancelled } default 'open';
  total        : Decimal(11,2);
  items        : Composition of many OrderItems on items.parent = $self;
}

entity OrderItems : cuid {
  parent   : Association to Orders;
  book     : Association to Books;
  quantity : Integer @mandatory;
  price    : Decimal(9,2);
}
`);

fs.writeFileSync(path.join(FIXTURE, "srv/catalog.cds"), `
using {e2e} from '../db/schema';

service CatalogService {
  @readonly
  entity Books as projection on e2e.Books actions {
    action reviseStock(delta: Integer) returns Books;
  };
  action submitOrder(book: UUID, quantity: Integer) returns { stock: Integer };
}

annotate CatalogService.Books with @mcp: {
  name       : 'catalog-books',
  description: 'Public book catalog (read-only)',
  resource   : ['filter', 'orderby', 'select', 'top', 'skip']
};
// NOTE: no @mcp.wrap.tools — this is a pure resource (resources/read only).

annotate CatalogService.submitOrder with @mcp: {
  name       : 'submit-order',
  description: 'Submit an order for a book',
  tool       : true
};

annotate CatalogService.Books actions {
  reviseStock @mcp: {
    name       : 'revise-stock',
    description: 'Adjust stock by delta (bound action)',
    tool       : true
  };
};
`);

fs.writeFileSync(path.join(FIXTURE, "srv/admin.cds"), `
using {e2e} from '../db/schema';

@requires: 'admin'
service AdminService {
  entity Authors    as projection on e2e.Authors;
  @odata.draft.enabled
  entity Orders     as projection on e2e.Orders;
  entity OrderItems as projection on e2e.OrderItems;
}

annotate AdminService.Authors with @mcp: {
  name       : 'authors',
  description: 'Authors (non-draft CRUD)',
  resource   : ['filter', 'orderby', 'select', 'top', 'skip']
};
annotate AdminService.Authors with @mcp.wrap: {
  tools: true,
  modes: ['query', 'get', 'create', 'update', 'delete']
};

annotate AdminService.Orders with @mcp: {
  name       : 'orders',
  description: 'Orders (draft-enabled with composition)',
  resource   : ['filter', 'orderby', 'select', 'top', 'skip']
};
annotate AdminService.Orders with @mcp.wrap: {
  tools: true,
  modes: ['query', 'get', 'create', 'update', 'delete']
};
`);

fs.writeFileSync(path.join(FIXTURE, "srv/catalog.js"), `
module.exports = (srv) => {
  const { SELECT, UPDATE } = global.cds.ql;
  srv.on('submitOrder', async (req) => {
    const { book, quantity } = req.data;
    if (!book || !quantity) return req.reject(400, 'book and quantity required');
    const b = await SELECT.one.from('e2e.Books').where({ ID: book });
    if (!b) return req.reject(404, 'Book not found');
    if ((b.stock || 0) < quantity) return req.reject(409, 'INSUFFICIENT_STOCK');
    await UPDATE('e2e.Books').set({ stock: b.stock - quantity }).where({ ID: book });
    return { stock: b.stock - quantity };
  });
  srv.on('reviseStock', 'Books', async (req) => {
    const id = req.params[0] && req.params[0].ID;
    const delta = req.data.delta || 0;
    if (!id) return req.reject(400, 'missing key');
    const b = await SELECT.one.from('e2e.Books').where({ ID: id });
    if (!b) return req.reject(404, 'Book not found');
    const next = (b.stock || 0) + delta;
    if (next < 0) return req.reject(409, 'STOCK_NEGATIVE');
    await UPDATE('e2e.Books').set({ stock: next }).where({ ID: id });
    return Object.assign({}, b, { stock: next });
  });
};
`);

fs.writeFileSync(path.join(FIXTURE, "package.json"), JSON.stringify({
  name: "cap-mcp-comprehensive-fixture",
  private: true,
  dependencies: { "@sap/cds": "^9" },
  cds: {
    requires: {
      db: { kind: "sqlite", credentials: { url: ":memory:" } },
      auth: {
        kind: "mocked",
        users: {
          alice: { password: "alice", roles: ["admin"] },
          bob:   { password: "bob",   roles: [] },
          carol: { password: "carol", roles: ["admin"] },
        },
      },
    },
    mcp: { auth: "inherit", session_store: { kind: "stateless" } },
  },
}));

const cds = require("@sap/cds");
global.cds = cds;
// Preload plugin — the temp fixture has no node_modules for auto-discovery.
require("../../cds-plugin.js");
const { createMcpClient } = require("./helpers/mcp-client");

// Deterministic seed IDs.
const AUTHOR_A = "00000000-0000-4000-8000-000000000A01";
const AUTHOR_B = "00000000-0000-4000-8000-000000000A02";
const BOOK_A   = "00000000-0000-4000-8000-000000000B01";
const BOOK_B   = "00000000-0000-4000-8000-000000000B02";
const BOOK_C   = "00000000-0000-4000-8000-000000000B03";

describe("E2E: comprehensive MCP protocol surface", () => {
  const T = cds.test(FIXTURE);
  let alice, bob, carol;

  beforeAll(async () => {
    await cds.tx({ user: cds.User.privileged }, async (tx) => {
      await tx.run(INSERT.into("e2e.Authors").entries([
        { ID: AUTHOR_A, name: "Author Alpha",  placeOfBirth: "Berlin" },
        { ID: AUTHOR_B, name: "Author Beta",   placeOfBirth: "Paris"  },
      ]));
      await tx.run(INSERT.into("e2e.Books").entries([
        { ID: BOOK_A, title: "Book A", stock: 10, price: 9.99,  author_ID: AUTHOR_A },
        { ID: BOOK_B, title: "Book B", stock: 20, price: 19.99, author_ID: AUTHOR_A },
        { ID: BOOK_C, title: "Book C", stock: 5,  price: 4.99,  author_ID: AUTHOR_B },
      ]));
    });
    alice = await createMcpClient(T.url, "alice");
    bob   = await createMcpClient(T.url, "bob");
    carol = await createMcpClient(T.url, "carol");
  });

  afterAll(async () => {
    await Promise.all([alice?.close(), bob?.close(), carol?.close()].filter(Boolean));
  });

  // ---------------------------------------------------------------------------
  // 1. Discovery surface
  // ---------------------------------------------------------------------------
  describe("discovery tools", () => {
    test("cap_whoami returns the authenticated principal", async () => {
      const a = await alice.call("cap_whoami");
      expect(a.isError).toBeFalsy();
      expect(a.parsed?.user?.id).toBe("alice");
    });

    test("cap_describe_model lists services and entities; per-entity example names match real tool names (D-03)", async () => {
      // Overview: services + entities
      const overview = await alice.call("cap_describe_model");
      expect(overview.isError).toBeFalsy();
      expect(overview.parsed?.services).toContain("AdminService");
      expect(Array.isArray(overview.parsed?.entities)).toBe(true);
      expect(overview.parsed.entities).toContain("AdminService.Authors");

      // Per-entity describe surfaces tool-name examples that must match what
      // `registerTool` actually registered, including `@mcp.name` overrides.
      const real = new Set((await alice.listTools()).tools.map((t) => t.name));
      const ent = await alice.call("cap_describe_model", { service: "AdminService", entity: "Authors" });
      expect(ent.isError).toBeFalsy();
      expect(real.has(ent.parsed?.examples?.list_tool)).toBe(true);
      expect(real.has(ent.parsed?.examples?.get_tool)).toBe(true);
    });

    test("tools/list shows entity + action tools for admin user", async () => {
      const r = await alice.listTools();
      const names = new Set(r.tools.map((t) => t.name));
      for (const n of [
        "authors_query", "authors_get", "authors_create", "authors_update", "authors_delete",
        "orders_query", "orders_get", "orders_draft-new", "orders_draft-edit",
        "orders_draft-patch", "orders_draft-activate", "orders_draft-discard",
        "orders_draft-upsert", "orders_delete",
        "submit-order", "revise-stock",
        "cap_whoami", "cap_describe_model",
      ]) {
        expect(names.has(n)).toBe(true);
      }
    });

    test("pure resource (catalog-books) is NOT in tools/list", async () => {
      const r = await alice.listTools();
      const names = new Set(r.tools.map((t) => t.name));
      // No wrap.tools → must not surface as a tool.
      expect(names.has("catalog-books_query")).toBe(false);
      expect(names.has("catalog-books_get")).toBe(false);
    });

    test("resources/list or resource-templates/list exposes the pure resource", async () => {
      // The plugin registers resources with OData functionality as dynamic
      // templates (so clients can parameterise filter/select/etc), so they
      // appear under resourceTemplates/list, not resources/list.
      const r = await alice.client.listResources();
      const rt = await alice.client.listResourceTemplates();
      const flat  = (r?.resources || []).map((x) => x.uri);
      const tmpls = (rt?.resourceTemplates || []).map((x) => x.uriTemplate || x.uri);
      const all = [...flat, ...tmpls].join("\n");
      expect(all).toMatch(/catalog-books/);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Role-based tool filtering (D-01)
  // ---------------------------------------------------------------------------
  describe("role-based filtering", () => {
    test("bob sees only discovery tools", async () => {
      const r = await bob.listTools();
      const names = new Set(r.tools.map((t) => t.name));
      expect(names.has("cap_whoami")).toBe(true);
      expect(names.has("cap_describe_model")).toBe(true);
      // No admin-service tools for bob.
      for (const n of ["authors_query", "orders_draft-new"]) {
        expect(names.has(n)).toBe(false);
      }
    });

    test("bob invoking an admin tool is rejected", async () => {
      let caught, res;
      try { res = await bob.call("authors_query", {}); }
      catch (e) { caught = e; }
      const msg = caught ? String(caught.message ?? caught)
                         : String(res?.parsed?.error ?? res?.parsed?.message ?? res?.text ?? "");
      expect(msg).toMatch(/disabled|not found|forbidden|not available|unknown tool/i);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Non-draft CRUD (Authors)
  // ---------------------------------------------------------------------------
  describe("non-draft CRUD on Authors", () => {
    test("query returns JSON array (D-04 regression guard)", async () => {
      const r = await alice.call("authors_query", { select: ["ID", "name"] });
      expect(r.isError).toBeFalsy();
      expect(Array.isArray(r.parsed)).toBe(true);
      expect(r.parsed.length).toBeGreaterThanOrEqual(2);
    });

    test("query supports filter + orderby + top/skip", async () => {
      const r = await alice.call("authors_query", {
        where: [{ field: "placeOfBirth", op: "eq", value: "Berlin" }],
        orderby: [{ field: "name", dir: "asc" }],
        select: ["name", "placeOfBirth"],
        top: 5, skip: 0,
      });
      expect(r.isError).toBeFalsy();
      expect(Array.isArray(r.parsed)).toBe(true);
      expect(r.parsed.every((row) => row.placeOfBirth === "Berlin")).toBe(true);
    });

    test("get by key returns single row", async () => {
      const r = await alice.call("authors_get", { ID: AUTHOR_A });
      expect(r.isError).toBeFalsy();
      expect(r.parsed?.ID).toBe(AUTHOR_A);
      expect(r.parsed?.name).toBe("Author Alpha");
    });

    test("get with bogus key returns NOT_FOUND-like error", async () => {
      const r = await alice.call("authors_get", { ID: "ffffffff-0000-4000-8000-000000000000" });
      expect(r.isError).toBe(true);
    });

    test("create + update + delete happy path", async () => {
      const create = await alice.call("authors_create", { name: "Temp Author" });
      expect(create.isError).toBeFalsy();
      const tempId = create.parsed?.ID;
      expect(typeof tempId).toBe("string");

      const update = await alice.call("authors_update", { ID: tempId, placeOfBirth: "London" });
      expect(update.isError).toBeFalsy();
      expect(update.parsed?.placeOfBirth).toBe("London");

      const del = await alice.call("authors_delete", { ID: tempId });
      expect(del.isError).toBeFalsy();

      const get = await alice.call("authors_get", { ID: tempId });
      expect(get.isError).toBe(true);
    });

    test("create without mandatory field yields validation error", async () => {
      const r = await alice.call("authors_create", { placeOfBirth: "Nowhere" });
      expect(r.isError).toBe(true);
    });

    test("input schema for authors_create omits draft-internal fields (D-06)", async () => {
      const r = await alice.listTools();
      const t = r.tools.find((x) => x.name === "authors_create");
      const keys = Object.keys(t?.inputSchema?.properties || {});
      for (const forbidden of [
        "IsActiveEntity", "HasActiveEntity", "HasDraftEntity",
        "SiblingEntity_ID", "DraftAdministrativeData_DraftUUID",
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Draft lifecycle + composition (Orders)
  // ---------------------------------------------------------------------------
  describe("draft lifecycle on Orders with composition", () => {
    test("draft-new returns generated ID (D-02)", async () => {
      const r = await alice.call("orders_draft-new", {
        orderNo: "O-100", customerName: "Cust A",
      });
      expect(r.isError).toBeFalsy();
      expect(typeof r.parsed?.ID).toBe("string");
      // Cleanup
      await alice.call("orders_draft-discard", { ID: r.parsed.ID });
    });

    test("full lifecycle: new → patch (scalar) → activate", async () => {
      const n = await alice.call("orders_draft-new", {
        orderNo: "O-101", customerName: "Cust B",
      });
      expect(n.isError).toBeFalsy();
      const id = n.parsed.ID;

      const p = await alice.call("orders_draft-patch", { ID: id, total: 42.50 });
      expect(p.isError).toBeFalsy();

      const act = await alice.call("orders_draft-activate", { ID: id });
      expect(act.isError).toBeFalsy();
      expect(act.parsed?.IsActiveEntity).toBe(true);
      expect(act.parsed?.ID).toBe(id);
    });

    test("draft-new with composition deep-insert", async () => {
      const n = await alice.call("orders_draft-new", {
        orderNo: "O-102",
        customerName: "Cust C",
        items: [
          { book_ID: BOOK_A, quantity: 2, price: 9.99 },
          { book_ID: BOOK_B, quantity: 1, price: 19.99 },
        ],
      });
      expect(n.isError).toBeFalsy();
      const id = n.parsed.ID;

      const act = await alice.call("orders_draft-activate", { ID: id });
      expect(act.isError).toBeFalsy();

      // Verify items via direct service query
      const items = await cds.tx({ user: cds.User.privileged }, (tx) =>
        tx.run(SELECT.from("e2e.OrderItems").where({ parent_ID: id })));
      expect(items.length).toBe(2);
    });

    test("draft-patch adds new composition items (O-02-A regression guard)", async () => {
      const n = await alice.call("orders_draft-new", {
        orderNo: "O-103", customerName: "Cust D",
      });
      const id = n.parsed.ID;

      const p = await alice.call("orders_draft-patch", {
        ID: id,
        items: [
          { book_ID: BOOK_A, quantity: 3, price: 9.99 },
        ],
      });
      expect(p.isError).toBeFalsy();

      const act = await alice.call("orders_draft-activate", { ID: id });
      expect(act.isError).toBeFalsy();

      const items = await cds.tx({ user: cds.User.privileged }, (tx) =>
        tx.run(SELECT.from("e2e.OrderItems").where({ parent_ID: id })));
      expect(items.length).toBe(1);
      expect(items[0].quantity).toBe(3);
    });

    test("draft-discard removes the draft", async () => {
      const n = await alice.call("orders_draft-new", {
        orderNo: "O-104", customerName: "Cust E",
      });
      const id = n.parsed.ID;
      const d = await alice.call("orders_draft-discard", { ID: id });
      expect(d.isError).toBeFalsy();
      const g = await alice.call("orders_get", { ID: id, IsActiveEntity: false });
      expect(g.isError).toBe(true);
    });

    test("draft-edit on active row then draft-patch", async () => {
      const n = await alice.call("orders_draft-new", {
        orderNo: "O-105", customerName: "Cust F",
      });
      const id = n.parsed.ID;
      const act = await alice.call("orders_draft-activate", { ID: id });
      expect(act.isError).toBeFalsy();

      const edit = await alice.call("orders_draft-edit", { ID: id });
      expect(edit.isError).toBeFalsy();

      const patch = await alice.call("orders_draft-patch", { ID: id, customerName: "Cust F Updated" });
      expect(patch.isError).toBeFalsy();

      const reActivate = await alice.call("orders_draft-activate", { ID: id });
      expect(reActivate.isError).toBeFalsy();
      expect(reActivate.parsed?.customerName).toBe("Cust F Updated");
    });

    test("active-row delete on draft-enabled root (D-DEL-1)", async () => {
      const n = await alice.call("orders_draft-new", {
        orderNo: "O-106", customerName: "Cust G",
      });
      const id = n.parsed.ID;
      await alice.call("orders_draft-activate", { ID: id });

      const del = await alice.call("orders_delete", { ID: id });
      expect(del.isError).toBeFalsy();

      // Attempting to get should fail after deletion
      const g = await alice.call("orders_get", { ID: id });
      expect(g.isError).toBe(true);
    });

    test("activate without mandatory field yields validation error", async () => {
      const n = await alice.call("orders_draft-new", { orderNo: "O-107" });
      // customerName missing — but draft-new just creates empty/partial row
      expect(n.isError).toBeFalsy();
      const id = n.parsed.ID;
      const act = await alice.call("orders_draft-activate", { ID: id });
      expect(act.isError).toBe(true);
      await alice.call("orders_draft-discard", { ID: id });
    });

    test("cross-user patch on alice's draft is rejected with DRAFT_LOCKED", async () => {
      const n = await alice.call("orders_draft-new", {
        orderNo: "O-108", customerName: "Cust H",
      });
      const id = n.parsed.ID;

      const cross = await carol.call("orders_draft-patch", { ID: id, total: 1.00 });
      expect(cross.isError).toBe(true);
      expect(String(cross.parsed?.error || "")).toMatch(/DRAFT_LOCKED/);

      await alice.call("orders_draft-discard", { ID: id });
    });

    test("draft-upsert (one-shot create) activates row in a single call", async () => {
      const id = "00000000-0000-4000-8000-000000000C01";
      const up = await alice.call("orders_draft-upsert", {
        ID: id, orderNo: "O-109", customerName: "Up C",
      });
      expect(up.isError).toBeFalsy();
      expect(up.parsed?.IsActiveEntity).toBe(true);
      expect(up.parsed?.ID).toBe(id);

      // Subsequent update must use draft-edit → draft-patch → draft-activate
      // (draft-upsert is documented as one-shot create, not re-upsert).
      const edit = await alice.call("orders_draft-edit", { ID: id });
      expect(edit.isError).toBeFalsy();
      const p = await alice.call("orders_draft-patch", { ID: id, customerName: "Up C v2" });
      expect(p.isError).toBeFalsy();
      const reAct = await alice.call("orders_draft-activate", { ID: id });
      expect(reAct.isError).toBeFalsy();
      expect(reAct.parsed?.customerName).toBe("Up C v2");

      await alice.call("orders_delete", { ID: id });
    });

    test("draft-new input schema omits draft-internal fields (D-06)", async () => {
      const r = await alice.listTools();
      const t = r.tools.find((x) => x.name === "orders_draft-new");
      const keys = Object.keys(t?.inputSchema?.properties || {});
      for (const forbidden of [
        "IsActiveEntity", "HasActiveEntity", "HasDraftEntity",
        "SiblingEntity_ID", "DraftAdministrativeData_DraftUUID",
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Action tools (bound + unbound)
  // ---------------------------------------------------------------------------
  describe("action tools", () => {
    test("unbound action (submit-order) happy path", async () => {
      // Use a pre-seeded book with enough stock
      const r = await alice.call("submit-order", { book: BOOK_A, quantity: 1 });
      expect(r.isError).toBeFalsy();
      expect(typeof r.parsed?.stock).toBe("number");
    });

    test("unbound action validation error surfaces", async () => {
      const r = await alice.call("submit-order", { book: BOOK_C, quantity: 9999 });
      expect(r.isError).toBe(true);
      // Error text/payload should surface either the CAP reject message or the plugin wrapper code.
      const combined = String(r.parsed?.error || "") + "|" + String(r.parsed?.message || "") + "|" + String(r.text || "");
      expect(combined).toMatch(/INSUFFICIENT_STOCK|409|OPERATION_FAILED/i);
    });

    test("bound action (revise-stock) happy path", async () => {
      const r = await alice.call("revise-stock", { ID: BOOK_B, delta: 5 });
      expect(r.isError).toBeFalsy();
      expect(r.parsed?.stock).toBe(25);
      // Restore
      await alice.call("revise-stock", { ID: BOOK_B, delta: -5 });
    });

    test("bound action negative-stock guard", async () => {
      const r = await alice.call("revise-stock", { ID: BOOK_B, delta: -9999 });
      expect(r.isError).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Pure resource (resources/read)
  // ---------------------------------------------------------------------------
  describe("pure resource access via resources/read", () => {
    test("can read catalog-books resource and get rows back", async () => {
      // Dynamic resource → construct a concrete URI from the template (use a
      // minimal filter to avoid pulling the whole table).
      const rt = await alice.client.listResourceTemplates();
      const entry = (rt?.resourceTemplates || []).find((x) =>
        /catalog-books/.test(x.uriTemplate || x.uri || ""));
      expect(entry).toBeTruthy();
      const uri = `odata://CatalogService/catalog-books?top=5`;
      const read = await alice.client.readResource({ uri });
      const contents = read?.contents || [];
      expect(contents.length).toBeGreaterThanOrEqual(1);
      const body = contents[0].text || "";
      expect(body).toMatch(/Book [ABC]/);
    });
  });
});
