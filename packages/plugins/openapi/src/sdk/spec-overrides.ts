import { Data, Effect, Exit, Match, Option, Schema } from "effect";

import { OpenApiSpecOverrideError } from "./errors";

export const JsonPatchOperationSchema = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("add"),
    path: Schema.String,
    value: Schema.Unknown,
  }),
  Schema.Struct({
    op: Schema.Literal("remove"),
    path: Schema.String,
  }),
  Schema.Struct({
    op: Schema.Literal("replace"),
    path: Schema.String,
    value: Schema.Unknown,
  }),
  Schema.Struct({
    op: Schema.Literal("move"),
    path: Schema.String,
    from: Schema.String,
  }),
  Schema.Struct({
    op: Schema.Literal("copy"),
    path: Schema.String,
    from: Schema.String,
  }),
  Schema.Struct({
    op: Schema.Literal("test"),
    path: Schema.String,
    value: Schema.Unknown,
  }),
]);

export const SpecOverridesSchema = Schema.Array(JsonPatchOperationSchema);

export type JsonPatchOperation = typeof JsonPatchOperationSchema.Type;
export type SpecOverrides = typeof SpecOverridesSchema.Type;

const decodeSpecOverridesText = Schema.decodeUnknownExit(
  Schema.fromJsonString(SpecOverridesSchema),
);
const decodeSpecOverrides = Schema.decodeUnknownOption(SpecOverridesSchema);

export type SpecOverridesTextResult =
  | { readonly ok: true; readonly value: SpecOverrides }
  | { readonly ok: false; readonly message: string };

/** Decode preset or persisted override data at a plugin boundary. */
export const decodeOpenApiSpecOverrides = (value: unknown): SpecOverrides | undefined =>
  decodeSpecOverrides(value).pipe(Option.getOrUndefined);

/** Decode user-authored JSON Patch text into the persisted override contract. */
export const parseSpecOverridesText = (text: string): SpecOverridesTextResult => {
  if (text.trim().length === 0) return { ok: true, value: [] };
  const decoded = decodeSpecOverridesText(text);
  return Exit.isSuccess(decoded)
    ? { ok: true, value: decoded.value }
    : {
        ok: false,
        message:
          "Spec overrides must be a JSON array of RFC 6902 add, remove, replace, move, copy, or test operations.",
      };
};

/** Format persisted overrides for the advanced JSON editor. */
export const formatSpecOverridesText = (overrides: SpecOverrides | undefined): string =>
  overrides && overrides.length > 0 ? JSON.stringify(overrides, null, 2) : "";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

class PatchApplicationFailure extends Data.TaggedError("PatchApplicationFailure")<{
  readonly detail: string;
}> {}

const patchFailure = (detail: string) => new PatchApplicationFailure({ detail });

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isJsonValue);
};

const overrideError = (operationIndex: number, operation: string, path: string, detail: string) =>
  new OpenApiSpecOverrideError({
    operationIndex,
    operation,
    path,
    message: `Spec override ${operationIndex + 1} (${operation} ${path || "/"}) failed: ${detail}`,
  });

const cloneJsonValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value !== null && typeof value === "object") {
    const clone: JsonObject = Object.create(null);
    for (const [key, entry] of Object.entries(value)) clone[key] = cloneJsonValue(entry);
    return clone;
  }
  return value;
};

const parsePointer = Effect.fn("OpenApi.parseJsonPointer")(function* (pointer: string) {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    return yield* patchFailure(`Invalid JSON Pointer ${JSON.stringify(pointer)}`);
  }
  const segments: string[] = [];
  for (const segment of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(segment)) {
      return yield* patchFailure(`Invalid JSON Pointer escape in ${JSON.stringify(pointer)}`);
    }
    segments.push(segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return segments;
});

const arrayIndex = Effect.fn("OpenApi.jsonPatchArrayIndex")(function* (
  segment: string,
  length: number,
  pointer: string,
  options: { readonly append: boolean; readonly existing: boolean },
) {
  if (segment === "-") {
    if (options.append) return length;
    return yield* patchFailure(`JSON Pointer ${JSON.stringify(pointer)} cannot use '-' here`);
  }
  if (!/^(0|[1-9]\d*)$/.test(segment)) {
    return yield* patchFailure(
      `JSON Pointer ${JSON.stringify(pointer)} has invalid array index ${JSON.stringify(segment)}`,
    );
  }
  const index = Number(segment);
  const upperBound = options.existing ? length - 1 : length;
  if (!Number.isSafeInteger(index) || index < 0 || index > upperBound) {
    return yield* patchFailure(
      `JSON Pointer ${JSON.stringify(pointer)} has array index ${index} outside the valid range`,
    );
  }
  return index;
});

const valueAt = Effect.fn("OpenApi.jsonPatchValueAt")(function* (root: JsonValue, pointer: string) {
  const segments = yield* parsePointer(pointer);
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      current =
        current[
          yield* arrayIndex(segment, current.length, pointer, {
            append: false,
            existing: true,
          })
        ]!;
      continue;
    }
    if (current !== null && typeof current === "object") {
      if (!Object.hasOwn(current, segment)) {
        return yield* patchFailure(`JSON Pointer ${JSON.stringify(pointer)} does not exist`);
      }
      current = current[segment]!;
      continue;
    }
    return yield* patchFailure(`JSON Pointer ${JSON.stringify(pointer)} cannot be traversed`);
  }
  return current;
});

