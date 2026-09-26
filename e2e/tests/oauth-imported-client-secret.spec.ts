/** Imported OpenAPI apps with fixed OAuth endpoints must ask for a client secret. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { oauthRecoveryIssuer, recoveryClients } from "../support/oauth-recovery-issuer.ts";
import { scenarios } from "../test-plan.ts";

/** Serve an OpenAPI spec that points its OAuth flow at the test issuer. */
const openApiUpstream = (issuer: string) =>
  Effect.gen(function* () {
    const routes = HttpRouter.add(
      "GET",
      "/openapi.json",
      HttpServerResponse.json({
        openapi: "3.0.3",
        info: { title: "Fixed OAuth fixture", version: "1" },
        components: {
          securitySchemes: {
            oauth: {
              type: "oauth2",
              flows: {
                authorizationCode: {
                  authorizationUrl: `${issuer}/authorize`,
                  tokenUrl: `${issuer}/token`,
                  scopes: { read: "Read" },
                },
              },
            },
          },
        },
        security: [{ oauth: ["read"] }],
        paths: {
          "/identity": {
            get: {
              operationId: "identity",
              responses: {
                "200": { description: "OK", content: { "application/json": { schema: {} } } },
              },
            },
          },
        },
      }),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
    return `http://127.0.0.1:${server.address.port}`;
  });

layer(HostedLive, { excludeTestServices: true })("Imported OAuth client secret", (it) => {
  it.effect(scenarios.oauthImportedClientSecret.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target;
        const issuer = yield* oauthRecoveryIssuer(target.metadata.origin);
        const upstream = yield* openApiUpstream(issuer.origin);
        const prefix = `/api/organizations/${actors.organization.id}`;
        const name = `Fixed OAuth ${randomUUID().slice(0, 8)}`;
        const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
          source: {
            kind: "openapi",
            name,
            url: `${upstream}/openapi.json`,
            baseUrl: upstream,
          },
        });
        expect(imported.status, JSON.stringify(imported.body)).toBe(200);
        const app = yield* body(App, imported);
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
            for (const id of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
          }).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Open the imported app's accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Choose an account for the app", (page) =>
          page.getByRole("button", { name: `Add ${name} account`, exact: true }).click(),
        );
        const redirectUri = yield* Schema.decodeUnknownEffect(Schema.String)(
          yield* browser.use("Copy the redirect URL into the provider", (page) =>
            page.getByRole("dialog").getByText("/api/oauth/callback").textContent(),
          ),
        );
        yield* issuer.registerCallback(redirectUri);
        yield* browser.use("The client form asks for both client credentials", (page) =>
          page
            .getByLabel("Client secret", { exact: true })
            .waitFor({ state: "visible" })
            .then(() => page.getByLabel("Account name", { exact: true }).fill("Imported account"))
            .then(() =>
              page.getByLabel("Client ID", { exact: true }).fill(recoveryClients.original.clientId),
            )
            .then(() =>
              page
                .getByLabel("Client secret", { exact: true })
                .fill(recoveryClients.original.clientSecret),
            ),
        );
        yield* browser.checkpoint("Imported OAuth client form");
        yield* browser.use("Sign in and return through the callback", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: `Connect ${name}`, exact: true })
            .click()
            .then(() =>
              page
                .getByRole("link", { name: "Imported account", exact: true })
                .waitFor({ state: "visible" }),
            ),
        );
        const tokens = yield* issuer.observations;
        expect(tokens).toEqual([
          { authorization: true, original: true, replacement: false, tokenAccepted: true },
        ]);
        const profile = yield* Schema.decodeUnknownEffect(Schema.String)(
          yield* browser.use("Read the selected account setup", (page) =>
            page.evaluate(() => new URL(location.href).searchParams.get("profile")),
          ),
        );
        const bound = yield* body(
          Schema.Struct({ accounts: Schema.Struct({ service: Schema.Array(Schema.String) }) }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/profiles/${profile}`),
        );
        accounts.push(...bound.accounts.service);
        expect(bound.accounts.service).toHaveLength(1);
      }),
    ),
  );
});
