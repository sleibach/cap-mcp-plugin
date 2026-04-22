"use strict";

/**
 * Enterprise-grade draft integration tests. Exercises shapes that the
 * bookshop-style draft-integration fixture doesn't cover:
 *
 *   - composite-key associations (one FK column per target key)
 *   - @mandatory enforcement at draft-activate (deferred, not on NEW)
 *   - auth-scoped draft locking (alice holds, bob's patch is rejected)
 *   - structured / prefix-flattened elements (`address_street`, `address_city`)
 *   - @mcp.wrap.modes regression — draft-* tools still auto-register
 *
 * Fixture runs with `cds.requires.auth: 'mocked'`, so calls wrapped in
 * `cds.tx({user: new cds.User("alice")}, …)` emulate the real auth
 * middleware populating `cds.context.user` per request.
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), "cap-mcp-draft-maturity-"));
fs.mkdirSync(path.join(FIXTURE, "db"));
fs.mkdirSync(path.join(FIXTURE, "srv"));

fs.writeFileSync(path.join(FIXTURE, "db/schema.cds"), `
using { cuid } from '@sap/cds/common';
namespace demo;

// Composite key — mimics EAM's TechnicalObject(TechnicalObject, ObjectType).
entity Customers {
  key Customer : String(10);
  key Region   : String(2);
  name         : String;
}

entity Orders : cuid {
  title    : String;
  // Composite-key association — CAP emits TWO generated FK columns
  // (customer_Customer + customer_Region). Draft handlers must address both.
  customer : Association to Customers;
  // @mandatory scalar — CAP allows partial drafts but enforces on activate.
  priority : String @mandatory;
  // Inline structured element — CSN flattens to address_street / address_city.
  address  : {
    street : String;
    city   : String;
  };
  // Temporal fields — exercise the wire-format coercion: callers may pass
  // ISO datetime strings, epoch numbers, or Date instances.
  dueDate     : Date;
  sentAt      : DateTime;
  recordedAt  : Timestamp;
}
`);

fs.writeFileSync(path.join(FIXTURE, "srv/cat.cds"), `
using {demo} from '../db/schema';

service CatalogService {
  entity Customers as projection on demo.Customers;
  entity Orders    as projection on demo.Orders;
}

annotate CatalogService.Orders with @odata.draft.enabled;

annotate CatalogService.Orders with @mcp: {
  name       : 'orders',
  description: 'Draft-enabled orders with composite-key customer FK',
  resource   : true
};

// Caller declares explicit CRUD modes without draft-* — plugin must still
// auto-register the draft lifecycle tools (regression on the mid-session fix).
annotate CatalogService.Orders with @mcp.wrap: {
  tools: true,
  modes: ['query', 'get', 'create', 'update']
};

annotate CatalogService.Customers with @mcp: {
  name       : 'customers',
  description: 'Customer lookup (composite key)',
  resource   : true
};
annotate CatalogService.Customers with @mcp.wrap: {
  tools: true,
  modes: ['query', 'get', 'create']
};
`);

fs.writeFileSync(path.join(FIXTURE, "package.json"), JSON.stringify({
  name: "cap-mcp-draft-maturity-fixture",
  private: true,
  dependencies: { "@sap/cds": "^9" },
  cds: {
    requires: {
      db: { kind: "sqlite", credentials: { url: ":memory:" } },
      auth: {
        kind: "mocked",
        users: {
          alice: { password: "alice" },
          bob: { password: "bob" },
        },
      },
    },
    mcp: { session_store: { kind: "stateless" } },
  },
}));

const cds = require("@sap/cds");
global.cds = cds;

describe("Draft lifecycle — enterprise-grade hardening", () => {
  cds.test(FIXTURE);

  const capturedTools = new Map();

  beforeAll(async () => {
    const { parseDefinitions } = require("../../lib/annotations/parser");
    const annotations = parseDefinitions(cds.model);
    const { registerEntityWrappers } = require("../../lib/mcp/entity-tools");

    const server = {
      registerTool(name, _meta, handler) {
        capturedTools.set(name, handler);
      },
    };

    for (const target of ["CatalogService.Orders", "CatalogService.Customers"]) {
      const resAnno = annotations.get(target);
      expect(resAnno).toBeDefined();
      registerEntityWrappers(
        resAnno,
        server,
        true, // authEnabled — forces handlers to use cds.context.user
        ["query", "get", "create", "update", "delete"],
        { canRead: true, canCreate: true, canUpdate: true, canDelete: true },
      );
    }

    // Seed a Customers row for composite-FK activation scenarios.
    await cds.tx({ user: cds.User.privileged }, (tx) =>
      tx.run(
        INSERT.into("CatalogService.Customers").entries({
          Customer: "C100",
          Region: "DE",
          name: "Globex DE",
        }),
      ),
    );
  });

  const call = (name, args, user) => {
    const handler = capturedTools.get(name);
    if (!handler) throw new Error(`tool not registered: ${name}`);
    const fn = () => handler(args ?? {});
    if (!user) return fn();
    return cds.tx({ user: new cds.User(user) }, fn);
  };
  const payload = (res) => JSON.parse(res.content[0].text);

  test("explicit @mcp.wrap.modes without draft-* still auto-registers draft tools", () => {
    const registered = Array.from(capturedTools.keys());
    expect(registered).toEqual(expect.arrayContaining([
      "orders_query",
      "orders_get",
      "orders_create",
      "orders_update",
      "orders_draft-new",
      "orders_draft-edit",
      "orders_draft-patch",
      "orders_draft-activate",
      "orders_draft-discard",
      "orders_draft-upsert",
    ]));
    expect(registered).not.toContain("orders_delete");
  });

  test("draft-upsert: NEW+SAVE in one tx — no cross-call lock, immediate active row", async () => {
    const ID = "aaaaaaaa-0001-4000-8000-000000000010";
    const activated = await call("orders_draft-upsert", {
      ID,
      title: "Upsert one-shot",
      priority: "high",
      customer_Customer: "C100",
      customer_Region: "DE",
      address_street: "Main 2",
      address_city: "Dortmund",
    }, "alice");
    if (activated.isError) console.error("draft-upsert failed:", activated.content[0].text);
    expect(activated.isError).toBeFalsy();
    const row = payload(activated);
    expect(row.IsActiveEntity).toBe(true);
    expect(row.customer_Customer).toBe("C100");
    expect(row.customer_Region).toBe("DE");
  });

  test("draft-upsert: @mandatory missing → DRAFT_UPSERT_FAILED, no orphan draft left behind", async () => {
    const ID = "aaaaaaaa-0001-4000-8000-000000000011";
    const res = await call("orders_draft-upsert", {
      ID,
      title: "Upsert missing priority",
    }, "alice");
    expect(res.isError).toBe(true);
    const err = payload(res);
    expect(err.error).toBe("DRAFT_UPSERT_FAILED");
    expect(err.message.toLowerCase()).toMatch(/priority/);
    // Rollback check: no draft row should linger under this key.
    const check = await call("orders_get", { ID, IsActiveEntity: false }, "alice");
    // get may return "not found" or an empty array depending on the path —
    // either way the row must NOT exist as a pending draft.
    if (!check.isError) {
      const body = payload(check);
      expect(body).toBeFalsy();
    }
  });

  test("composite-FK happy path: both FK columns supplied → draft-activate succeeds", async () => {
    const ID = "aaaaaaaa-0001-4000-8000-000000000001";
    const created = await call("orders_draft-new", {
      ID,
      title: "Composite FK order",
      priority: "high",
      customer_Customer: "C100",
      customer_Region: "DE",
      address_street: "Main 1",
      address_city: "Dortmund",
    }, "alice");
    if (created.isError) console.error("draft-new failed:", created.content[0].text);
    const draft = payload(created);
    expect(draft.customer_Customer).toBe("C100");
    expect(draft.customer_Region).toBe("DE");
    expect(draft.address_street).toBe("Main 1");
    expect(draft.address_city).toBe("Dortmund");
    expect(draft.IsActiveEntity).toBe(false);

    const activated = await call("orders_draft-activate", { ID }, "alice");
    if (activated.isError) console.error("draft-activate failed:", activated.content[0].text);
    const row = payload(activated);
    expect(row.IsActiveEntity).toBe(true);
    expect(row.customer_Customer).toBe("C100");
    expect(row.customer_Region).toBe("DE");
  });

  test("@mandatory is deferred: draft lands without priority, activate rejects", async () => {
    const ID = "aaaaaaaa-0001-4000-8000-000000000002";
    const created = await call("orders_draft-new", {
      ID,
      title: "Missing priority",
      customer_Customer: "C100",
      customer_Region: "DE",
    }, "alice");
    expect(created.isError).toBeFalsy();
    const draft = payload(created);
    expect(draft.IsActiveEntity).toBe(false);

    const activated = await call("orders_draft-activate", { ID }, "alice");
    expect(activated.isError).toBe(true);
    const err = payload(activated);
    // Either DRAFT_ACTIVATE_FAILED or DRAFT_VALIDATION_FAILED is acceptable —
    // CAP surfaces @mandatory as an ASSERT_NOT_NULL on SAVE, classified into
    // the activate-scoped code. The message must name the offending field.
    expect(["DRAFT_ACTIVATE_FAILED", "DRAFT_VALIDATION_FAILED"]).toContain(err.error);
    expect(err.message.toLowerCase()).toMatch(/priority/);
  });

  test("auth lock holder: alice holds draft, bob's patch is rejected", async () => {
    const ID = "aaaaaaaa-0001-4000-8000-000000000003";
    const created = await call("orders_draft-new", {
      ID,
      title: "Alice's draft",
      priority: "high",
    }, "alice");
    expect(created.isError).toBeFalsy();

    const patched = await call("orders_draft-patch", {
      ID,
      title: "Bob tries to edit",
    }, "bob");
    expect(patched.isError).toBe(true);
    const err = payload(patched);
    expect(err.error).toBe("DRAFT_LOCKED");
    // Message must identify BOTH the holder and the current principal so the
    // on-call can tell which identity the plugin is actually running as.
    expect(err.message).toMatch(/held by alice/);
    expect(err.message).toMatch(/you are 'bob'/);
    expect(err.message).toMatch(/Root cause: the lock holder and the current MCP principal are different identities/);
    // Alice must clean up so other tests don't inherit her lock.
    await call("orders_draft-discard", { ID }, "alice");
  });

  test("same user continues their own draft across calls", async () => {
    const ID = "aaaaaaaa-0001-4000-8000-000000000004";
    await call("orders_draft-new", {
      ID,
      title: "Same-user session",
      priority: "low",
    }, "alice");
    const patched = await call("orders_draft-patch", {
      ID,
      title: "Same-user continued",
    }, "alice");
    expect(patched.isError).toBeFalsy();
    expect(payload(patched).title).toBe("Same-user continued");
    await call("orders_draft-discard", { ID }, "alice");
  });

  test("structured element exposed as flat _street/_city args", async () => {
    const ID = "aaaaaaaa-0001-4000-8000-000000000005";
    const created = await call("orders_draft-new", {
      ID,
      title: "Address draft",
      priority: "high",
      address_street: "Königsallee 11",
      address_city: "Düsseldorf",
    }, "alice");
    expect(created.isError).toBeFalsy();
    const draft = payload(created);
    expect(draft.address_street).toBe("Königsallee 11");
    expect(draft.address_city).toBe("Düsseldorf");
    await call("orders_draft-discard", { ID }, "alice");
  });

  test("Date field accepts ISO datetime string and normalises to YYYY-MM-DD", async () => {
    const ID = "aaaaaaaa-0001-4000-8000-000000000007";
    // This is the EAM-class failure: agent passes "2026-05-31T00:00:00Z"
    // (a DateTime-ish ISO string) for a Date-typed field. Previously we
    // fed CAP a Date object which it rejected with ASSERT_DATA_TYPE; now
    // we normalise to "YYYY-MM-DD" before handing off to the draft pipeline.
    const created = await call("orders_draft-new", {
      ID,
      title: "Temporal draft",
      priority: "high",
      dueDate: "2026-05-31T00:00:00Z",
      sentAt: "2026-05-31T12:34:56Z",
      recordedAt: 1_748_649_296_000,
    }, "alice");
    if (created.isError) console.error("temporal draft-new failed:", created.content[0].text);
    expect(created.isError).toBeFalsy();
    const draft = payload(created);
    expect(draft.dueDate).toBe("2026-05-31");
    // CAP may round-trip DateTime / Timestamp as ISO strings — sanity-check
    // the shape rather than exact formatting.
    expect(typeof draft.sentAt).toBe("string");
    expect(draft.sentAt).toMatch(/^2026-05-31T/);
    expect(typeof draft.recordedAt).toBe("string");
    await call("orders_draft-discard", { ID }, "alice");
  });

  test("active-row create on draft root short-circuits with DRAFT_REQUIRED", async () => {
    const res = await call("orders_create", {
      ID: "aaaaaaaa-0001-4000-8000-000000000006",
      title: "Active create — should fail",
      priority: "high",
    }, "alice");
    expect(res.isError).toBe(true);
    const err = payload(res);
    expect(err.error).toBe("DRAFT_REQUIRED");
    expect(err.message).toMatch(/draft-new/);
  });
});
