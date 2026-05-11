// Lint: reject migration SQL that nests a single function call too deeply.
//
// bun:sqlite's lemon parser stack overflows at PREPARE time when an
// expression nests too deep, and the limit is platform-dependent — the
// macOS-built compiled CLI binary trips around ~40 levels while Linux can
// go further. Our test matrix only runs on Linux today, so a regression
// won't surface in CI; this lint catches the class of bug structurally
// instead. Cap is 20 (well above any legitimate nested-function call we
// have today, well below the macOS bun:sqlite parser limit).
import { describe, expect, it } from "@effect/vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_FOLDER = join(import.meta.dirname, "../../drizzle");
const MAX_NESTING = 20;

// Walk the SQL char-by-char tracking the call-stack of nested function
// names. A "function call" is any IDENT immediately followed by `(`.
// Returns { fn, depth } for the deepest single-name nest found, or null.
const findDeepestNest = (sql: string) => {
  const stack: string[] = [];
  let worst: { fn: string; depth: number; offset: number } | null = null;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    // Skip line comments
    if (ch === "-" && sql[i + 1] === "-") {
      const eol = sql.indexOf("\n", i);
      i = eol < 0 ? sql.length : eol + 1;
      continue;
    }
    // Skip string literals (single- and double-quoted, backtick identifiers)
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "(") {
      // Walk back to find an IDENT immediately preceding this paren
      let j = i - 1;
      while (j >= 0 && /\s/u.test(sql[j])) j--;
      let end = j;
      while (j >= 0 && /[A-Za-z0-9_]/u.test(sql[j])) j--;
      const name = sql.slice(j + 1, end + 1).toLowerCase();
      stack.push(name || "(");
      // Count consecutive same-name frames in the stack
      let same = 0;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k] === stack[stack.length - 1]) same++;
        else break;
      }
      if (name && (worst === null || same > worst.depth)) {
        worst = { fn: name, depth: same, offset: i };
      }
      i++;
      continue;
    }
    if (ch === ")") {
      stack.pop();
      i++;
      continue;
    }
    i++;
  }
  return worst;
};

describe("drizzle migration SQL structural lint", () => {
  const files = readdirSync(MIGRATIONS_FOLDER)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const f of files) {
    it(`${f} keeps nested-function depth under ${MAX_NESTING}`, () => {
      const sql = readFileSync(join(MIGRATIONS_FOLDER, f), "utf-8");
      const worst = findDeepestNest(sql);
      const summary =
        worst === null
          ? { ok: true as const }
          : {
              ok: worst.depth < MAX_NESTING,
              file: f,
              line: sql.slice(0, worst.offset).split("\n").length,
              fn: worst.fn,
              depth: worst.depth,
            };
      // The expectation is `summary.ok === true`. The full `summary` object is
      // matched (not just `.ok`) so the failure diff prints file/line/fn/depth
      // — bun:sqlite's lemon parser stack overflows on the compiled macOS CLI
      // binary around depth 40, and the project's test matrix is Linux-only,
      // so the diff is the breadcrumb that tells you which migration to
      // refactor (precompute into a temp table à la 0008's __slug_norm, or
      // split the expression into multiple shallow steps).
      expect(summary).toEqual({ ...summary, ok: true });
    });
  }
});
