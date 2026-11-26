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
        expect(hosts.browser).not.toBe(hosts.deployment);
        expect(accountSetup.redirectUri).toBe(`${hosts.edge}/api/oauth/callback`);

        const query = "?state=x2.synthetic-state&code=single-use";
        const finished = yield* rawRequest(`${hosts.deployment}/api/oauth/callback${query}`);
        expect(finished.status).toBe(302);
        expect(finished.location).toBe(`${hosts.browser}/oauth/callback${query}`);
        const old = "?state=existing-state&code=single-use";
        const kept = yield* rawRequest(`${hosts.deployment}/api/oauth/callback${old}`);
        expect(kept.status).toBe(302);
        expect(kept.location).toBe(`${hosts.browser}/oauth/callback${old}`);

        const bounced = yield* rawRequest(`${hosts.edge}/api/oauth/callback${query}`);
        expect(bounced.status).toBe(302);
        expect(bounced.location).toBe(`${hosts.browser}/oauth/callback${query}`);
        expect(bounced.cacheControl).toBe("no-store");
        const v1Started = yield* rawRequest(
          `${hosts.edge}/api/oauth/callback?state=v1-state&code=c`,
        );
        expect(v1Started.status).toBe(410);
        expect(v1Started.text).toContain("This sign-in started in Executor v1");
      }),
    ),
  );
});
