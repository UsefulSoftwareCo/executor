import { expect, layer } from "@effect/vitest";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { Effect } from "effect";
import { body } from "../support/api.ts";
import { Resource } from "../support/contracts.ts";
import { cacheApp } from "../support/cache-app.ts";

layer(HostedLive, { excludeTestServices: true })("App caching", (it) => {
  it.effect(scenarios.appCacheAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, first, second, request, call } = yield* cacheApp;
        const accountIds: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(accountIds, (id) =>
            api.request(
              actors.owner,
              "DELETE",
              `/api/organizations/${actors.organization.id}/accounts/${id}`,
            ),
          ).pipe(Effect.orDie),
        );
        const submit = (id: string, token: string) =>
          api.request(
            actors.owner,
            "POST",
            `/api/organizations/${actors.organization.id}/connections/${id}/submit`,
            { method: "key", label: "Synthetic cache scope", fields: { token } },
          );
        // The third token alone exceeds the cache's 8 KB key limit, like a large OAuth grant.
        const largeToken = `synthetic-large-${"x".repeat(9000)}`;
        for (const token of ["synthetic-cache-a", "synthetic-cache-b", largeToken]) {
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${path}/connections`, {
              requirement: "service",
              profile: first.id,
            }),
          );
          const account = yield* body(Resource, yield* submit(connection.id, token));
          accountIds.push(account.id);
        }
        const [one, two, large] = accountIds;
        if (one === undefined || two === undefined || large === undefined)
          return yield* Effect.die("Expected three accounts");
        // Account scopes hold the account's identity, never its credentials.
        const largeValue = yield* call("private", { id: large });
        expect(yield* call("private", { id: large })).toBe(largeValue);
        const privateValue = yield* call("private", { id: one });
        expect(yield* call("private", { id: one })).toBe(privateValue);
        expect(yield* call("private", { id: two })).not.toBe(privateValue);
        const reconnect = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/connections`, {
            requirement: "service",
            profile: first.id,
            account: one,
          }),
        );
        expect((yield* submit(reconnect.id, "synthetic-rotated")).status).toBe(200);
        expect(yield* call("private", { id: one })).not.toBe(privateValue);
        expect((yield* request("private", { id: two }, second.id)).status).toBeGreaterThanOrEqual(
          400,
        );
      }),
    ),
  );
});
