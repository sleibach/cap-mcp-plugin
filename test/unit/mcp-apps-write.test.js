"use strict";

/**
 * Write-action tests for MCP Apps templates (Create / Edit / Delete).
 *
 * Simulates the host postMessage bridge the way mcp-apps-protocol.test.js does,
 * but additionally handles tools/call round-trips that the write buttons trigger.
 */

global.cds = { log: () => ({ debug() {}, info() {}, warn() {}, error() {} }), env: { requires: { auth: { kind: "mocked" } } } };

const { buildQueryTemplate, buildDetailTemplate } = require("../../lib/mcp/apps/template-generator");

const META = {
  lineItems: [
    { path: "ID", label: "ID", dataFieldType: "DataField", criticalityPath: null },
    { path: "title", label: "Title", dataFieldType: "DataField", criticalityPath: null },
    { path: "stock", label: "Stock", dataFieldType: "DataField", criticalityPath: null },
  ],
  fieldGroups: {
    G: { label: "General", fields: [{ path: "title" }, { path: "stock" }] },
  },
  dataPoints: {},
  headerInfo: { typeName: "Book", typeNamePlural: "Books", titlePath: "title" },
  headerFacets: [],
  facets: [{ type: "ReferenceFacet", target: "@UI.FieldGroup#G" }],
  identification: [],
  hiddenFields: new Set(),
  hiddenFilterFields: new Set(),
  multiLineFields: new Set(),
  commonText: new Map(),
  lineItemCriticality: null,
};

const WRITE = {
  draft: true,
  create: { tool: "admin-books_draft-upsert" },
  draftUpdate: {
    edit: "admin-books_draft-edit",
    patch: "admin-books_draft-patch",
    activate: "admin-books_draft-activate",
  },
  del: { tool: "admin-books_delete" },
  queryTool: "admin-books_query",
  getTool: "admin-books_get",
  keyFields: [{ name: "ID", type: "number", computed: true }],
  fields: [
    { name: "title", label: "Title", type: "text" },
    { name: "author_ID", label: "Author", type: "number", fk: true },
    { name: "stock", label: "Stock", type: "number" },
  ],
};

