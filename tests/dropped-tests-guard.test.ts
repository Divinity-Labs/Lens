/**
 * Unit tests for scripts/check-dropped-tests.mjs regex logic.
 * We extract the CASE regex and testFilesAt filtering logic inline here
 * since the script runs as an ESM CLI, not an importable module.
 */
import { describe, it, expect } from "vitest";

// Mirrored from scripts/check-dropped-tests.mjs
const CASE = /^\s*(?:it|test)(?:\.\w+)*\s*(?:\(|`)\s*(['"`])(.*?)\1/gm;

function extractCases(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(CASE)) {
    names.push(m[2]);
  }
  return names;
}

describe("check-dropped-tests CASE regex", () => {
  it("matches it('name', ...)", () => {
    expect(extractCases(`  it('adds numbers', () => {})`)).toEqual(["adds numbers"]);
  });

  it("matches test(\"name\")", () => {
    expect(extractCases(`test("handles null input")`)).toEqual(["handles null input"]);
  });

  it("matches it.each variant", () => {
    const src = `it.each([[1,2],[3,4]])('adds %i and %i', (a,b) => {})`;
    const cases = extractCases(src);
    expect(cases.length).toBe(1);
    expect(cases[0]).toContain("adds");
  });

  it("matches it.only and it.skip", () => {
    const src = `it.only('focused test', () => {})\nit.skip('skipped test', () => {})`;
    expect(extractCases(src)).toEqual(["focused test", "skipped test"]);
  });

  it("matches backtick template name without interpolation", () => {
    expect(extractCases("  it(`backtick name`, () => {})")).toEqual(["backtick name"]);
  });

  it("does NOT match function declarations", () => {
    expect(extractCases(`function itDoesNotMatch() {}\nconst testHelper = 1;`)).toEqual([]);
  });

  it("detects removal: base has case, head does not", () => {
    const base = `it('case A', fn)\nit('case B', fn)`;
    const head = `it('case A', fn)\nit('case C', fn)`;
    const baseNames = new Set(extractCases(base));
    const headNames = new Set(extractCases(head));
    const dropped = [...baseNames].filter((n) => !headNames.has(n));
    expect(dropped).toEqual(["case B"]);
  });

  it("no false positive when nothing removed", () => {
    const same = `it('X', fn)\nit('Y', fn)`;
    const baseN = new Set(extractCases(same));
    const headN = new Set(extractCases(same));
    const dropped = [...baseN].filter((n) => !headN.has(n));
    expect(dropped).toEqual([]);
  });
});

describe("test file detection pattern", () => {
  const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

  it("matches .test.ts, .spec.js, .test.mjs", () => {
    expect(TEST_FILE_RE.test("src/foo.test.ts")).toBe(true);
    expect(TEST_FILE_RE.test("tests/bar.spec.js")).toBe(true);
    expect(TEST_FILE_RE.test("lib/x.test.mjs")).toBe(true);
    expect(TEST_FILE_RE.test("y.spec.jsx")).toBe(true);
  });

  it("rejects non-test files", () => {
    expect(TEST_FILE_RE.test("src/index.ts")).toBe(false);
    expect(TEST_FILE_RE.test("README.md")).toBe(false);
    expect(TEST_FILE_RE.test("testing.ts")).toBe(false);
  });
});
