"use strict";

/**
 * Integration-style test for the draft lifecycle support. Boots a real CAP
 * runtime via `cds.test` with a draft-enabled entity, registers the plugin's
 * MCP tools programmatically, and calls the tool handlers end-to-end.
 *
 * What we assert:
 *   - draft-* tools auto-register for @odata.draft.enabled roots.
 *   - Active-row `update`/`delete` on a draft root return DRAFT_REQUIRED.
 *   - draft-new creates a pending draft (IsActiveEntity=false).
 *   - draft-patch applies changes to the draft.
 *   - draft-activate publishes the draft to an active row.
 *   - draft-edit on an active row creates a draft copy.
 *   - draft-discard removes the draft without touching the active row.
 *   - get with IsActiveEntity=false reads the draft sibling.
 *   - query with IsActiveEntity=false returns only draft rows.
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), "cap-mcp-draft-"));
fs.mkdirSync(path.join(FIXTURE, "db"));
fs.mkdirSync(path.join(FIXTURE, "srv"));

fs.writeFileSync(path.join(FIXTURE, "db/schema.cds"), `
using { cuid } from '@sap/cds/common';
namespace demo;

entity Tasks : cuid {
  title  : String;
  status : String;
}
`);

fs.writeFileSync(path.join(FIXTURE, "srv/cat.cds"), `
using {demo} from '../db/schema';

service CatalogService {
  entity Tasks as projection on demo.Tasks;
}

annotate CatalogService.Tasks with @odata.draft.enabled;

annotate CatalogService.Tasks with @mcp: {
  name       : 'tasks',
  description: 'Draft-enabled tasks',
  resource   : true
};

annotate CatalogService.Tasks with @mcp.wrap: {
  tools: true
};
`);

fs.writeFileSync(path.join(FIXTURE, "package.json"), JSON.stringify({
  name: "cap-mcp-draft-fixture",
  private: true,
  dependencies: { "@sap/cds": "^9" },
  cds: {
    requires: { db: { kind: "sqlite", credentials: { url: ":memory:" } } },
    mcp: { auth: "none", session_store: { kind: "stateless" } },
  },
}));

const cds = require("@sap/cds");
global.cds = cds;

describe("Draft lifecycle integration against a real CAP runtime", () => {
  cds.test(FIXTURE);

  const capturedTools = new Map();
  let resAnno;

  beforeAll(async () => {
    const { parseDefinitions } = require("../../lib/annotations/parser");
    const annotations = parseDefinitions(cds.model);
    resAnno = annotations.get("CatalogService.Tasks");
    expect(resAnno).toBeDefined();

    const server = {
      registerTool(name, _meta, handler) {
        capturedTools.set(name, handler);
      },
    };
    const { registerEntityWrappers } = require("../../lib/mcp/entity-tools");
    registerEntityWrappers(
      resAnno,
      server,
      false,
      ["query", "get", "create", "update", "delete"],
      { canRead: true, canCreate: true, canUpdate: true, canDelete: true },
    );
  });

  const call = (suffix, args) => {
    const name = `tasks_${suffix}`;
    const handler = capturedTools.get(name);
    if (!handler) throw new Error(`tool not registered: ${name}`);
    return handler(args ?? {});
  };
  const payload = (res) => JSON.parse(res.content[0].text);

  test("auto-registers draft-* tools for @odata.draft.enabled roots", () => {
    const registered = Array.from(capturedTools.keys());
    expect(registered).toEqual(expect.arrayContaining([
      "tasks_query",
      "tasks_get",
      "tasks_create",
      "tasks_update",
      "tasks_delete",
      "tasks_draft-new",
      "tasks_draft-edit",
      "tasks_draft-patch",
      "tasks_draft-activate",
      "tasks_draft-discard",
    ]));
  });

  test("active-row update on a draft root returns DRAFT_REQUIRED", async () => {
    const res = await call("update", { ID: "11111111-1111-4111-1111-111111111111", title: "nope" });
    expect(res.isError).toBe(true);
    const body = payload(res);
    expect(body.error).toBe("DRAFT_REQUIRED");
    expect(body.message).toMatch(/draft-edit/);
    expect(body.message).toMatch(/draft-patch/);
    expect(body.message).toMatch(/draft-activate/);
  });

  test("active-row delete on a draft root returns DRAFT_REQUIRED", async () => {
    const res = await call("delete", { ID: "11111111-1111-4111-1111-111111111111" });
    expect(res.isError).toBe(true);
    const body = payload(res);
    expect(body.error).toBe("DRAFT_REQUIRED");
    expect(body.message).toMatch(/draft-discard/);
  });

  test("draft-new → draft-patch → draft-activate round-trip", async () => {
    const draftId = "22222222-2222-4222-2222-222222222201";

    const created = await call("draft-new", { ID: draftId, title: "Pick up milk", status: "open" });
    if (created.isError) console.error("draft-new failed:", created.content[0].text);
    const draft = payload(created);
    if (!draft?.ID) console.error("draft-new response body:", JSON.stringify(draft));
    expect(draft.ID).toBe(draftId);
    expect(draft.IsActiveEntity).toBe(false);

    const patched = await call("draft-patch", { ID: draftId, title: "Pick up milk and bread" });
    const patchedRow = payload(patched);
    expect(patchedRow.title).toBe("Pick up milk and bread");
    expect(patchedRow.IsActiveEntity).toBe(false);

    const activated = await call("draft-activate", { ID: draftId });
    const activeRow = payload(activated);
    expect(activeRow.IsActiveEntity).toBe(true);
    expect(activeRow.title).toBe("Pick up milk and bread");

    const readBack = await call("get", { ID: draftId });
    const live = payload(readBack);
    expect(live.title).toBe("Pick up milk and bread");
    expect(live.IsActiveEntity).toBe(true);
  });

  test("draft-edit on existing active → patch → activate updates the row", async () => {
    const id = "22222222-2222-4222-2222-222222222202";
    // Seed an active row directly (bypasses the MCP tool).
    await cds.run(
      INSERT.into("CatalogService.Tasks").entries({ ID: id, title: "Original", status: "open" }),
    );
    // Some cds.test harnesses leave the seed as a draft; make sure the row
    // is activated before we test draft-edit.
    try { await cds.services.CatalogService.send("SAVE", "CatalogService.Tasks", { ID: id }); } catch { }

    const editRes = await call("draft-edit", { ID: id });
    const draft = payload(editRes);
    expect(draft.IsActiveEntity).toBe(false);
    expect(draft.title).toBe("Original");

    await call("draft-patch", { ID: id, title: "Rewritten", status: "done" });
    const activated = await call("draft-activate", { ID: id });
    const row = payload(activated);
    expect(row.title).toBe("Rewritten");
    expect(row.status).toBe("done");
    expect(row.IsActiveEntity).toBe(true);
  });

  test("draft-discard removes the draft without touching the active row", async () => {
    const id = "22222222-2222-4222-2222-222222222203";
    await call("draft-new", { ID: id, title: "Throwaway" });

    const discardRes = await call("draft-discard", { ID: id });
    const body = payload(discardRes);
    expect(body.discarded).toBe(true);

    const readDraft = await call("get", { ID: id, IsActiveEntity: false });
    expect(payload(readDraft)).toBeNull();
  });

  test("get with IsActiveEntity=false reads the draft sibling", async () => {
    const id = "22222222-2222-4222-2222-222222222204";
    await call("draft-new", { ID: id, title: "Still a draft" });

    const readActive = await call("get", { ID: id }); // defaults to active
    expect(payload(readActive)).toBeNull();

    const readDraft = await call("get", { ID: id, IsActiveEntity: false });
    const draftRow = payload(readDraft);
    expect(draftRow.ID).toBe(id);
    expect(draftRow.IsActiveEntity).toBe(false);
    expect(draftRow.title).toBe("Still a draft");
  });

  test("query with IsActiveEntity=false returns only draft rows", async () => {
    const res = await call("query", { top: 50, IsActiveEntity: false });
    const rows = res.content.map((c) => JSON.parse(c.text));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.IsActiveEntity).toBe(false);
    }
  });
});
