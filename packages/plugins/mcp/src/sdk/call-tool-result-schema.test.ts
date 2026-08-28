import { describe, expect, it } from "@effect/vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/core";

import { callToolResultJsonSchema } from "./call-tool-result-schema.gen";

// The generated copy exists so the RUNTIME never imports
// @modelcontextprotocol/core (module eval costs ~8.6MB of heap per Cloudflare
// isolate; see client-module.ts). Tests may import it freely — this one pins
// the baked schema to the installed package so a core version bump that
// changes CallToolResultSchema fails here until the file is regenerated:
//   bun scripts/gen-call-tool-result-schema.ts
describe("call-tool-result-schema.gen", () => {
  it("matches the installed @modelcontextprotocol/core schema", () => {
    expect(callToolResultJsonSchema).toStrictEqual(CallToolResultSchema.toJSONSchema());
  });
});
