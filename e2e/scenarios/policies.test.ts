// Cross-target: policies CRUD through the typed HttpApiClient — a created
// policy comes back in the list with the shape that was sent.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const coreApi = composePluginApi([] as const);

scenario(
  "Policies · a created policy appears in the list for the owning identity",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const identity = yield* target.newIdentity();
    const api = yield* client(coreApi, identity);

    const created = yield* api.policies.create({
      payload: { owner: "org", pattern: "policies-scn.*", action: "block" },
    });
    expect(created.owner).toBe("org");
    expect(created.pattern).toBe("policies-scn.*");
    expect(created.action).toBe("block");

    const list = yield* api.policies.list();
    const found = list.find((p) => p.id === created.id);
    expect(found, "created policy appears in the list").toBeDefined();
    expect(found?.pattern, "listed entry preserves the pattern").toBe("policies-scn.*");
    expect(found?.action, "listed entry preserves the action").toBe("block");
  }),
);
