// Cross-target: the typed API surface, exactly as a consumer uses it. The
// contract is the CORE executor HttpApi (composePluginApi([])) — every target
// serves it under /api, so one scenario runs against all of them.
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";

const coreApi = composePluginApi([] as const);

scenario("API · typed client lists the available tools", { needs: ["api"] }, (ctx) =>
  Effect.gen(function* () {
    ctx.rec.say("Sign in as a fresh identity and list tools through the typed HttpApiClient.");
    const identity = yield* ctx.target.newIdentity();
    const client = yield* ctx.api.client(coreApi, identity);
    const tools = yield* ctx.api.call("tools.list", {}, client.tools.list());
    ctx.rec.expect(tools.length, "at least one tool is exposed").toBeGreaterThan(0);
  }),
);

scenario("API · a fresh identity starts with zero connections", { needs: ["api"] }, (ctx) =>
  Effect.gen(function* () {
    ctx.rec.say("A brand-new identity must see an empty, isolated workspace.");
    const identity = yield* ctx.target.newIdentity();
    const client = yield* ctx.api.client(coreApi, identity);
    const connections = yield* ctx.api.call("connections.list", {}, client.connections.list());
    ctx.rec.expect(connections.length, "no connections leak across identities").toBe(0);
  }),
);
