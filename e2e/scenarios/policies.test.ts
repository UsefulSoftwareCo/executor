// Cross-target: policies CRUD through the typed HttpApiClient. A created
// policy comes back in the list with the shape that was sent.
import { randomBytes } from "node:crypto";

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
    const pattern = `policies-scn-${randomBytes(4).toString("hex")}.*`;

    yield* Effect.acquireUseRelease(
      api.policies.create({
        payload: { owner: "org", pattern, action: "block" },
      }),
      (created) =>
        Effect.gen(function* () {
          expect(created.owner).toBe("org");
          expect(created.pattern).toBe(pattern);
          expect(created.action).toBe("block");

          const list = yield* api.policies.list();
          const found = list.find((policy) => policy.id === created.id);
          expect(found, "created policy appears in the list").toBeDefined();
          expect(found?.pattern, "listed entry preserves the pattern").toBe(pattern);
          expect(found?.action, "listed entry preserves the action").toBe("block");
        }),
      (created) =>
        api.policies
          .remove({
            params: { policyId: created.id },
            payload: { owner: created.owner },
          })
          .pipe(Effect.ignore),
    );
  }),
);