const parentAt = Effect.fn("OpenApi.jsonPatchParentAt")(function* (
  root: JsonValue,
  pointer: string,
) {
  const segments = yield* parsePointer(pointer);
  if (segments.length === 0) {
    return yield* patchFailure("The document root has no parent");
  }
  const parentPointer = `/${segments
    .slice(0, -1)
    .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/")}`;
  const parent = segments.length === 1 ? root : yield* valueAt(root, parentPointer);
  if (parent === null || typeof parent !== "object") {
    return yield* patchFailure(`JSON Pointer ${JSON.stringify(pointer)} has no container`);
  }
  return { parent, segment: segments[segments.length - 1]! };
});

const addValue = Effect.fn("OpenApi.jsonPatchAddValue")(function* (
  root: JsonValue,
  pointer: string,
  value: JsonValue,
) {
  if (pointer === "") return cloneJsonValue(value);
  const { parent, segment } = yield* parentAt(root, pointer);
  if (Array.isArray(parent)) {
    const index = yield* arrayIndex(segment, parent.length, pointer, {
      append: true,
      existing: false,
    });
    parent.splice(index, 0, cloneJsonValue(value));
  } else {
    parent[segment] = cloneJsonValue(value);
  }
  return root;
});

const removeValue = Effect.fn("OpenApi.jsonPatchRemoveValue")(function* (
  root: JsonValue,
  pointer: string,
) {
  if (pointer === "") return { root: null, removed: root };
  const { parent, segment } = yield* parentAt(root, pointer);
  if (Array.isArray(parent)) {
    const index = yield* arrayIndex(segment, parent.length, pointer, {
      append: false,
      existing: true,
    });
    return { root, removed: parent.splice(index, 1)[0]! };
  }
  if (!Object.hasOwn(parent, segment)) {
    return yield* patchFailure(`JSON Pointer ${JSON.stringify(pointer)} does not exist`);
  }
  const removed = parent[segment]!;
  delete parent[segment];
  return { root, removed };
});

const replaceValue = Effect.fn("OpenApi.jsonPatchReplaceValue")(function* (
  root: JsonValue,
  pointer: string,
  value: JsonValue,
) {
  if (pointer === "") return cloneJsonValue(value);
  yield* valueAt(root, pointer);
  const { parent, segment } = yield* parentAt(root, pointer);
  if (Array.isArray(parent)) {
    const index = yield* arrayIndex(segment, parent.length, pointer, {
      append: false,
      existing: true,
    });
    parent[index] = cloneJsonValue(value);
  } else {
    parent[segment] = cloneJsonValue(value);
  }
  return root;
});

const jsonEquals = (left: JsonValue, right: JsonValue): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonEquals(entry, right[index]!))
    );
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && jsonEquals(left[key]!, right[key]!))
  );
};

const operationValue = Effect.fn("OpenApi.jsonPatchOperationValue")(function* (
  operation: JsonPatchOperation,
) {
  if (!("value" in operation) || !isJsonValue(operation.value)) {
    return yield* patchFailure(`${operation.op} requires a JSON value`);
  }
  return operation.value;
});

const applyOperation = (root: JsonValue, operation: JsonPatchOperation) =>
  Match.value(operation).pipe(
    Match.when({ op: "add" }, (entry) =>
      Effect.gen(function* () {
        const value = yield* operationValue(entry);
        return yield* addValue(root, entry.path, value);
      }),
    ),
    Match.when({ op: "remove" }, (entry) =>
      removeValue(root, entry.path).pipe(Effect.map((result) => result.root)),
    ),
    Match.when({ op: "replace" }, (entry) =>
      Effect.gen(function* () {
        const value = yield* operationValue(entry);
        return yield* replaceValue(root, entry.path, value);
      }),
    ),
    Match.when({ op: "copy" }, (entry) =>
      Effect.gen(function* () {
        const value = yield* valueAt(root, entry.from);
        return yield* addValue(root, entry.path, value);
      }),
    ),
    Match.when({ op: "move" }, (entry) =>
      Effect.gen(function* () {
        if (entry.path.startsWith(`${entry.from}/`)) {
          return yield* patchFailure("A value cannot be moved into one of its children");
        }
        const removed = yield* removeValue(root, entry.from);
        return yield* addValue(removed.root, entry.path, removed.removed);
      }),
    ),
    Match.when({ op: "test" }, (entry) =>
      Effect.gen(function* () {
        const expected = yield* operationValue(entry);
        const actual = yield* valueAt(root, entry.path);
        if (!jsonEquals(actual, expected)) {
          return yield* patchFailure("The test value did not match");
        }
        return root;
      }),
    ),
    Match.exhaustive,
  );

/** Apply ordered RFC 6902 operations to a cloned JSON document. */
export const applySpecOverrides = Effect.fn("OpenApi.applySpecOverrides")(function* (
  document: unknown,
  overrides: SpecOverrides,
) {
  if (!isJsonValue(document)) {
    return yield* overrideError(
      0,
      "parse",
      "",
      "OpenAPI document must contain only JSON-compatible values",
    );
  }

  let result = cloneJsonValue(document);
  for (const [operationIndex, operation] of overrides.entries()) {
    const applied = yield* applyOperation(result, operation).pipe(
      Effect.mapError((failure) =>
        overrideError(operationIndex, operation.op, operation.path, failure.detail),
      ),
    );
    result = applied;
  }

  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return yield* overrideError(
      Math.max(0, overrides.length - 1),
      overrides.at(-1)?.op ?? "parse",
      overrides.at(-1)?.path ?? "",
      "Spec overrides must leave the OpenAPI document as an object",
    );
  }
  return result;
});
