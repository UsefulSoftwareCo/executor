/** Import is offline; account setup consumes the challenge on the actual MCP response. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("MCP auth discovery", (it) => {
  it.effect(scenarios.mcpAuthDiscovery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        for (const postChallenge of [true, false]) {
          yield* issuer.configure({ postChallenge });
          const probes = (yield* issuer.metrics).probes;
          const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
            source: {
              kind: "mcp",
              name: `Discovery ${randomUUID().slice(0, 8)}`,
              url: `${issuer.origin}/mcp`,
              auth: { type: "auto" },
            },
          });
          expect(response.status, "Import saves the app without contacting the server").toBe(200);
          expect((yield* issuer.metrics).probes).toBe(probes);
          const app = yield* body(Resource, response);
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
          const start = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/start`,
            {
              method: "oauth",
              label: "Synthetic discovery account",
            },
          );
          expect(start.status, "Sign-in follows the advertised nonstandard metadata path").toBe(
            200,
          );
          const signIn = yield* body(Schema.Struct({ authorizationUrl: Schema.String }), start);
          expect(new URL(signIn.authorizationUrl).pathname).toBe("/authorize");
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/cancel`,
            {},
          );
        }
        expect((yield* issuer.metrics).probes).toBeGreaterThanOrEqual(2);
        yield* issuer.configure({ postChallenge: true, challenge: false });
        const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
          source: {
            kind: "mcp",
            name: `No challenge ${randomUUID().slice(0, 8)}`,
            url: `${issuer.origin}/mcp`,
            auth: { type: "auto" },
          },
        });
        expect(imported.status).toBe(200);
        const unresolved = yield* body(Resource, imported);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${unresolved.id}`).pipe(Effect.orDie),
        );
        const saved = yield* body(
          Schema.Struct({
            requirements: Schema.Struct({ accounts: Schema.Record(Schema.String, Schema.Unknown) }),
          }),
          imported,
        );
        expect(Object.keys(saved.requirements.accounts)).toEqual(["service"]);
      }),
    ),
  );
});
