import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { OpenApiParseError } from "./errors";
import { resolveSpecFormatAdapter, type SpecFormatAdapter } from "./spec-format";

const adapter: SpecFormatAdapter = {
  id: "known",
  fetch: () => Effect.succeed({ specText: "{}" }),
};

it.effect("resolves a registered spec format adapter by id", () =>
  Effect.gen(function* () {
    const resolved = yield* resolveSpecFormatAdapter([adapter], "known");
    expect(resolved).toBe(adapter);
  }),
);

it.effect("returns null when no spec format id is supplied", () =>
  Effect.gen(function* () {
    const resolved = yield* resolveSpecFormatAdapter([adapter], undefined);
    expect(resolved).toBeNull();
  }),
);

it.effect("fails with a typed parse error for an unknown spec format id", () =>
  Effect.gen(function* () {
    const error = yield* resolveSpecFormatAdapter([adapter], "missing").pipe(Effect.flip);
    expect(error).toBeInstanceOf(OpenApiParseError);
    expect(error).toMatchObject({ message: "Unknown OpenAPI spec format: missing" });
  }),
);
