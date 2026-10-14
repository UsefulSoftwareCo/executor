/**
 * A token endpoint's invalid_client discards only a client Executor registered, and only the
 * saved version the failed sign-in used. Clients an administrator registered are never discarded.
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
import { scenarios } from "../test-plan.ts";
import { connectionsPath } from "../support/app-accounts.ts";

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
const DeployedApp = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Registered = Schema.Struct({ client: Schema.Struct({ id: Schema.String }) });

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
          const app = yield* body(DeployedApp, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          return app;
        });
        /** Open a connection and start its sign-in, optionally with a registered client. */
        const start = (
          app: string,
          client?: {
            readonly id: string;
            readonly clientId: string;
            readonly clientSecret: string;
          },
        ) =>
          Effect.gen(function* () {
            const connection = (yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(`${prefix}/apps/${app}`, "user", "service"),
                {},
              ),
            )).id;
            if (client !== undefined) {
              // The service knows the registered client before the user reaches it.
              const setup = yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${connection}/oauth/start`,
                { method: "oauth", label: "Saved client", client: { id: client.id } },
              );
              const redirect = yield* body(Redirect, setup);
              yield* issuer.allowClient({
                clientId: client.clientId,
                clientSecret: client.clientSecret,
                redirect: redirect.redirectUri,
              });
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
        const signIn = (app: string, client?: Parameters<typeof start>[1]) =>
          Effect.gen(function* () {
            const started = yield* start(app, client);
            return { ...started, callback: yield* consent(started.authorizationUrl) };
          });
        const registrations = issuer.metrics.pipe(Effect.map((metrics) => metrics.registrations));

        yield* issuer.configure({ registration: true, tokenError: null });
        const app = (yield* deploy).id;
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
        // The older sign-in used the discarded version. The service already refused it, so the
        // sign-in reports that without exchanging its code, even though the service would accept
        // it now, and the replacement stays.
        const exchanges = (yield* issuer.metrics).tokenExchanges;
        expect(yield* complete(older)).toBe("registered_client_rejected");
        expect((yield* issuer.metrics).tokenExchanges).toBe(exchanges);
        expect(yield* complete(yield* signIn(app))).toBe("connected");
        expect(yield* registrations).toBe(registered + 1);

        // A client an administrator registered is never discarded when the service rejects it.
        yield* issuer.configure({ registration: false });
        const manualApp = yield* deploy;
        const entered = { clientId: "entered-client", clientSecret: "synthetic-entered-secret" };
        const registeredClient = yield* body(
          Registered,
          yield* api.request(actors.owner, "POST", `${prefix}/oauth-clients`, {
            issuer: issuer.origin,
            ...entered,
          }),
        );
        const client = { ...entered, id: registeredClient.client.id };
        expect(yield* complete(yield* signIn(manualApp.id, client))).toBe("connected");
        yield* issuer.configure({ tokenError: rejected });
        expect(yield* complete(yield* signIn(manualApp.id, client))).toBe("invalid_client");
        yield* issuer.configure({ tokenError: null });
        expect(yield* complete(yield* signIn(manualApp.id, client))).toBe("connected");
        expect(yield* registrations).toBe(registered + 1);
      }),
    ),
  );
});
