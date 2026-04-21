"use strict";

/**
 * Unit tests for lib/mcp/expand-parser.js — the hand-rolled OData $expand
 * parser that turns user-supplied strings into CQN column specs. The parser
 * is schema-aware (rejects nav props that don't exist on the CSN entity)
 * and enforces depth/breadth caps. These tests cover both happy paths and
 * the safety net. The parser calls `cds.parse.expr()` indirectly via the
 * filter validator, so we stub that via the same global.cds pattern as
 * `query-result-shape.test.js`.
 */

const stubCds = {
  log: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  env: { requires: { auth: { kind: "mocked" } } },
  parse: { expr: (s) => ({ xpr: [String(s)] }) },
  model: { definitions: {} },
};
global.cds = stubCds;

const { parseExpand, resolveExpand, listExpandableNavigations } = require("../../lib/mcp/expand-parser");

// Minimal CSN fixture: Books → author (Assoc), genre (Assoc),
// reviews (Comp of many), pages (Comp of many → sections)
const modelDefs = {
  "Catalog.Books": {
    elements: {
      ID: { type: "cds.Integer", key: true },
      title: { type: "cds.String" },
      stock: { type: "cds.Integer" },
      author: { type: "cds.Association", target: "Catalog.Authors" },
      genre: { type: "cds.Association", target: "Catalog.Genres" },
      reviews: { type: "cds.Composition", target: "Catalog.Reviews" },
      pages: { type: "cds.Composition", target: "Catalog.Pages" },
    },
  },
  "Catalog.Authors": {
    elements: {
      ID: { type: "cds.Integer", key: true },
      name: { type: "cds.String" },
      email: { type: "cds.String" },
    },
  },
  "Catalog.Genres": {
    elements: {
      ID: { type: "cds.Integer", key: true },
      name: { type: "cds.String" },
      parent: { type: "cds.Association", target: "Catalog.Genres" },
      children: { type: "cds.Composition", target: "Catalog.Genres" },
    },
  },
  "Catalog.Reviews": {
    elements: {
      ID: { type: "cds.Integer", key: true },
      text: { type: "cds.String" },
      rating: { type: "cds.Integer" },
    },
  },
  "Catalog.Pages": {
    elements: {
      ID: { type: "cds.Integer", key: true },
      content: { type: "cds.String" },
      sections: { type: "cds.Composition", target: "Catalog.Sections" },
    },
  },
  "Catalog.Sections": {
    elements: {
      ID: { type: "cds.Integer", key: true },
      heading: { type: "cds.String" },
    },
  },
};

const booksDef = modelDefs["Catalog.Books"];
const genresDef = modelDefs["Catalog.Genres"];

describe("parseExpand — happy path", () => {
  test("single nav prop expands flat", () => {
    const out = parseExpand("author", { entityDef: booksDef, modelDefs });
    expect(out).toEqual([{ ref: ["author"], expand: ["*"] }]);
  });

  test("comma-separated list", () => {
    const out = parseExpand("author,reviews", { entityDef: booksDef, modelDefs });
    expect(out).toEqual([
      { ref: ["author"], expand: ["*"] },
      { ref: ["reviews"], expand: ["*"] },
    ]);
  });

  test("$select inside subquery narrows columns", () => {
    const out = parseExpand("author($select=name)", { entityDef: booksDef, modelDefs });
    expect(out).toEqual([
      { ref: ["author"], expand: [{ ref: ["name"] }] },
    ]);
  });

  test("$top, $skip, $orderby, $filter inside subquery", () => {
    const out = parseExpand(
      "reviews($top=5;$skip=1;$orderby=rating desc;$filter=rating gt 3)",
      { entityDef: booksDef, modelDefs }
    );
    expect(out).toHaveLength(1);
    const col = out[0];
    expect(col.ref).toEqual(["reviews"]);
    expect(col.limit).toEqual({ rows: { val: 5 }, offset: { val: 1 } });
    expect(col.orderBy).toEqual([{ ref: ["rating"], sort: "desc" }]);
    expect(col.where).toBeDefined();
    expect(col.expand).toEqual(["*"]);
  });

  test("nested $expand recurses through the target entity", () => {
    const out = parseExpand(
      "pages($expand=sections)",
      { entityDef: booksDef, modelDefs }
    );
    expect(out).toEqual([
      {
        ref: ["pages"],
        expand: ["*", { ref: ["sections"], expand: ["*"] }],
      },
    ]);
  });

  test("recursive self-composition via Genres.children", () => {
    const out = parseExpand(
      "children($expand=children)",
      { entityDef: genresDef, modelDefs, maxDepth: 3 }
    );
    expect(out).toEqual([
      {
        ref: ["children"],
        expand: ["*", { ref: ["children"], expand: ["*"] }],
      },
    ]);
  });
});

