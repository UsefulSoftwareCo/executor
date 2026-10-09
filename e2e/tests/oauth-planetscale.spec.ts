/** Sign in to the PlanetScale emulator, whose Doorkeeper token endpoint compares Basic credentials literally. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { randomBytes, randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { oauthMcpAppFiles } from "../support/authored-templates.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { BaseUrl, emulatorRequest, withoutEmulatorTracing } from "../support/emulators.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Tools = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });

layer(HostedLive, { excludeTestServices: true })("PlanetScale OAuth", (it) => {
  it.effect(scenarios.oauthPlanetscale.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const created = yield* emulatorRequest(
          "https://planetscale.emulators.dev",
          "/_emulate/instances",
          { instance: `scenario-${randomBytes(8).toString("hex")}` },
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ providerBaseUrl: BaseUrl }))),
        );
        const base = created.providerBaseUrl;
        yield* Effect.addFinalizer(() =>
          emulatorRequest(base, "/_emulate/reset", {}).pipe(Effect.orDie),
        );

        const name = `PlanetScale ${randomUUID().slice(0, 8)}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files: oauthMcpAppFiles(name, `${base}/mcp/planetscale`),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(Resource, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
            requirement: "service",
            profile: profile.id,
          }),
        );
        // No client is entered: Executor registers one, and PlanetScale issues IDs and secrets
        // containing `_`, which form encoding would otherwise send as `%5F`.
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/start`,
          { method: "oauth", label: "Synthetic PlanetScale account" },
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const { authorizationUrl } = yield* body(SignIn, started);
        const authorization = new URL(authorizationUrl);
        expect(`${authorization.origin}${authorization.pathname}`).toBe(`${base}/oauth/authorize`);

        // The consent page's user button posts the authorization parameters with its login.
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const consent = yield* HttpClient.withScope(http).execute(
              HttpClientRequest.post(`${base}/oauth/authorize`).pipe(
                HttpClientRequest.bodyUrlParams([
                  ...authorization.searchParams.entries(),
                  ["login", "planetscale-user"],
                ]),
              ),
            );
            expect(consent.status).toBe(302);
            const location = consent.headers.location;
            if (location === undefined)
              return yield* Effect.die("PlanetScale emulator did not return a callback");
            return location;
          }),
        ).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          // The consent request goes to the private instance's URL, which a client span would export.
          withoutEmulatorTracing,
        );

        const completed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/complete`,
          { callbackUrl },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const account = yield* body(Resource, completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );

        // The saved grant reaches PlanetScale's MCP server.
        const listed = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${app.id}/tools?profile=${profile.id}`,
        );
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const tool = (yield* body(Tools, listed)).items.find((entry) =>
          entry.name.endsWith("planetscale_list_organizations"),
        );
        expect(tool, JSON.stringify(listed.body)).toBeDefined();
        const called = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/tools/call`,
          { profile: profile.id, tool: tool?.name, input: { accountId: account.id, input: {} } },
        );
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect(JSON.stringify(called.body)).toContain("acme");
      }),
    ),
  );
});
