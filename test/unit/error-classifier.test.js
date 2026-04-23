"use strict";

/**
 * Regression guard for classifyCapError's 403 branch.
 *
 * CAP's service-level @requires gate throws a bare Error{code:403}; the plugin
 * must surface this as FORBIDDEN with principal/role context so MCP clients
 * don't see a generic QUERY_FAILED: Error. Previously covered end-to-end
 * (test/e2e/draft-isolation.test.js), but D-01 now hides admin-only tools
 * from non-admins, making the e2e path unreachable. The classifier logic
 * itself still runs whenever CAP raises 403 on a tool visible to the caller
 * (e.g. attribute-based @restrict), so we exercise it here directly.
 */

const stubCds = {
  log: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  env: { requires: { auth: { kind: "mocked" } } },
  User: { privileged: {}, anonymous: {} },
  services: {},
  context: { user: { id: "bob", roles: ["ExtensionDeveloper"] } },
  ql: {},
  parse: { expr: () => ({}) },
};
global.cds = stubCds;

const { classifyCapError } = require("../../lib/mcp/entity-tools");

describe("classifyCapError — 403 FORBIDDEN branch", () => {
  test("bare Error{code:403} becomes FORBIDDEN with principal + role context", () => {
    const err = Object.assign(new Error("Error"), { code: 403 });
    const result = classifyCapError(err, "QUERY_FAILED", "admin-books_query");
    expect(result.code).toBe("FORBIDDEN");
    expect(result.msg).toMatch(/403/);
    expect(result.msg).toMatch(/bob/);
    expect(result.msg).toMatch(/ExtensionDeveloper/);
    expect(result.msg).toMatch(/@requires|@restrict|permission|access/i);
    expect(result.msg).not.toMatch(/QUERY_FAILED:\s*QUERY_FAILED/);
    expect(result.msg).not.toMatch(/:\s*Error(\s|$)/);
    expect(result.extra?.capCode).toBe(403);
    expect(result.extra?.httpStatus).toBe(403);
  });

  test("401 becomes UNAUTHORIZED, not FORBIDDEN", () => {
    const err = Object.assign(new Error("no auth"), { code: 401 });
    const result = classifyCapError(err, "QUERY_FAILED", "some-tool");
    expect(result.code).toBe("UNAUTHORIZED");
    expect(result.msg).toMatch(/401/);
  });

  test("unknown-role user still gets a sane FORBIDDEN message", () => {
    global.cds.context = { user: undefined };
    try {
      const err = Object.assign(new Error("Error"), { code: 403 });
      const result = classifyCapError(err, "QUERY_FAILED", "some-tool");
      expect(result.code).toBe("FORBIDDEN");
      expect(result.msg).toMatch(/<unknown>/);
    } finally {
      global.cds.context = { user: { id: "bob", roles: ["ExtensionDeveloper"] } };
    }
  });
});
