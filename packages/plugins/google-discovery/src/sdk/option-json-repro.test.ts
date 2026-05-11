// Reproduces the PR 706 bug class using Effect-native primitives only —
// no JSON.parse, no JSON.stringify, no node:fs on our side. We split the
// JSON boundary into two Effect schema steps:
//
//   1. Schema.encodeEffect(Inner)(value)            → encoded JS shape
//   2. Schema.encodeEffect(UnknownFromJsonString)   → JSON string
//   3. fs.writeFileString → fs.readFileString
//   4. Schema.decodeUnknownEffect(UnknownFromJsonString) → unknown
//   5. Schema.decodeUnknownEffect(Inner)             → final value
//
// Even though every step runs through Effect, Schema.Option(X) still
// breaks because its Encoded type IS Option<X> — not a JSON value. So
// step 2's JSON-stringify (driven by Effect, not us) flattens the Option
// to {_id,_tag,value}, and step 5 rejects the shape.
//
// Run: vitest run packages/plugins/google-discovery/src/sdk/option-json-repro.test.ts

import { describe, expect, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, Exit, FileSystem, Option, Schema } from "effect";

const Broken = Schema.Struct({ description: Schema.Option(Schema.String) });
const Fixed = Schema.Struct({ description: Schema.OptionFromOptional(Schema.String) });

const broken = { description: Option.some("hello") };
const fixed = { description: Option.some("hello") };

const withTmpFile = <A, E>(fn: (path: string) => Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "option-repro-" });
    return yield* fn(`${dir}/binding.json`);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

describe("Schema.Option round-trips through Effect-native JSON I/O", () => {
  it.effect("BREAKS: every step driven by Effect, still loses the Option shape", () =>
    withTmpFile((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        // Step 1: schema encode → encoded JS shape. For Schema.Option,
        // the encoded `description` is still an Option instance.
        const encodedShape = yield* Schema.encodeEffect(Broken)(broken);
        expect(Option.isOption(encodedShape.description)).toBe(true);

        // Step 2: turn the encoded shape into a JSON string via Effect.
        const jsonString = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(encodedShape);
        // This is what Effect produced — Option's toJSON shape:
        expect(jsonString).toContain('"_id":"Option"');
        expect(jsonString).toContain('"_tag":"Some"');

        // Step 3 + 4: round-trip via the platform FileSystem.
        yield* fs.writeFileString(path, jsonString);
        const onDisk = yield* fs.readFileString(path);

        // Step 5: parse string → unknown via Effect.
        const parsed = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(onDisk);

        // Step 6: decode the unknown back through the schema → fails,
        // because the wire shape isn't an Option instance.
        const result = yield* Effect.exit(Schema.decodeUnknownEffect(Broken)(parsed));
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ),
  );

  it.effect("WORKS: same pipeline with Schema.OptionFromOptional", () =>
    withTmpFile((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const encodedShape = yield* Schema.encodeEffect(Fixed)(fixed);
        // Encoded form is JSON-safe: { description: "hello" }
        expect(encodedShape.description).toBe("hello");

        const jsonString = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(encodedShape);
        expect(jsonString).toBe('{"description":"hello"}');

        yield* fs.writeFileString(path, jsonString);
        const onDisk = yield* fs.readFileString(path);

        const parsed = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(onDisk);
        const decoded = yield* Schema.decodeUnknownEffect(Fixed)(parsed);

        expect(Option.getOrNull(decoded.description)).toBe("hello");
      }),
    ),
  );

  it.effect("WORKS: None round-trips as a missing key with OptionFromOptional", () =>
    withTmpFile((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const noneVal = { description: Option.none<string>() };

        const encodedShape = yield* Schema.encodeEffect(Fixed)(noneVal);
        const jsonString = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(encodedShape);
        expect(jsonString).toBe("{}");

        yield* fs.writeFileString(path, jsonString);
        const onDisk = yield* fs.readFileString(path);
        const parsed = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(onDisk);
        const decoded = yield* Schema.decodeUnknownEffect(Fixed)(parsed);

        expect(Option.isNone(decoded.description)).toBe(true);
      }),
    ),
  );
});