describe("parseExpand — rejections (safety net)", () => {
  test("unknown nav prop is rejected", () => {
    expect(() =>
      parseExpand("notAField", { entityDef: booksDef, modelDefs })
    ).toThrow(/unknown navigation property/);
  });

  test("non-association scalar field is rejected", () => {
    expect(() =>
      parseExpand("title", { entityDef: booksDef, modelDefs })
    ).toThrow(/unknown navigation property/);
  });

  test("unknown option rejected", () => {
    expect(() =>
      parseExpand("author($foo=bar)", { entityDef: booksDef, modelDefs })
    ).toThrow(/unknown option/);
  });

  test("unbalanced parens rejected", () => {
    expect(() =>
      parseExpand("author($select=name", { entityDef: booksDef, modelDefs })
    ).toThrow();
  });

  test("depth cap enforced", () => {
    expect(() =>
      parseExpand(
        "children($expand=children($expand=children($expand=children)))",
        { entityDef: genresDef, modelDefs, maxDepth: 2 }
      )
    ).toThrow(/depth/);
  });

  test("breadth cap enforced", () => {
    expect(() =>
      parseExpand("author,genre,reviews,pages", {
        entityDef: booksDef,
        modelDefs,
        maxBreadth: 2,
      })
    ).toThrow(/breadth/);
  });

  test("$select in subquery rejects unknown column", () => {
    expect(() =>
      parseExpand("author($select=password)", { entityDef: booksDef, modelDefs })
    ).toThrow();
  });

  test("$filter with SQL-injection pattern rejected", () => {
    expect(() =>
      parseExpand("reviews($filter=rating gt 1; DROP TABLE users)", {
        entityDef: booksDef,
        modelDefs,
      })
    ).toThrow();
  });
});

describe("resolveExpand — runtime default policy", () => {
  test("default 'compositions' expands only Compositions", () => {
    const cols = resolveExpand({
      userExpand: undefined,
      defaultMode: "compositions",
      entityDef: booksDef,
      modelDefs,
    });
    const names = cols.map((c) => c.ref[0]).sort();
    expect(names).toEqual(["pages", "reviews"]);
  });

  test("default 'none' expands nothing", () => {
    const cols = resolveExpand({
      userExpand: undefined,
      defaultMode: "none",
      entityDef: booksDef,
      modelDefs,
    });
    expect(cols).toEqual([]);
  });

  test("default 'all' expands Compositions AND Associations", () => {
    const cols = resolveExpand({
      userExpand: undefined,
      defaultMode: "all",
      entityDef: booksDef,
      modelDefs,
    });
    const names = cols.map((c) => c.ref[0]).sort();
    expect(names).toEqual(["author", "genre", "pages", "reviews"]);
  });

  test("empty userExpand ('') opts out of implicit expansion", () => {
    const cols = resolveExpand({
      userExpand: "",
      defaultMode: "compositions",
      entityDef: booksDef,
      modelDefs,
    });
    expect(cols).toEqual([]);
  });

  test("userExpand string overrides default", () => {
    const cols = resolveExpand({
      userExpand: "author",
      defaultMode: "compositions",
      entityDef: booksDef,
      modelDefs,
    });
    expect(cols).toEqual([{ ref: ["author"], expand: ["*"] }]);
  });
});

describe("listExpandableNavigations", () => {
  test("compositions mode lists only Compositions", () => {
    const navs = listExpandableNavigations(booksDef, "compositions");
    expect(navs.map((n) => n.name).sort()).toEqual(["pages", "reviews"]);
  });

  test("all mode lists everything navigable", () => {
    const navs = listExpandableNavigations(booksDef, "all");
    expect(navs.map((n) => n.name).sort()).toEqual(["author", "genre", "pages", "reviews"]);
  });

  test("none mode lists nothing", () => {
    expect(listExpandableNavigations(booksDef, "none")).toEqual([]);
  });
});
