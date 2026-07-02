import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  coerceNumber,
  defaultForSchema,
  isRenderableObjectSchema,
  missingRequiredFields,
  removeProperty,
  setProperty,
} from "./json-schema-form";

// Mirror the panel's decode boundary so the round-trip assertions use the exact
// same path the production code uses (no raw JSON.parse).
const decodeArgsJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

const SCHEMA = {
  type: "object",
  required: ["email"],
  properties: {
    email: { type: "string" },
    age: { type: "integer" },
    tags: { type: "array", items: { type: "string" } },
    role: { enum: ["a", "b"] },
  },
} as const;

describe("missingRequiredFields (Run gate)", () => {
  it("reports unfilled required args, ignores optionals, never gates without required", () => {
    // unset / empty-string / null required → still missing (Run stays disabled)
    expect(missingRequiredFields(SCHEMA, undefined, {})).toEqual(["email"]);
    expect(missingRequiredFields(SCHEMA, undefined, { email: "" })).toEqual(["email"]);
    expect(missingRequiredFields(SCHEMA, undefined, { email: null })).toEqual(["email"]);
    // present + non-empty required → nothing missing; optionals never gate
    expect(missingRequiredFields(SCHEMA, undefined, { email: "a@b.c" })).toEqual([]);
    expect(missingRequiredFields(SCHEMA, undefined, { email: "a@b.c", age: 0 })).toEqual([]);
    // no required / no schema → never gates a zero-arg or schema-less tool
    expect(missingRequiredFields({ type: "object", properties: {} }, undefined, {})).toEqual([]);
    expect(missingRequiredFields(null, undefined, {})).toEqual([]);
  });
});

describe("json-schema-form value transforms", () => {
  it("lossless round-trip with object + nested array + enum (omit-unset)", () => {
    const valueIn: Record<string, unknown> = {
      email: "x@y.z",
      tags: ["p"],
      role: "a",
    };

    // Edit email, then append a tag — the rebuilds the form would produce.
    const afterEmail = setProperty(valueIn, "email", "q@y.z");
    const tags = Array.isArray(afterEmail.tags) ? afterEmail.tags : [];
    const rebuilt = setProperty(afterEmail, "tags", [...tags, "r"]);

    const json = JSON.stringify(rebuilt, null, 2);
    const decoded = decodeArgsJson(json);

    expect(Option.isSome(decoded)).toBe(true);
    const value = Option.getOrElse(decoded, () => ({}) as unknown);
    expect(value).toEqual({ email: "q@y.z", tags: ["p", "r"], role: "a" });
    // `age` was never present — it must not appear after the round-trip.
    expect(Object.keys(value as object).sort()).toEqual(["email", "role", "tags"]);
  });

  it("omit-unset-optional: editing only required field never invents optional keys", () => {
    const rebuilt = setProperty({}, "email", "a@b.c");
    expect(Object.keys(rebuilt)).toEqual(["email"]);
    // No `null` placeholders serialized for omitted optionals.
    expect(JSON.stringify(rebuilt)).toBe('{"email":"a@b.c"}');
  });

  it("removeProperty deletes an optional key and leaves siblings intact", () => {
    const value: Record<string, unknown> = { email: "x@y.z", age: 30 };
    const next = removeProperty(value, "age");
    expect("age" in next).toBe(false);
    expect(next).toEqual({ email: "x@y.z" });
    // Original is not mutated.
    expect("age" in value).toBe(true);
  });

  it("number coercion stores JS numbers, not strings, and round-trips as JSON number", () => {
    const next = setProperty({}, "age", coerceNumber("123", true));
    expect(next.age).toBe(123);
    expect(typeof next.age).toBe("number");
    expect(JSON.stringify(next)).toBe('{"age":123}');

    // Invalid input yields undefined (caller keeps last-valid; never emits it).
    expect(coerceNumber("abc", true)).toBeUndefined();
    expect(coerceNumber("", false)).toBeUndefined();
    // Integer truncation.
    expect(coerceNumber("3.9", true)).toBe(3);
    expect(coerceNumber("3.5", false)).toBe(3.5);
  });

  it("defaultForSchema seeds the right empty value per type", () => {
    const root = { $defs: {} };
    expect(defaultForSchema({ type: "string" }, root)).toBe("");
    expect(defaultForSchema({ type: "integer" }, root)).toBe(0);
    expect(defaultForSchema({ type: "boolean" }, root)).toBe(false);
    expect(defaultForSchema({ type: "object" }, root)).toEqual({});
    expect(defaultForSchema({ type: "array" }, root)).toEqual([]);
    expect(defaultForSchema({ enum: ["a", "b"] }, root)).toBe("a");
    expect(defaultForSchema({ const: 7 }, root)).toBe(7);
  });

  it("isRenderableObjectSchema gates form-mode availability", () => {
    expect(isRenderableObjectSchema(SCHEMA)).toBe(true);

    // $ref resolving (via definitions) to an object is renderable.
    expect(
      isRenderableObjectSchema(
        { $ref: "#/$defs/Args" },
        { Args: { type: "object", properties: { a: { type: "string" } } } },
      ),
    ).toBe(true);

    expect(isRenderableObjectSchema({ type: "string" })).toBe(false);
    expect(isRenderableObjectSchema(undefined)).toBe(false);
    // Unresolvable $ref → not renderable.
    expect(isRenderableObjectSchema({ $ref: "#/$defs/Missing" })).toBe(false);
  });

  it("invalid / non-object JSON disables the Form tab (the toggle guard)", () => {
    const parsedArgsFor = (raw: string): Record<string, unknown> | null => {
      const decoded = decodeArgsJson(raw);
      if (Option.isNone(decoded)) return null;
      const v = decoded.value;
      return typeof v === "object" && v !== null && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
    };
    const formDisabled = (schemaAvailable: boolean, parsed: Record<string, unknown> | null) =>
      !schemaAvailable || parsed === null;

    // Malformed JSON → parsedArgs null → Form tab un-selectable.
    expect(parsedArgsFor("{ broken")).toBeNull();
    expect(formDisabled(true, parsedArgsFor("{ broken"))).toBe(true);

    // Valid but non-object JSON also yields null.
    expect(parsedArgsFor("[]")).toBeNull();
    expect(parsedArgsFor("5")).toBeNull();
    expect(formDisabled(true, parsedArgsFor("5"))).toBe(true);

    // Valid object + available schema → form enabled.
    expect(parsedArgsFor('{"email":"x@y.z"}')).toEqual({ email: "x@y.z" });
    expect(formDisabled(true, parsedArgsFor('{"email":"x@y.z"}'))).toBe(false);
  });
});
