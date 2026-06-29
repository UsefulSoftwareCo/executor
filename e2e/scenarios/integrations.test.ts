// Cross-target: a fresh workspace ships the built-in executor integration ready
// to use — it appears in the catalog, it cannot be removed, and it already
// contributes tools so an agent can start without any manual setup.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const coreApi = composePluginApi([] as const);

scenario(
  "Integrations · a fresh workspace ships the built-in executor integration ready to use",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const identity = yield* target.newIdentity();
    const api = yield* client(coreApi, identity);

    const integrations = yield* api.integrations.list();
    const builtin = integrations.find((i) => i.slug === "executor");
    expect(builtin, "the 'executor' integration is in the catalog").toBeDefined();
    expect(builtin?.kind).toBe("built-in");
    expect(builtin?.canRemove, "the built-in integration is permanent").toBe(false);

    const tools = yield* api.tools.list({ query: {} });
    const executorTools = tools.filter((t) => t.integration === "executor");
    expect(
      executorTools.length,
      "tools are available out of the box, no connection setup needed",
    ).toBeGreaterThan(0);
  }),
);
