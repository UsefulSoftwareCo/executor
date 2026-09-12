import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { ToolAddress } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const api = composePluginApi([] as const);
const annotations = Schema.Struct({ requiresApproval: Schema.Boolean });
const descriptions = Schema.Struct({
  gated: Schema.Struct({ annotations }),
  plain: Schema.Record(Schema.String, Schema.Unknown),
});

scenario(
  "Tool discovery · declared approval annotations survive API and sandbox descriptions",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const session = mcp.session(identity);
    const address = ToolAddress.make("tools.executor.coreTools.connections.create");
    const view = yield* client.tools.schema({ query: { address } });
    expect(view.annotations).toEqual({ requiresApproval: true });
    const described = yield* session.call("execute", {
      code: `
      return JSON.stringify({
        gated: await tools.describe.tool({ path: "executor.coreTools.connections.create" }),
        plain: await tools.describe.tool({ path: "executor.coreTools.connections.list" }),
      });
    `,
    });
    expect(described.ok, described.text).toBe(true);
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(descriptions))(
      described.text,
    );
    expect(result.gated.annotations).toEqual(view.annotations);
    expect(result.plain).not.toHaveProperty("annotations");
  }),
);
