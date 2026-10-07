import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { extract } from "./extract";
import { buildRequest } from "./invoke";
import { parse } from "./parse";

const operation = (template = "/run/{*identifier}") =>
  Effect.gen(function* () {
    const document = yield* parse(
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Wildcard paths", version: "1" },
        paths: {
          [template]: {
            get: {
              operationId: "readPath",
              parameters: [
                { name: "identifier", in: "path", required: true, schema: { type: "string" } },
              ],
              responses: { "200": { description: "OK" } },
            },
          },
        },
      }),
    );
    const result = yield* extract(document);
    return result.operations[0]!;
  });

it.effect("binds an imported catch-all to its declared unprefixed parameter", () =>
  Effect.gen(function* () {
    const binding = yield* operation();
    expect(Option.getOrThrow(binding.inputSchema)).toMatchObject({ required: ["identifier"] });
    const request = yield* buildRequest(binding, { identifier: "nested/module/read" }, {});
    expect(request.url).toBe("/run/nested/module/read");
  }),
);

it.effect("encodes wildcard segments without introducing query or fragment delimiters", () =>
  Effect.gen(function* () {
    const binding = yield* operation();
    const request = yield* buildRequest(binding, { identifier: "a b/c?d#e/%2F/雪" }, {});
    expect(request.url).toBe("/run/a%20b/c%3Fd%23e/%252F/%E9%9B%AA");
  }),
);

it.effect("uses the existing nested path argument contract for catch-alls", () =>
  Effect.gen(function* () {
    const request = yield* buildRequest(
      yield* operation(),
      { path: { identifier: "module/read" } },
      {},
    );
    expect(request.url).toBe("/run/module/read");
  }),
);

it.effect("still rejects missing catch-all values by the declared parameter name", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(buildRequest(yield* operation(), {}, {}));
    expect(error).toMatchObject({ message: "Missing required path parameter: identifier" });
  }),
);

it.effect("retains ordinary parameter encoding alongside a catch-all of the same name", () =>
  Effect.gen(function* () {
    const request = yield* buildRequest(
      yield* operation("/plain/{identifier}/wild/{*identifier}"),
      { identifier: "module/read" },
      {},
    );
    expect(request.url).toBe("/plain/module%2Fread/wild/module/read");
  }),
);

for (const identifier of ["../admin", "nested/../../admin", "./read", "nested/..", "/../admin/"]) {
  it.effect(`rejects catch-all dot segments before constructing a request: ${identifier}`, () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(buildRequest(yield* operation(), { identifier }, {}));
      expect(failure).toMatchObject({
        message: "Wildcard path parameter identifier must not contain dot segments",
      });
    }),
  );
}

for (const [identifier, expected] of [
  ["/nested/read/", "/run//nested/read/"],
  ["nested//read", "/run/nested//read"],
  ["nested/%2F/read", "/run/nested/%252F/read"],
  ["nested/%252F/read", "/run/nested/%25252F/read"],
  ["%2e%2e/read", "/run/%252e%252e/read"],
  ["nested\\..\\read", "/run/nested%5C..%5Cread"],
] as const) {
  it.effect(`preserves segment boundaries through URL normalization: ${identifier}`, () =>
    Effect.gen(function* () {
      const request = yield* buildRequest(yield* operation(), { identifier }, {});
      expect(new URL(request.url, "https://api.example.test").pathname).toBe(expected);
    }),
  );
}
