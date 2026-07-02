// Cross-target: the typed API surface, exactly as a consumer uses it. The
// contract is the CORE executor HttpApi (composePluginApi([])) — every target
// serves it under /api, so one scenario runs against all of them.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const coreApi = composePluginApi([] as const);

scenario(
  "API · typed client lists the available tools",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const identity = yield* target.newIdentity();
    const api = yield* client(coreApi, identity);
    const tools = yield* api.tools.list({ query: {} });
    expect(tools.length, "at least one tool is exposed").toBeGreaterThan(0);
  }),
);

scenario(
  "API · a fresh identity starts with zero connections",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const identity = yield* target.newIdentity();
    const api = yield* client(coreApi, identity);
    const connections = yield* api.connections.list({ query: {} });
    expect(connections.length, "no connections leak across identities").toBe(0);
  }),
);
