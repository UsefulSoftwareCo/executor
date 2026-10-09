/**
 * Connected-account sign-ins return to the deployment origin's callback (`v2.executor.sh`), which
 * every registered OAuth client names, and finish on the browser origin's callback page. The
 * edge's callback (standing in for `executor.sh`), which v1 forwards only for v2's state prefix,
 * is ready for the later move.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { rawRequest, targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Cloud account callback", (it) => {
  it.effect(scenarios.cloudAccountCallback.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target;
        const hosts = targetHosts(target);
        const inventory = yield* api.request(
          actors.owner,
          "GET",
          `/api/organizations/${actors.organization.id}/inventory`,
        );
        expect(inventory.status).toBe(200);
        const { accountSetup } = yield* body(
          Schema.Struct({ accountSetup: Schema.Struct({ redirectUri: Schema.String }) }),
          inventory,
        );
        // Providers, the client metadata document and dynamic registration are all given this
        // one callback, on the deployment origin, for every new sign-in.
        expect(hosts.browser).not.toBe(hosts.deployment);
        expect(accountSetup.redirectUri).toBe(`${hosts.deployment}/api/oauth/callback`);

        // A new sign-in's return, query intact, opens the browser origin's callback page.
        const query = "?state=x2.synthetic-state&code=single-use";
        const finished = yield* rawRequest(`${hosts.deployment}/api/oauth/callback${query}`);
        expect(finished.status).toBe(302);
        expect(finished.location).toBe(`${hosts.browser}/oauth/callback${query}`);
        // So does one that started before the state prefix.
        const old = "?state=existing-state&code=single-use";
        const kept = yield* rawRequest(`${hosts.deployment}/api/oauth/callback${old}`);
        expect(kept.status).toBe(302);
        expect(kept.location).toBe(`${hosts.browser}/oauth/callback${old}`);

        // The edge sends v2's callbacks the same way, ready for the move to `executor.sh`.
        const bounced = yield* rawRequest(`${hosts.edge}/api/oauth/callback${query}`);
        expect(bounced.status).toBe(302);
        expect(bounced.location).toBe(`${hosts.browser}/oauth/callback${query}`);
        expect(bounced.cacheControl).toBe("no-store");
        // A callback without v2's prefix belongs to v1, which never forwards it.
        expect(
          (yield* rawRequest(`${hosts.edge}/api/oauth/callback?state=v1-state&code=c`)).status,
        ).toBe(404);
      }),
    ),
  );
});
