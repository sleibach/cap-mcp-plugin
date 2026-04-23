"use strict";

/**
 * Regression tests for bugs reported on 2026-04-20:
 *   1. `response?.map is not a function` when return:"count" (entity-tools.js)
 *   2. explain:true returned plan: undefined
 *
 * These tests stub `@sap/cds` before requiring the module so we can exercise
 * the result-shaping logic without spinning up a real CAP runtime. The real
 * integration coverage lives under test/bookshop-*.
 */

// Minimal cds stub: just enough surface area for entity-tools.js and its
// transitive requires (zod, logger, config).
const stubCds = {
  log: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  env: { requires: { auth: { kind: "mocked" } } },
  User: { privileged: {}, anonymous: {} },
  services: {},
  ql: {
    SELECT: {
      from() { return this; },
      columns() { return this; },
      where() { return this; },
      orderBy() { return this; },
      limit() { return this; },
    },
  },
  parse: { expr: () => ({}) },
};
global.cds = stubCds;

const { applyOmissionFilter, asMcpResult } = require("../../lib/mcp/utils");

/**
 * Mimics the post-executeQuery shaping logic inside registerQueryTool. Kept
 * in sync with lib/mcp/entity-tools.js lines around the `Array.isArray`
 * branch + `args.explain` plan wrapping. If that logic diverges, update
 * this helper AND the test to catch it.
 */
function shapeResult(response, resAnno, args, q) {
  const result = Array.isArray(response)
    ? response.map((obj) => applyOmissionFilter(obj, resAnno))
    : response;
  if (args.explain) {
    return asMcpResult({
      data: result,
      plan: {
        mode: args.return ?? "rows",
        cqn: q?.SELECT ? { SELECT: q.SELECT } : q,
      },
    });
  }
  return asMcpResult(result);
}

describe("query handler result shape", () => {
  const resAnno = { omittedFields: new Set() };

  test("count response (scalar object) is not iterated with .map()", () => {
    const response = { count: 42 };
    // Before the fix this threw `response?.map is not a function`.
    expect(() => shapeResult(response, resAnno, { return: "count" })).not.toThrow();
    const res = shapeResult(response, resAnno, { return: "count" });
    expect(res.content[0].text).toContain('"count": 42');
  });

  test("rows response is iterated and omission-filtered", () => {
    const response = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
    const anno = { omittedFields: new Set(["b"]) };
    const res = shapeResult(response, anno, { return: "rows" });
    // Text is pretty-printed JSON; check b is stripped.
    expect(res.content[0].text).not.toMatch(/"b":/);
    expect(res.content[0].text).toMatch(/"a": 1/);
  });

  // Regression guard for D-04. Before the fix, each row of an array payload
  // became its own `{type:"text", text:...}` content part — the MCP SDK then
  // concatenated them with newlines, so the agent received
  // `{...}\n{...}\n...` which is not valid JSON. Callers could not
  // `JSON.parse` the body. The new shape is a single content part whose text
  // is the whole array, which parses cleanly into a JS array.
  test("array payload serialises as a single JSON-array content part", () => {
    const response = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const res = asMcpResult(response);
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe("text");
    const parsed = JSON.parse(res.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(response);
  });

  test("empty array payload still produces a parseable single content part", () => {
    const res = asMcpResult([]);
    expect(res.content).toHaveLength(1);
    expect(JSON.parse(res.content[0].text)).toEqual([]);
  });

  test("explain:true populates plan with mode + cqn", () => {
    const q = { SELECT: { from: { ref: ["Books"] } } };
    const res = shapeResult([{ id: 1 }], resAnno, { explain: true, return: "rows" }, q);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.plan).toBeDefined();
    expect(payload.plan.mode).toBe("rows");
    expect(payload.plan.cqn).toEqual({ SELECT: { from: { ref: ["Books"] } } });
    expect(payload.data).toEqual([{ id: 1 }]);
  });
});
