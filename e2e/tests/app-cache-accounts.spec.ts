import { expect, layer } from "@effect/vitest";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { Effect } from "effect";
import { body } from "../support/api.ts";
import { Resource } from "../support/contracts.ts";
import { cacheApp } from "../support/cache-app.ts";
import { connectionsPath, linkedAccountIds, unlinkAccount } from "../support/app-accounts.ts";

layer(HostedLive, { excludeTestServices: true })("App caching", (it) => {
  it.effect(scenarios.appCacheAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, request, call } = yield* cacheApp;
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
            yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {}),
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
          yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {
            account: one,
          }),
        );
        expect((yield* submit(reconnect.id, "synthetic-rotated")).status).toBe(200);
        const rotated = yield* call("private", { id: one });
        expect(rotated).not.toBe(privateValue);
        // A call cannot reach the scope of an account it does not use: once unlinked, the
        // account's scope is out of reach, though the account stays saved.
        yield* unlinkAccount(actors.owner, path, "service", two);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([one, large]);
        expect((yield* request("private", { id: two })).status).toBeGreaterThanOrEqual(400);
        expect(yield* call("private", { id: one })).toBe(rotated);
      }),
    ),
  );
});
