"use strict";

/**
 * Protocol-level tests for the MCP Apps HTML templates.
 *
 * These run the template's inlined bootstrap script in a minimal fake-DOM that
 * mimics browser semantics (all <script> tags share one global scope; the host
 * communicates via STRUCTURED-OBJECT postMessage) and assert the exact wire
 * behaviour the host's PostMessageTransport requires:
 *   - messages are posted as objects (not JSON strings)
 *   - ui/initialize handshake completes → ui/notifications/initialized
 *   - tool-result data is read from params.content[0].text (NOT params.result)
 *   - the iframe reports its height via ui/notifications/size-changed
 *   - tool-result arriving before the handshake is buffered and replayed
 *
 * A regression on any of these renders a BLANK iframe in Claude Desktop, which
 * is exactly the failure these tests guard against.
 */

global.cds = { log: () => ({ debug() {}, info() {}, warn() {}, error() {} }), env: { requires: { auth: { kind: "mocked" } } } };

const { buildQueryTemplate } = require("../../lib/mcp/apps/template-generator");

const META = {
    lineItems: [
        { path: "ID", label: "ID", dataFieldType: "DataField", criticalityPath: null },
        { path: "name", label: "Name", dataFieldType: "DataField", criticalityPath: null },
    ],
    fieldGroups: {}, dataPoints: {}, headerInfo: { typeNamePlural: "Authors" },
    headerFacets: [], facets: [], identification: [], selectionFields: [],
    hiddenFields: new Set(), hiddenFilterFields: new Set(), multiLineFields: new Set(),
    commonText: new Map(), lineItemCriticality: null,
};

/**
 * Instantiates the template's scripts in a fake DOM. Returns helpers to drive
 * the host side and inspect what the app posted / rendered.
 */
function mountTemplate(html) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n;\n");
    let contentHTML = "";
    const elements = {
        content: { set innerHTML(v) { contentHTML = v; }, get innerHTML() { return contentHTML; } },
        "row-info": { textContent: "" },
    };
    const posted = [];
    const listeners = [];
    const win = {
        parent: { postMessage: (m) => posted.push(m) },
        addEventListener: (ev, fn) => { if (ev === "message") listeners.push(fn); },
        innerWidth: 600,
        ResizeObserver: function () { this.observe = () => {}; },
    };
    const doc = {
        documentElement: { getBoundingClientRect: () => ({ height: 240 }), setAttribute() {}, style: {} },
        getElementById: (id) => elements[id] || { set innerHTML(v) {}, style: {}, textContent: "" },
    };
    new Function("window", "document", "console", scripts)(win, doc, { error() {}, debug() {}, log() {} });
    return {
        posted,
        hostSend: (m) => listeners.forEach((fn) => fn({ data: m })),
        get content() { return contentHTML; },
    };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("app posts ui/initialize as a structured object (not a JSON string)", () => {
    const app = mountTemplate(buildQueryTemplate("Authors", META));
    const init = app.posted.find((m) => m && m.method === "ui/initialize");
    expect(init).toBeTruthy();
    expect(typeof init).toBe("object"); // NOT a string
    expect(init.params.protocolVersion).toBe("2026-01-26");
});

test("completes handshake and renders tool-result data", async () => {
    const app = mountTemplate(buildQueryTemplate("Authors", META));
    const init = app.posted.find((m) => m.method === "ui/initialize");
    app.hostSend({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2026-01-26", hostContext: { theme: "dark" } } });
    await tick();
    expect(app.posted.some((m) => m.method === "ui/notifications/initialized")).toBe(true);

    app.hostSend({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { content: [{ type: "text", text: JSON.stringify([{ ID: 1, name: "Emily" }, { ID: 2, name: "Charlotte" }]) }] },
    });
    await tick();
    expect(app.content).toContain("Emily");
    expect(app.content).toContain("Charlotte");
    expect(app.content).toContain("<table>");
});

test("emits ui/notifications/size-changed so the host can size the iframe", async () => {
    const app = mountTemplate(buildQueryTemplate("Authors", META));
    const init = app.posted.find((m) => m.method === "ui/initialize");
    app.hostSend({ jsonrpc: "2.0", id: init.id, result: { hostContext: {} } });
    await tick();
    const sizes = app.posted.filter((m) => m.method === "ui/notifications/size-changed");
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes[sizes.length - 1].params.height).toBeGreaterThan(0);
});

test("buffers tool-result that arrives before the handshake completes", async () => {
    const app = mountTemplate(buildQueryTemplate("Authors", META));
    // Host pushes data BEFORE responding to ui/initialize
    app.hostSend({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { content: [{ type: "text", text: JSON.stringify([{ ID: 9, name: "Poe" }]) }] },
    });
    await tick();
    expect(app.content).not.toContain("Poe"); // buffered, not yet rendered

    const init = app.posted.find((m) => m.method === "ui/initialize");
    app.hostSend({ jsonrpc: "2.0", id: init.id, result: { hostContext: {} } });
    await tick();
    expect(app.content).toContain("Poe"); // replayed after handshake
});

test("ignores stringified / non-JSON-RPC messages without throwing", async () => {
    const app = mountTemplate(buildQueryTemplate("Authors", META));
    expect(() => {
        app.hostSend({ data: "garbage" });
        app.hostSend("not-an-object");
        app.hostSend({ foo: "bar" }); // no jsonrpc
    }).not.toThrow();
});
