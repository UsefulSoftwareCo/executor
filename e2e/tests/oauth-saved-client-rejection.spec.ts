/**
 * A token endpoint's invalid_client discards only a client Executor registered, and only the
 * saved version the failed sign-in used. Clients the user entered are never discarded.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { oauthMcpAppFiles } from "../support/authored-templates.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});
const Failure = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
const rejected = { status: 401, body: { error: "invalid_client" } } as const;

layer(HostedLive, { excludeTestServices: true })("OAuth saved client rejection", (it) => {
  it.effect(scenarios.oauthSavedClientRejection.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deploy = Effect.gen(function* () {
          const name = `Saved client ${randomUUID().slice(0, 8)}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name,
            files: oauthMcpAppFiles(name, `${issuer.origin}/mcp`),
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(Resource, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          return app.id;
        });
        /** Open a connection and start its sign-in, optionally with a client the user entered. */
        const start = (
          app: string,
          client?: { readonly clientId: string; readonly clientSecret: string },
        ) =>
          Effect.gen(function* () {
            const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app}`);
            const connection = (yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${app}/connections`, {
                requirement: "service",
                profile: profile.id,
              }),
            )).id;
            if (client !== undefined) {
              // The service knows the entered client before the user reaches it.
              const setup = yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${connection}/oauth/start`,
                { method: "oauth", label: "Saved client", client },
              );
              const redirect = yield* body(Redirect, setup);
              yield* issuer.allowClient({ ...client, redirect: redirect.redirectUri });
              return { connection, authorizationUrl: redirect.authorizationUrl };
            }
            const response = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection}/oauth/start`,
              { method: "oauth", label: "Saved client" },
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return {
              connection,
              authorizationUrl: (yield* body(Redirect, response)).authorizationUrl,
            };
          });
        const consent = (authorizationUrl: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const response = yield* HttpClient.withScope(http).get(authorizationUrl);
              expect(response.status).toBe(302);
              const location = response.headers.location;
              if (location === undefined)
                return yield* Effect.die("Issuer did not return a callback");
              return location;
            }),
          ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        /** Complete a started sign-in and return its failure reason, or "connected". */
        const complete = (started: { readonly connection: string; readonly callback: string }) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${started.connection}/oauth/complete`,
              { callbackUrl: started.callback },
            );
            if (response.status === 200) return "connected";
            expect(response.status, JSON.stringify(response.body)).toBe(400);
            return (yield* body(Failure, response)).reason;
          });
        const signIn = (app: string) =>
          Effect.gen(function* () {
            const started = yield* start(app);
            return { ...started, callback: yield* consent(started.authorizationUrl) };
          });
        const registrations = issuer.metrics.pipe(Effect.map((metrics) => metrics.registrations));

        yield* issuer.configure({ registration: true, tokenError: null });
        const app = yield* deploy;
        // The first sign-in registers a client and saves it.
        expect(yield* complete(yield* signIn(app))).toBe("connected");
        const registered = yield* registrations;

        // Two sign-ins reuse that saved client.
        const older = yield* signIn(app);
        const newer = yield* signIn(app);
        expect(yield* registrations).toBe(registered);
        yield* issuer.configure({ tokenError: rejected });
        expect(yield* complete(newer)).toBe("registered_client_rejected");
        // The rejected client was discarded, so the next sign-in registers a replacement.
        yield* issuer.configure({ tokenError: null });
        yield* signIn(app);
        expect(yield* registrations).toBe(registered + 1);
        // The older sign-in used the discarded version; its rejection keeps the replacement.
        yield* issuer.configure({ tokenError: rejected });
        expect(yield* complete(older)).toBe("registered_client_rejected");
        yield* issuer.configure({ tokenError: null });
        expect(yield* complete(yield* signIn(app))).toBe("connected");
        expect(yield* registrations).toBe(registered + 1);

        // A client the user entered is saved after it connects and is never discarded.
        yield* issuer.configure({ registration: false });
        const manualApp = yield* deploy;
        const client = { clientId: "entered-client", clientSecret: "synthetic-entered-secret" };
        const manual = yield* start(manualApp, client);
        expect(
          yield* complete({ ...manual, callback: yield* consent(manual.authorizationUrl) }),
        ).toBe("connected");
        yield* issuer.configure({ tokenError: rejected });
        expect(yield* complete(yield* signIn(manualApp))).toBe("invalid_client");
        yield* issuer.configure({ tokenError: null });
        expect(yield* complete(yield* signIn(manualApp))).toBe("connected");
        expect(yield* registrations).toBe(registered + 1);
      }),
    ),
  );
});
