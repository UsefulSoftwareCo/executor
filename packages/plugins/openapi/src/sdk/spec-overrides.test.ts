import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  applySpecOverrides,
  formatSpecOverridesText,
  parseSpecOverridesText,
  type SpecOverrides,
} from "./spec-overrides";

const apply = (document: unknown, overrides: SpecOverrides) =>
  Effect.runPromise(applySpecOverrides(document, overrides));

describe("OpenAPI spec overrides", () => {
  it("parses and formats the JSON Patch editor contract", () => {
    expect(parseSpecOverridesText("")).toEqual({ ok: true, value: [] });
    expect(parseSpecOverridesText('[{"op":"remove","path":"/paths/~1legacy"}]')).toEqual({
      ok: true,
      value: [{ op: "remove", path: "/paths/~1legacy" }],
    });
    expect(parseSpecOverridesText('{"op":"remove"}')).toMatchObject({ ok: false });
    expect(formatSpecOverridesText([{ op: "remove", path: "/paths/~1legacy" }])).toContain(
      '"path": "/paths/~1legacy"',
    );
  });

  it("applies ordered RFC 6902 operations without mutating the source", async () => {
    const source = {
      components: {
        securitySchemes: {
          OAuth2: {
            flows: {
              authorizationCode: {
                scopes: { read: "Read", write: "Write" },
              },
            },
          },
        },
      },
      tags: ["one", "two"],
    };

    const result = await apply(source, [
      {
        op: "test",
        path: "/components/securitySchemes/OAuth2/flows/authorizationCode/scopes/read",
        value: "Read",
      },
      {
        op: "replace",
        path: "/components/securitySchemes/OAuth2/flows/authorizationCode/scopes",
        value: { read: "Read" },
      },
      { op: "add", path: "/tags/-", value: "three" },
      { op: "copy", from: "/tags/0", path: "/primaryTag" },
      { op: "move", from: "/tags/1", path: "/tags/0" },
      { op: "remove", path: "/tags/2" },
    ]);

    expect(result).toEqual({
      components: {
        securitySchemes: {
          OAuth2: {
            flows: {
              authorizationCode: {
                scopes: { read: "Read" },
              },
            },
          },
        },
      },
      tags: ["two", "one"],
      primaryTag: "one",
    });
    expect(source.components.securitySchemes.OAuth2.flows.authorizationCode.scopes).toEqual({
      read: "Read",
      write: "Write",
    });
    expect(source.tags).toEqual(["one", "two"]);
  });

  it("reports the exact stale operation and path", async () => {
    const error = await Effect.runPromise(
      applySpecOverrides({ openapi: "3.1.0" }, [
        { op: "replace", path: "/components/securitySchemes/OAuth2", value: {} },
      ]).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      _tag: "OpenApiSpecOverrideError",
      operationIndex: 0,
      operation: "replace",
      path: "/components/securitySchemes/OAuth2",
      message: expect.stringContaining(
        "Spec override 1 (replace /components/securitySchemes/OAuth2) failed",
      ),
    });
  });

  it("rejects invalid pointers and failed test operations", async () => {
    const invalidPointer = await Effect.runPromise(
      applySpecOverrides({ openapi: "3.1.0" }, [
        { op: "add", path: "openapi", value: "3.0.0" },
      ]).pipe(Effect.flip),
    );
    expect(invalidPointer.message).toContain("Invalid JSON Pointer");

    const failedTest = await Effect.runPromise(
      applySpecOverrides({ openapi: "3.1.0" }, [
        { op: "test", path: "/openapi", value: "3.0.0" },
      ]).pipe(Effect.flip),
    );
    expect(failedTest.message).toContain("The test value did not match");
  });

  it("treats prototype-shaped keys as ordinary JSON properties", async () => {
    const result = await apply({ openapi: "3.1.0" }, [
      { op: "add", path: "/__proto__", value: { polluted: true } },
    ]);

    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});
