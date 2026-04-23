"use strict";

/**
 * End-to-end draft-isolation tests over the real MCP protocol.
 *
 * Boots a CAP runtime via `cds.test` with draft-enabled Books/Authors and
 * connects three authenticated MCP clients (alice+carol admins, bob without
 * the admin role) to the Streamable-HTTP endpoint. Scenarios reproduce the
 * class of bug where a second user's draft operation is wrongly reported as
 * "locked by user A" even when the drafts are disjoint. Unlike handler-level
 * tests in test/unit, these traverse the full request path: HTTP → auth
 * middleware → session manager → tool.
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), "cap-mcp-e2e-"));
fs.mkdirSync(path.join(FIXTURE, "db"));
fs.mkdirSync(path.join(FIXTURE, "srv"));

fs.writeFileSync(path.join(FIXTURE, "db/schema.cds"), `
using { cuid, managed } from '@sap/cds/common';
namespace e2e;

entity Authors : cuid, managed {
  name : String @mandatory;
}

entity Books : cuid, managed {
  title  : String @mandatory;
  stock  : Integer;
  author : Association to Authors;
}
`);

fs.writeFileSync(path.join(FIXTURE, "srv/admin.cds"), `
using {e2e} from '../db/schema';

@requires: 'admin'
service AdminService {
  @odata.draft.enabled
  entity Authors as projection on e2e.Authors;
  @odata.draft.enabled
  entity Books as projection on e2e.Books;
}

annotate AdminService.Authors with @mcp: {
  name       : 'admin-authors',
  description: 'Authors',
  resource   : true
};
annotate AdminService.Authors with @mcp.wrap: { tools: true };

annotate AdminService.Books with @mcp: {
  name       : 'admin-books',
  description: 'Books',
  resource   : true
};
annotate AdminService.Books with @mcp.wrap: { tools: true };
`);

fs.writeFileSync(path.join(FIXTURE, "package.json"), JSON.stringify({
  name: "cap-mcp-e2e-fixture",
  private: true,
  dependencies: { "@sap/cds": "^9" },
  cds: {
    requires: {
      db: { kind: "sqlite", credentials: { url: ":memory:" } },
      auth: {
        kind: "mocked",
        users: {
          alice: { password: "alice", roles: ["admin"] },
          carol: { password: "carol", roles: ["admin"] },
          bob:   { password: "bob",   roles: [] },
        },
      },
    },
    mcp: { auth: "inherit", session_store: { kind: "stateless" } },
  },
}));

const cds = require("@sap/cds");
global.cds = cds;
// The temp fixture has no node_modules, so CAP's plugin auto-discovery won't
// find the MCP plugin. Preload it manually — cds-plugin.js registers its
// lifecycle hooks via cds.on(), which fire when cds.test boots the server.
require("../../cds-plugin.js");
const { createMcpClient } = require("./helpers/mcp-client");

// Fixed UUIDs for deterministic seed rows (draft-edit on active references).
const AUTHOR_ID = "00000000-0000-4000-8000-000000000101";
const BOOK_A_ID = "00000000-0000-4000-8000-000000000201";
const BOOK_B_ID = "00000000-0000-4000-8000-000000000207";

describe("E2E: draft isolation over real MCP protocol", () => {
  const T = cds.test(FIXTURE);

  let alice, carol, bob;

  beforeAll(async () => {
    // Seed Authors+Books privileged so active rows exist for draft-edit tests.
    await cds.tx({ user: cds.User.privileged }, async (tx) => {
      await tx.run(INSERT.into("e2e.Authors").entries([{ ID: AUTHOR_ID, name: "Seed Author" }]));
      await tx.run(INSERT.into("e2e.Books").entries([
        { ID: BOOK_A_ID, title: "Seed Book A", stock: 10, author_ID: AUTHOR_ID },
        { ID: BOOK_B_ID, title: "Seed Book B", stock: 20, author_ID: AUTHOR_ID },
      ]));
    });
    alice = await createMcpClient(T.url, "alice");
    carol = await createMcpClient(T.url, "carol");
    bob   = await createMcpClient(T.url, "bob");
  });

  afterAll(async () => {
    await Promise.all([alice?.close(), carol?.close(), bob?.close()].filter(Boolean));
  });

  async function discardAll(sess) {
    const q = await sess.call("admin-books_query", {
      where: [{ field: "IsActiveEntity", op: "eq", value: false }],
      select: ["ID"],
    });
    const rows = !q.parsed ? [] : Array.isArray(q.parsed) ? q.parsed : [q.parsed];
    for (const r of rows) {
      if (r?.ID != null) await sess.call("admin-books_draft-discard", { ID: r.ID });
    }
  }

  beforeEach(async () => {
    await Promise.all([discardAll(alice), discardAll(carol)]);
  });

  test("tools/list exposes draft-* tools for admin-books", async () => {
    const r = await alice.listTools();
    const names = r.tools.map((t) => t.name);
    for (const n of [
      "admin-books_draft-new",
      "admin-books_draft-edit",
      "admin-books_draft-patch",
      "admin-books_draft-activate",
      "admin-books_draft-discard",
      "admin-books_query",
    ]) {
      expect(names).toContain(n);
    }
  });

  test("every draft-* tool description carries the lifecycle hint", async () => {
    const r = await alice.listTools();
    const byName = Object.fromEntries(r.tools.map((t) => [t.name, t]));
    for (const n of [
      "admin-books_draft-new",
      "admin-books_draft-edit",
      "admin-books_draft-patch",
      "admin-books_draft-activate",
      "admin-books_draft-discard",
      "admin-books_draft-upsert",
    ]) {
      expect(byName[n]?.description ?? "").toMatch(/Draft lifecycle:/);
      expect(byName[n]?.description ?? "").toMatch(/only one user can hold a draft/i);
    }
  });

  test("each session carries its own identity (cap_whoami)", async () => {
    const a = await alice.call("cap_whoami");
    const c = await carol.call("cap_whoami");
    expect(a.parsed?.user?.id).toBe("alice");
    expect(c.parsed?.user?.id).toBe("carol");
  });

  test("non-admin (bob) is forbidden from admin tools", async () => {
    const res = await bob.call("admin-books_draft-new", { title: "bob-try", author_ID: AUTHOR_ID });
    expect(res.isError).toBe(true);
  });

  test("tools/list hides admin-* tools from non-admin callers (D-01)", async () => {
    // Regression guard for D-01: before the per-session enable-gate, tools
    // were registered once at startup and auth was checked only at execution
    // time, so bob saw `admin-books_*` in his tool list and would routinely
    // try to call them. Now the SDK's list-tools handler reads tool.enabled
    // as a getter that consults cds.context.user per request.
    const bobTools = await bob.listTools();
    const bobNames = new Set((bobTools?.tools ?? []).map((t) => t.name));
    // Discovery tools must stay visible to everyone — the diagnosis flow
    // depends on them even when every other tool rejects the caller.
    expect(bobNames.has("cap_whoami")).toBe(true);
    expect(bobNames.has("cap_describe_model")).toBe(true);
    // Admin-scoped tools must be filtered out for bob.
    for (const name of bobNames) {
      expect(name.startsWith("admin-")).toBe(false);
    }

    // Alice (admin role) still sees the admin-* surface.
    const aliceTools = await alice.listTools();
    const aliceNames = new Set((aliceTools?.tools ?? []).map((t) => t.name));
    expect(aliceNames.has("admin-books_query")).toBe(true);
    expect(aliceNames.has("admin-books_draft-new")).toBe(true);
  });

  test("bob calling a tool hidden by D-01 is rejected at the protocol layer", async () => {
    // D-01 filters admin-* tools out of bob's tools/list and sets `enabled=false`
    // on the server. The SDK rejects the call before it reaches CAP's
    // @requires:'admin' gate, so the classifier-side 403 path is covered by a
    // unit test (test/unit/error-classifier.test.js). This e2e guards the new
    // user-visible behaviour: a non-admin cannot invoke admin-only tools at all.
    let caught;
    let res;
    try {
      res = await bob.call("admin-books_query", {});
    } catch (err) {
      caught = err;
    }
    // Either path is acceptable: the SDK may throw, or it may return isError:true.
    const msg = caught
      ? String(caught.message ?? caught)
      : String(res?.parsed?.message ?? res?.parsed?.error ?? res?.text ?? "");
    expect(msg).toMatch(/disabled|not found|unknown tool|not available/i);
  });

  test("validation error carries the CAP target/details an OData client would see", async () => {
    // draft-new without the @mandatory `title` field triggers a validation
    // failure. The response must include the raw CAP code and the target
    // field name (structured details, not just a flattened message).
    const res = await alice.call("admin-books_draft-new", { author_ID: AUTHOR_ID });
    const created = await alice.call("admin-books_draft-activate", { ID: res.parsed?.ID });
    expect(created.isError).toBe(true);
    // Accept any validation-family error code — content check is what matters.
    expect(String(created.parsed?.error || "")).toMatch(/ASSERT|VALIDATION|ACTIVATE/);
    // Either capCode or details should carry something structured.
    const hasStructuredDetail = created.parsed?.capCode !== undefined
      || Array.isArray(created.parsed?.details)
      || created.parsed?.target !== undefined;
    expect(hasStructuredDetail).toBe(true);
    // Cleanup
    await alice.call("admin-books_draft-discard", { ID: res.parsed?.ID });
  });

  test("reported bug: two users create disjoint drafts, neither is locked by the other", async () => {
    const [a, c] = await Promise.all([
      alice.call("admin-books_draft-new", { title: "Alice Book", author_ID: AUTHOR_ID }),
      carol.call("admin-books_draft-new", { title: "Carol Book", author_ID: AUTHOR_ID }),
    ]);
    expect(a.isError).toBe(false);
    expect(c.isError).toBe(false);
    expect(typeof a.parsed?.ID).toBe("string");
    expect(typeof c.parsed?.ID).toBe("string");
    expect(a.parsed.ID).not.toBe(c.parsed.ID);

    // Patch each user's own draft — must NOT yield a "locked by" error.
    const [ap, cp] = await Promise.all([
      alice.call("admin-books_draft-patch", { ID: a.parsed.ID, stock: 10 }),
      carol.call("admin-books_draft-patch", { ID: c.parsed.ID, stock: 20 }),
    ]);
    expect(ap.isError).toBe(false);
    expect(cp.isError).toBe(false);
    expect(ap.parsed?.stock).toBe(10);
    expect(cp.parsed?.stock).toBe(20);
  });

  test("cross-user patch on alice's draft ID is rejected with DRAFT_LOCKED naming alice", async () => {
    const a = await alice.call("admin-books_draft-new", { title: "Alice Locked", author_ID: AUTHOR_ID });
    expect(a.isError).toBe(false);
    const aliceId = a.parsed.ID;

    const cross = await carol.call("admin-books_draft-patch", { ID: aliceId, stock: 999 });
    expect(cross.isError).toBe(true);
    expect(cross.parsed?.error).toBe("DRAFT_LOCKED");
    expect(cross.parsed?.message).toMatch(/alice/i);
    expect(cross.parsed?.message).toMatch(/carol/i);
  });

  test("cross-user visibility: each user's query only returns their own drafts", async () => {
    const [a, c] = await Promise.all([
      alice.call("admin-books_draft-new", { title: "A draft", author_ID: AUTHOR_ID }),
      carol.call("admin-books_draft-new", { title: "C draft", author_ID: AUTHOR_ID }),
    ]);
    const aliceId = a.parsed.ID, carolId = c.parsed.ID;

    const [aq, cq] = await Promise.all([
      alice.call("admin-books_query", {
        where: [{ field: "IsActiveEntity", op: "eq", value: false }],
        select: ["ID", "title"],
      }),
      carol.call("admin-books_query", {
        where: [{ field: "IsActiveEntity", op: "eq", value: false }],
        select: ["ID", "title"],
      }),
    ]);
    const aRows = aq.parsed == null ? [] : Array.isArray(aq.parsed) ? aq.parsed : [aq.parsed];
    const cRows = cq.parsed == null ? [] : Array.isArray(cq.parsed) ? cq.parsed : [cq.parsed];
    const aIds = aRows.map((r) => r.ID);
    const cIds = cRows.map((r) => r.ID);

    expect(aIds).toContain(aliceId);
    expect(aIds).not.toContain(carolId);
    expect(cIds).toContain(carolId);
    expect(cIds).not.toContain(aliceId);
  });

  test("full lifecycle per user runs independently", async () => {
    const [aN, cN] = await Promise.all([
      alice.call("admin-books_draft-new", { title: "A life", author_ID: AUTHOR_ID }),
      carol.call("admin-books_draft-new", { title: "C life", author_ID: AUTHOR_ID }),
    ]);
    const aId = aN.parsed.ID, cId = cN.parsed.ID;

    const [aP, cP] = await Promise.all([
      alice.call("admin-books_draft-patch", { ID: aId, stock: 1 }),
      carol.call("admin-books_draft-patch", { ID: cId, stock: 2 }),
    ]);
    expect(aP.isError).toBe(false);
    expect(cP.isError).toBe(false);

    const [aA, cA] = await Promise.all([
      alice.call("admin-books_draft-activate", { ID: aId }),
      carol.call("admin-books_draft-activate", { ID: cId }),
    ]);
    expect(aA.isError).toBe(false);
    expect(cA.isError).toBe(false);
    expect(aA.parsed?.IsActiveEntity).toBe(true);
    expect(cA.parsed?.IsActiveEntity).toBe(true);
  });

  test("draft-edit on same active row: second editor gets clean conflict error", async () => {
    const first = await alice.call("admin-books_draft-edit", { ID: BOOK_A_ID });
    expect(first.isError).toBe(false);

    const second = await carol.call("admin-books_draft-edit", { ID: BOOK_A_ID });
    expect(second.isError).toBe(true);
    // Accept either DRAFT_ALREADY_EXISTS or DRAFT_LOCKED — both are clean rejections.
    expect(String(second.parsed?.error || "")).toMatch(/DRAFT_(ALREADY_EXISTS|LOCKED)/);
  });

  test("draft-edit on disjoint active rows: both succeed concurrently", async () => {
    const [a, c] = await Promise.all([
      alice.call("admin-books_draft-edit", { ID: BOOK_A_ID }),
      carol.call("admin-books_draft-edit", { ID: BOOK_B_ID }),
    ]);
    expect(a.isError).toBe(false);
    expect(c.isError).toBe(false);
    expect(a.parsed?.ID).toBe(BOOK_A_ID);
    expect(c.parsed?.ID).toBe(BOOK_B_ID);
  });

  test("discard isolation: carol cannot discard alice's draft", async () => {
    const a = await alice.call("admin-books_draft-new", { title: "Alice keeps", author_ID: AUTHOR_ID });
    const aliceId = a.parsed.ID;

    const cd = await carol.call("admin-books_draft-discard", { ID: aliceId });
    expect(cd.isError).toBe(true);

    const still = await alice.call("admin-books_query", {
      where: [
        { field: "ID", op: "eq", value: aliceId },
        { field: "IsActiveEntity", op: "eq", value: false },
      ],
    });
    const rows = still.parsed == null ? [] : Array.isArray(still.parsed) ? still.parsed : [still.parsed];
    expect(rows.length).toBe(1);
    expect(rows[0].ID).toBe(aliceId);
  });
});