function mountTemplate(html, { onToolCall } = {}) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n;\n");
  let contentHTML = "";
  const mkNode = () => ({
    style: {}, children: [], _text: "", _html: "", className: "",
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html; },
    setAttribute() {},
    appendChild(c) { this.children.push(c); },
    addEventListener() {},
    onclick: null,
    disabled: false,
    value: "",
    type: "text",
  });
  const content = { set innerHTML(v) { contentHTML = v; }, get innerHTML() { return contentHTML; }, appendChild() {} };
  const rowInfo = mkNode();
  const elements = { content, "row-info": rowInfo, "obj-actions": mkNode(), "obj-hdr": mkNode(), "obj-title": mkNode(), "obj-subtitle": mkNode(), "obj-img": mkNode(), "dp-strip": mkNode() };
  const posted = [];
  const listeners = [];
  const bodyChildren = [];
  const win = {
    parent: { postMessage: (m) => posted.push(m) },
    addEventListener: (ev, fn) => { if (ev === "message") listeners.push(fn); },
    innerWidth: 800,
    ResizeObserver: function () { this.observe = () => {}; },
  };
  const doc = {
    documentElement: { getBoundingClientRect: () => ({ height: 400 }), setAttribute() {}, getAttribute() { return null; }, style: {} },
    body: {
      appendChild(n) { bodyChildren.push(n); if (n.className === "modal-ov") n._isModal = true; },
      removeChild(n) { const i = bodyChildren.indexOf(n); if (i >= 0) bodyChildren.splice(i, 1); },
      children: bodyChildren,
    },
    createElement: () => mkNode(),
    getElementById: (id) => elements[id] || mkNode(),
  };
  new Function("window", "document", "console", scripts)(win, doc, { error() {}, debug() {}, log() {}, warn() {}, info() {} });

  const hostSend = (m) => listeners.forEach((fn) => fn({ data: m }));

  async function completeHandshake() {
    const init = posted.find((m) => m && m.method === "ui/initialize");
    hostSend({ jsonrpc: "2.0", id: init.id, result: { hostContext: {} } });
    await tick();
  }

  async function deliverToolResult(data) {
    hostSend({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { content: [{ type: "text", text: JSON.stringify(data) }] },
    });
    await tick();
  }

  /** Auto-respond to tools/call requests posted by the app. */
  function autoReplyToolCalls(handler) {
    const origPost = win.parent.postMessage;
    win.parent.postMessage = (m) => {
      posted.push(m);
      if (m && m.method === "tools/call" && m.id !== undefined) {
        Promise.resolve(handler(m.params.name, m.params.arguments)).then((result) => {
          hostSend({ jsonrpc: "2.0", id: m.id, result });
        });
      }
    };
    return () => { win.parent.postMessage = origPost; };
  }

  /** Walk modal DOM tree to find a button by label. */
  function findButton(root, label) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n.textContent === label && typeof n.onclick === "function") return n;
      (n.children || []).forEach((c) => stack.push(c));
    }
    return null;
  }

  function findByClass(root, className) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n.className === className) return n;
      (n.children || []).forEach((c) => stack.push(c));
    }
    return null;
  }

  return {
    posted, hostSend, completeHandshake, deliverToolResult, autoReplyToolCalls, findButton, findByClass,
    get content() { return contentHTML; },
    get modals() { return bodyChildren.filter((n) => n._isModal); },
    doc, win, rowInfo,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("MCP Apps write actions (query template)", () => {
  test("embeds WRITE spec with draft-upsert tool names", () => {
    const html = buildQueryTemplate("Books", META, "Bookshop", WRITE);
    expect(html).toContain('"admin-books_draft-upsert"');
    expect(html).toContain('"admin-books_delete"');
  });

  test("Create button opens modal and calls draft-upsert via host", async () => {
    const html = buildQueryTemplate("Books", META, "Bookshop", WRITE);
    const app = mountTemplate(html);
    const calls = [];
    app.autoReplyToolCalls(async (name, args) => {
      calls.push({ name, args });
      return { isError: false, content: [{ type: "text", text: JSON.stringify({ ID: 999, ...args }) }] };
    });

    await app.completeHandshake();
    await app.deliverToolResult([{ ID: 1, title: "Wuthering Heights", stock: 10, author_ID: 101 }]);

    expect(app.content).toContain("Wuthering Heights");

    // Trigger Create — find button on row-info toolbar
    const createBtn = app.rowInfo.children.find((c) => c.textContent === "Create");
    expect(createBtn).toBeTruthy();
    createBtn.onclick();

    await tick();
    expect(app.modals.length).toBe(1);

    const modal = app.modals[0];
    const saveBtn = app.findButton(modal, "Create");
    expect(saveBtn).toBeTruthy();
    saveBtn.onclick();

    await tick();
    await tick();
    await tick();

    expect(calls.some((c) => c.name === "admin-books_draft-upsert")).toBe(true);
  });

  test("Create keeps modal open when host returns isError", async () => {
    const html = buildQueryTemplate("Books", META, "Bookshop", WRITE);
    const app = mountTemplate(html);
    const calls = [];
    app.autoReplyToolCalls(async (name, args) => {
      calls.push({ name, args });
      return {
        isError: true,
        content: [{ type: "text", text: "ASSERT_MANDATORY author_ID" }],
      };
    });

    await app.completeHandshake();
    await app.deliverToolResult([]);

    const createBtn = app.rowInfo.children.find((c) => c.textContent === "Create");
    createBtn.onclick();
    await tick();
    const modal = app.modals[0];
    const saveBtn = app.findButton(modal, "Create");
    expect(saveBtn).toBeTruthy();
    saveBtn.onclick();
    await tick();
    await tick();
    await tick();

    expect(calls.some((c) => c.name === "admin-books_draft-upsert")).toBe(true);
    expect(app.modals.length).toBe(1);
  });
});

describe("MCP Apps write actions (detail template)", () => {
  test("Edit pre-fills FK fields and runs draft edit → patch → activate", async () => {
    const html = buildDetailTemplate("Books", META, "Bookshop", WRITE);
    const app = mountTemplate(html);
    const calls = [];
    app.autoReplyToolCalls(async (name, args) => {
      calls.push({ name, args });
      return { isError: false, content: [{ type: "text", text: JSON.stringify(args) }] };
    });

    await app.completeHandshake();
    await app.deliverToolResult({ ID: 271, title: "Jane Eyre", author_ID: 107, stock: 12 });

    const actions = app.doc.getElementById("obj-actions");
    const editBtn = actions.children.find((c) => c.textContent === "Edit");
    expect(editBtn).toBeTruthy();
    editBtn.onclick();
    await tick();

    const modal = app.modals[0];
    const saveBtn = app.findButton(modal, "Save");
    expect(saveBtn).toBeTruthy();
    saveBtn.onclick();
    await tick();
    await tick();
    await tick();

    expect(calls.slice(0, 3).map((c) => c.name)).toEqual([
      "admin-books_draft-edit",
      "admin-books_draft-patch",
      "admin-books_draft-activate",
    ]);
    expect(calls[1].args).toMatchObject({ ID: 271, title: "Jane Eyre", author_ID: 107, stock: 12 });
  });

  test("Delete calls delete tool with record keys", async () => {
    const html = buildDetailTemplate("Books", META, "Bookshop", WRITE);
    const app = mountTemplate(html);
    const calls = [];
    app.autoReplyToolCalls(async (name, args) => {
      calls.push({ name, args });
      return { isError: false, content: [{ type: "text", text: "{}" }] };
    });

    await app.completeHandshake();
    await app.deliverToolResult({ ID: 271, title: "Jane Eyre", author_ID: 107, stock: 12 });

    const actions = app.doc.getElementById("obj-actions");
    const delBtn = actions.children.find((c) => c.textContent === "Delete");
    delBtn.onclick();
    await tick();
    await tick();

    expect(calls.some((c) => c.name === "admin-books_delete" && c.args.ID === 271)).toBe(true);
    expect(app.content).toContain("Deleted");
  });
});
