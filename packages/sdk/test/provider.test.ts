/** Provider references must survive crypto adapter changes and object key reordering. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Crypto, Effect, PlatformError } from "effect";
import type { ProviderDefinition } from "../src/contracts/provider.ts";
import { StorageError } from "../src/contracts/shared.ts";
import { identifyProvider } from "../src/implementation/provider.ts";

const definition: ProviderDefinition = {
  name: "Synthetic service",
  auth: {
    key: {
      type: "secrets",
      label: "API key",
      fields: {
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
        additionalProperties: false,
      },
    },
  },
};
// SHA-256 of the existing sorted, compact JSON format, recorded independently of Effect.
const expected = "prv_821e3dba79e26b7bb4cae3d07a67ca274387c5bbac34fb601ce30caf0dbcf406";

for (const [name, layer] of [
  ["Node", NodeCrypto.layer],
  ["Web Crypto", BrowserCrypto.layer],
] as const) {
  test(`${name} preserves existing provider references regardless of key order`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        assert.equal((yield* identifyProvider(definition, crypto)).id, expected);
        assert.equal(
          (yield* identifyProvider(
            {
              auth: {
                key: {
                  fields: {
                    additionalProperties: false,
                    required: ["token"],
                    properties: { token: { type: "string" } },
                    type: "object",
                  },
                  label: "API key",
                  type: "secrets",
                },
              },
              name: definition.name,
            },
            crypto,
          )).id,
          expected,
        );
      }).pipe(Effect.provide(layer)),
    ));
}

test("provider hashing projects crypto failures to the SDK error contract", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const crypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () =>
          Effect.fail(
            PlatformError.systemError({ module: "Crypto", method: "digest", _tag: "Unknown" }),
          ),
      });
      const result = yield* identifyProvider(definition, crypto).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.ok(result.failure instanceof StorageError);
    }),
  ));
