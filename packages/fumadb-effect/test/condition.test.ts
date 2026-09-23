/**
 * The condition builder (`src/query/condition.ts`, upstream
 * `src/query/condition-builder.ts`).
 *
 * The folding rules matter to every adapter: `and()` of nothing is `true`,
 * `or()` of nothing is `false`, a `true` short-circuits `or`, and a `false`
 * short-circuits `and`. The ORM layer turns those constants into "no condition"
 * or "never matches".
 */
import { describe, expect, it } from "vitest";
import { QueryError } from "../src/contracts/errors.ts";
import {
  buildCondition,
  type Condition,
  createBuilder,
  operators,
} from "../src/contracts/condition.ts";
import type { AnyColumn } from "../src/contracts/schema/column.ts";
import { queryV1 } from "./support/schemas.ts";

const columns: Record<string, AnyColumn> = queryV1.tables.messages.columns;
const b = createBuilder(columns);

/** A second condition, used where the exact shape does not matter. */
const other = b("id", "=", "other");

describe("compare", () => {
  it("builds a Compare node from the column, operator, and value", () => {
    const condition = b("content", "=", "hi");
    expect(condition._tag).toBe("Compare");
    if (condition._tag !== "Compare") throw new Error("unreachable");
    expect(condition.column === columns["content"]).toBe(true);
    expect(condition.operator).toBe("=");
    expect(condition.value).toBe("hi");
  });

  it("treats a bare column as `= true`", () => {
    const condition = b("content");
    expect(condition).toMatchObject({ _tag: "Compare", operator: "=", value: true });
  });

  it("accepts every operator", () => {
    for (const operator of operators) {
      const value = operator === "in" || operator === "not in" ? ["a"] : "a";
      expect(b("content", operator as "=", value as string)._tag).toBe("Compare");
    }
  });

  it("builds isNull and isNotNull from `is` / `is not`", () => {
    expect(b.isNull("parent")).toMatchObject({ _tag: "Compare", operator: "is", value: null });
    expect(b.isNotNull("parent")).toMatchObject({
      _tag: "Compare",
      operator: "is not",
      value: null,
    });
  });

  it("throws a QueryError for an unknown column", () => {
    expect(() => b("nope" as "id", "=", "x")).toThrow(QueryError);
    try {
      b("nope" as "id", "=", "x");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
      if (!(error instanceof QueryError)) throw error;
      expect(error.reason).toBe("UnknownColumn");
      expect(error.column).toBe("nope");
      expect(error.message).toBe("Invalid column name nope");
    }
    expect(() => b.isNull("nope" as "id")).toThrow(QueryError);
    expect(() => b("nope" as "id")).toThrow(QueryError);
  });

  it("throws a QueryError for an unsupported operator", () => {
    expect(() => b("content", "like" as "=", "x")).toThrow(QueryError);
    expect(() => b("content", "like" as "=", "x")).toThrow("Unsupported operator: like");
  });
});

describe("and", () => {
  it("is true when empty", () => {
    expect(b.and()).toBe(true);
  });

  it("drops true and keeps the rest", () => {
    const result = b.and(true, other, true);
    expect(result).toMatchObject({ _tag: "And" });
    if (typeof result === "boolean" || result._tag !== "And") throw new Error("unreachable");
    expect(result.items).toHaveLength(1);
    expect(result.items[0] === other).toBe(true);
  });

  it("is true when every item is true", () => {
    expect(b.and(true, true)).toBe(true);
  });

  it("short-circuits on false", () => {
    expect(b.and(other, false, other)).toBe(false);
    expect(b.and(false)).toBe(false);
  });

  it("keeps the order of its items", () => {
    const first = b("content", "=", "a");
    const second = b("content", "=", "b");
    const result = b.and(first, second);
    if (typeof result === "boolean" || result._tag !== "And") throw new Error("unreachable");
    expect(result.items[0] === first).toBe(true);
    expect(result.items[1] === second).toBe(true);
  });
});

describe("or", () => {
  it("is false when empty", () => {
    expect(b.or()).toBe(false);
  });

  it("drops false and keeps the rest", () => {
    const result = b.or(false, other);
    expect(result).toMatchObject({ _tag: "Or" });
    if (typeof result === "boolean" || result._tag !== "Or") throw new Error("unreachable");
    expect(result.items).toHaveLength(1);
  });

  it("is false when every item is false", () => {
    expect(b.or(false, false)).toBe(false);
  });

  it("short-circuits on true", () => {
    expect(b.or(other, true, other)).toBe(true);
    expect(b.or(true)).toBe(true);
  });
});

describe("not", () => {
  it("negates a constant", () => {
    expect(b.not(true)).toBe(false);
    expect(b.not(false)).toBe(true);
  });

  it("wraps a condition", () => {
    const result = b.not(other);
    expect(result).toMatchObject({ _tag: "Not" });
    if (typeof result === "boolean" || result._tag !== "Not") throw new Error("unreachable");
    expect(result.item === other).toBe(true);
  });
});

describe("nesting", () => {
  it("folds a nested tree", () => {
    const result = b.and(b.or(false, b("content", "=", "a")), b.not(b.and()));
    // b.not(b.and()) is not(true) === false, so the whole `and` is false
    expect(result).toBe(false);
  });

  it("keeps a mixed tree", () => {
    const result = b.and(
      b.or(b("content", "=", "a"), b("content", "=", "b")),
      b.isNotNull("parent"),
    );
    if (typeof result === "boolean" || result._tag !== "And") throw new Error("unreachable");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?._tag).toBe("Or");
    expect(result.items[1]?._tag).toBe("Compare");
  });
});

describe("buildCondition", () => {
  it("passes a builder to the callback and returns its result", () => {
    const result: Condition | boolean = buildCondition(columns, (builder) =>
      builder("content", "=", "x"),
    );
    expect(result).toMatchObject({ _tag: "Compare" });
    expect(buildCondition(columns, (builder) => builder.and())).toBe(true);
  });
});
