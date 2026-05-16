import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import {
  CloudAuthApiTestContext,
  CloudAuthApiTestContextLayer,
  makeCloudAuthApiTestState,
} from "./cloud-auth-api.test-context";
import { makeWorkOSTestMembership, makeWorkOSTestState } from "./workos.test-layer";
import { makeAutumnTestState } from "../services/autumn.test-layer";

describe("create organization API", () => {
  it.effect("lets a paid user create another organization through the HTTP API client", () => {
    const state = makeCloudAuthApiTestState({
      workos: makeWorkOSTestState({
        memberships: [
          makeWorkOSTestMembership("org_free_1", "active"),
          makeWorkOSTestMembership("org_free_2", "active"),
          makeWorkOSTestMembership("org_paid", "active"),
        ],
      }),
      autumn: makeAutumnTestState({
        subscriptionsByOrgId: {
          org_paid: [{ planId: "team", status: "active" }],
        },
      }),
    });

    return Effect.gen(function* () {
      const { client } = yield* CloudAuthApiTestContext;

      const result = yield* client.cloudAuth.createOrganization({
        payload: { name: "Paid Extra Org" },
      });

      assert.deepEqual(result, { id: "org_created", name: "Paid Extra Org" });
      assert.deepEqual(state.workos.createdOrganizations, [
        { id: "org_created", name: "Paid Extra Org" },
      ]);
      assert.deepEqual(state.workos.createdMemberships, [
        { organizationId: "org_created", userId: "user_1", roleSlug: "admin" },
      ]);
      assert.deepEqual(state.userStore.upsertedOrganizations, [
        { id: "org_created", name: "Paid Extra Org" },
      ]);
    }).pipe(Effect.provide(CloudAuthApiTestContextLayer(state)));
  });

  it.effect(
    "rejects a free-only user at the free organization limit through the HTTP API client",
    () => {
      const state = makeCloudAuthApiTestState({
        workos: makeWorkOSTestState({
          memberships: [
            makeWorkOSTestMembership("org_free_1", "active"),
            makeWorkOSTestMembership("org_free_2", "active"),
            makeWorkOSTestMembership("org_free_3", "active"),
          ],
        }),
      });

      return Effect.gen(function* () {
        const { client } = yield* CloudAuthApiTestContext;

        const exit = yield* Effect.exit(
          client.cloudAuth.createOrganization({
            payload: { name: "Blocked Org" },
          }),
        );

        assert.isTrue(Exit.isFailure(exit));
        assert.deepEqual(state.workos.createdOrganizations, []);
        assert.deepEqual(state.workos.createdMemberships, []);
        assert.deepEqual(state.userStore.upsertedOrganizations, []);
      }).pipe(Effect.provide(CloudAuthApiTestContextLayer(state)));
    },
  );

  it.effect("does not count pending memberships toward the free organization limit", () => {
    const state = makeCloudAuthApiTestState({
      workos: makeWorkOSTestState({
        memberships: [
          makeWorkOSTestMembership("org_free_1", "active"),
          makeWorkOSTestMembership("org_free_2", "active"),
          makeWorkOSTestMembership("org_invited", "pending"),
        ],
      }),
    });

    return Effect.gen(function* () {
      const { client } = yield* CloudAuthApiTestContext;

      const result = yield* client.cloudAuth.createOrganization({
        payload: { name: "Below Active Limit" },
      });

      assert.deepEqual(result, { id: "org_created", name: "Below Active Limit" });
      assert.deepEqual(state.workos.createdOrganizations, [
        { id: "org_created", name: "Below Active Limit" },
      ]);
    }).pipe(Effect.provide(CloudAuthApiTestContextLayer(state)));
  });
});
