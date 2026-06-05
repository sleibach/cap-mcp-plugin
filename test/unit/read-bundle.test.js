"use strict";

/**
 * Pure-helper unit tests for the read-bundle feature. No CAP runtime — these
 * exercise the grouping/naming/description helpers in isolation with hand-built
 * resource annotations. End-to-end dispatch is covered by
 * read-bundle-integration.test.js.
 */

const cds = require("@sap/cds");
global.cds = cds;

const {
  groupKeyFor,
  resourceIdFor,
  bundleToolName,
  buildReadBundleDescription,
} = require("../../lib/mcp/entity-tools");

function fakeRes(over = {}) {
  return {
    name: over.name,
    description: over.description ?? "",
    serviceName: over.serviceName ?? "AdminService",
    target: over.target ?? "Books",
    resourceKeys: over.resourceKeys ?? new Map([["ID", "cds.Integer"]]),
    properties:
      over.properties ??
      new Map([
        ["ID", "cds.Integer"],
        ["title", "cds.String"],
      ]),
    omittedFields: over.omittedFields ?? new Set(),
    wrap: over.wrap,
    restrictions: over.restrictions,
  };
}

describe("read-bundle helpers", () => {
  test("groupKeyFor: service grouping always uses serviceName", () => {
    const r = fakeRes({ serviceName: "MailService", wrap: { group: "mails" } });
    expect(groupKeyFor(r, { read_bundle: { group_by: "service" } })).toBe(
      "MailService",
    );
  });

  test("groupKeyFor: annotation grouping uses wrap.group, falls back to service", () => {
    const cfg = { read_bundle: { group_by: "annotation" } };
    expect(
      groupKeyFor(fakeRes({ serviceName: "S", wrap: { group: "mails" } }), cfg),
    ).toBe("mails");
    expect(groupKeyFor(fakeRes({ serviceName: "S", wrap: {} }), cfg)).toBe("S");
    expect(groupKeyFor(fakeRes({ serviceName: "S" }), cfg)).toBe("S");
  });

  test("resourceIdFor prefers @mcp.name, falls back to Service_Entity short names", () => {
    expect(resourceIdFor(fakeRes({ name: "admin-books" }))).toBe("admin-books");
    expect(
      resourceIdFor(
        fakeRes({
          name: undefined,
          serviceName: "my.ns.AdminService",
          target: "my.ns.Books",
        }),
      ),
    ).toBe("AdminService_Books");
  });

  test("bundleToolName builds <service>_<suffix>, strips namespace, respects 64-char budget", () => {
    expect(bundleToolName("MailService", "read")).toBe("MailService_read");
    expect(bundleToolName("my.ns.MailService", "read")).toBe("MailService_read");
    expect(bundleToolName("Svc", "browse")).toBe("Svc_browse");
    const long = "X".repeat(80);
    expect(bundleToolName(long, "read").length).toBeLessThanOrEqual(64);
  });

  test("buildReadBundleDescription enumerates resources with keys, modes and hints", () => {
    const members = [
      {
        resAnno: fakeRes({
          name: "admin-books",
          description: "Book catalog.",
          wrap: { hint: { query: "Find books by stock or price" } },
        }),
        readModes: ["query", "get"],
      },
      {
        resAnno: fakeRes({
          name: "admin-authors",
          description: "Authors.",
        }),
        readModes: ["query"],
      },
    ];
    const desc = buildReadBundleDescription("AdminService", members);
    expect(desc).toContain("Consolidated READ access for the AdminService");
    expect(desc).toContain("cap_describe_model");
    expect(desc).toContain("- admin-books — Book catalog. keys: ID. [query, get]");
    expect(desc).toContain("Hint: Find books by stock or price");
    expect(desc).toContain("- admin-authors — Authors. keys: ID. [query]");
  });
});

describe("read-bundle call-time auth gate", () => {
  const realCds = global.cds;
  const captured = new Map();
  const stub = {
    registerTool(name, _meta, handler) {
      captured.set(name, handler);
    },
  };

  beforeAll(() => {
    const { registerReadBundleTool } = require("../../lib/mcp/entity-tools");
    const restricted = fakeRes({
      name: "secret-thing",
      description: "Restricted resource",
      restrictions: [{ role: "admin", operations: [] }],
    });
    registerReadBundleTool(
      "Svc",
      [{ resAnno: restricted, readModes: ["query", "get"] }],
      stub,
      true, // authEnabled
      { read_bundle: { tool_suffix: "read" } },
    );
  });

  afterEach(() => {
    global.cds = realCds;
  });

  test("denies a caller lacking the required role with FORBIDDEN", async () => {
    global.cds = { context: { user: { is: () => false } } };
    const res = await captured.get("Svc_read")({
      resource: "secret-thing",
      mode: "query",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("FORBIDDEN");
  });

  test("does not pre-block when the caller context is not yet available", async () => {
    // No principal to evaluate (e.g. during the MCP initialize request) — the
    // gate must NOT return FORBIDDEN; it proceeds and fails later for an
    // unrelated reason (no service bound in this isolated unit).
    global.cds = { context: undefined, services: {} };
    const res = await captured.get("Svc_read")({
      resource: "secret-thing",
      mode: "query",
    });
    expect(res.content[0].text).not.toContain("FORBIDDEN");
  });
});
