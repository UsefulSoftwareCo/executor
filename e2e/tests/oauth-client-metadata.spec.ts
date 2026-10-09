/**
 * A host that publishes an OAuth Client ID Metadata Document signs in to a server that accepts
 * one without registering a client, and still registers with a server that does not. Turning
 * the setting on keeps the clients owners already have.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { clientMetadataIssuer } from "../support/client-metadata-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { oauthMcpAppFiles } from "../support/authored-templates.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { oauthRelayCallback as configuredCallback, scenarios } from "../test-plan.ts";

/** The address the scenario's operator setting publishes; the issuer maps it to the product. */
const publicOrigin = "https://executor.example";
const documentPath = "/oauth/client-metadata.json";
const clientId = `${publicOrigin}${documentPath}`;
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Setup = Schema.Struct({ mode: Schema.String });

/** Deploy an MCP app whose service signs in on the issuer. */
const deployApp = (issuerOrigin: string, name: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const label = `${name} ${randomUUID().slice(0, 8)}`;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: label,
      files: oauthMcpAppFiles(label, `${issuerOrigin}/mcp`),
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(
      Schema.Struct({
        ...Resource.fields,
        requirements: Schema.Struct({
          accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
        }),
      }),
      deployed,
    );
    yield* Effect.addFinalizer(() =>
      api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
    );
    return { prefix, id: app.id, provider: app.requirements.accounts.service.provider };
  });
type App = Effect.Success<ReturnType<typeof deployApp>>;

/** How the connection form will get a client for the app's service. */
const setupMode = (app: App) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const setup = yield* api.request(
      actors.owner,
      "GET",
      `${app.prefix}/providers/${app.provider}/oauth/oauth/setup`,
    );
    expect(setup.status).toBe(200);
    return (yield* body(Setup, setup)).mode;
  });

/** Start a new connection's sign-in through the hosted API. */
const startSignIn = (app: App) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const profile = yield* createProfile(actors.owner, `${app.prefix}/apps/${app.id}`);
    const connection = yield* body(
      Resource,
      yield* api.request(actors.owner, "POST", `${app.prefix}/apps/${app.id}/connections`, {
        requirement: "service",
        profile: profile.id,
      }),
    );
    const started = yield* api.request(
      actors.owner,
      "POST",
      `${app.prefix}/connections/${connection.id}/oauth/start`,
      { method: "oauth", label: "Synthetic metadata account" },
    );
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const authorization = new URL((yield* body(SignIn, started)).authorizationUrl);
    return {
      authorization,
      complete: `${app.prefix}/connections/${connection.id}/oauth/complete`,
    };
  });

/** Follow the authorization request as the user's browser would, without following the callback. */
const authorize = (url: URL) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* HttpClient.withScope(http).get(url);
    return { status: response.status, location: response.headers.location };
  }).pipe(
    Effect.scoped,
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

/** Consent and complete a started sign-in; the account is deleted when the scenario ends. */
const finishSignIn = (signIn: Effect.Success<ReturnType<typeof startSignIn>>) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const consent = yield* authorize(signIn.authorization);
    expect(consent.status).toBe(302);
    const completed = yield* api.request(actors.owner, "POST", signIn.complete, {
      callbackUrl: consent.location,
    });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    const account = yield* body(Resource, completed);
    yield* Effect.addFinalizer(() =>
      api
        .request(
          actors.owner,
          "DELETE",
          `/api/organizations/${actors.organization.id}/accounts/${account.id}`,
        )
        .pipe(Effect.orDie),
    );
    return account;
  });

/** Fetch a product path without a session, as an authorization server does. */
const fetchProduct = (path: string, method: "GET" | "POST" = "GET") =>
  Effect.gen(function* () {
    const target = yield* Target,
      http = yield* HttpClient.HttpClient;
    const url = new URL(path, target.metadata.origin);
    const response = yield* HttpClient.withScope(http).execute(
      method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url),
    );
    return { status: response.status, headers: response.headers, text: yield* response.text };
  }).pipe(
    Effect.scoped,
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

layer(HostedLive, { excludeTestServices: true })("OAuth client metadata document", (it) => {
  it.effect(scenarios.oauthClientMetadataDocument.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target;
        const issuer = yield* clientMetadataIssuer({
          publicOrigins: { [publicOrigin]: target.metadata.origin },
        });

        const app = yield* deployApp(issuer.origin, "Metadata client");
        expect(yield* setupMode(app), "the client is available without user input").toBe(
          "automatic",
        );
        const { authorization, complete } = yield* startSignIn(app);
        expect((yield* issuer.metrics).registrations, "setup and start register nothing").toEqual(
          [],
        );
        expect(authorization.searchParams.get("client_id"), "the document is the client ID").toBe(
          clientId,
        );
        // The operator's callback, serialized as a URL: the form the host sends and lists.
        const redirectUri = authorization.searchParams.get("redirect_uri");
        expect(redirectUri).toBe(new URL(configuredCallback).href);
        expect(redirectUri).not.toBe(configuredCallback);

        // The document, exactly, as the authorization server reads it from the product.
        const served = yield* fetchProduct(documentPath);
        expect(served.status).toBe(200);
        expect(served.headers["content-type"]).toMatch(/^application\/json(;|$)/);
        expect(served.headers["cache-control"]).toBe("public, max-age=300");
        expect(JSON.parse(served.text)).toEqual({
          client_id: clientId,
          client_name: "Executor",
          client_uri: publicOrigin,
          logo_uri: `${publicOrigin}/favicon.png`,
          // The callback the host sends, so the two cannot drift.
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          application_type: "web",
        });
        expect(
          (yield* fetchProduct(documentPath, "POST")).status,
          "the document is read-only",
        ).not.toBe(200);

        // The server holds the redirect URI to the document.
        const foreign = new URL(authorization);
        foreign.searchParams.set("redirect_uri", "https://attacker.example/callback");
        expect((yield* authorize(foreign)).status).toBe(400);
        expect((yield* issuer.metrics).refusals).toEqual(["redirect_uri"]);

        const consent = yield* authorize(authorization);
        expect(consent.status, JSON.stringify(yield* issuer.metrics)).toBe(302);
        const metrics = yield* issuer.metrics;
        expect(metrics.fetches.at(-1)).toEqual({
          url: clientId,
          status: 200,
          cacheControl: "public, max-age=300",
        });
        expect(metrics.logos, "the logo resolves on the published origin").toEqual([
          { url: `${publicOrigin}/favicon.png`, status: 200, contentType: "image/png" },
          { url: `${publicOrigin}/favicon.png`, status: 200, contentType: "image/png" },
        ]);
        expect(metrics.authorizations).toEqual([{ clientId, redirectUri, client: "document" }]);

        const completed = yield* api.request(actors.owner, "POST", complete, {
          callbackUrl: consent.location,
        });
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const account = yield* body(Resource, completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(
              actors.owner,
              "DELETE",
              `/api/organizations/${actors.organization.id}/accounts/${account.id}`,
            )
            .pipe(Effect.orDie),
        );
        const signedIn = yield* issuer.metrics;
        expect(signedIn.exchanges, "a public client exchanged the code").toEqual([
          { clientId, clientAuthentication: false, issued: true },
        ]);
        expect(signedIn.registrations, "no dynamic registration at any point").toEqual([]);
        expect(yield* setupMode(app), "a document client is not saved").toBe("automatic");

        // A server without document support still gets a registered client.
        yield* issuer.configure({ documents: false });
        const registered = yield* startSignIn(yield* deployApp(issuer.origin, "Registered client"));
        const registeredClient = registered.authorization.searchParams.get("client_id");
        expect(registeredClient).toBe("registered-client-1");
        expect((yield* issuer.metrics).registrations).toEqual([{ redirectUris: [redirectUri] }]);
        yield* finishSignIn(registered);
        const final = yield* issuer.metrics;
        expect(final.fetches, "the registered client needed no document").toHaveLength(2);
        expect(final.exchanges.at(-1)).toEqual({
          clientId: "registered-client-1",
          clientAuthentication: false,
          issued: true,
        });
      }),
    ),
  );

  it.effect(scenarios.oauthClientMetadataEnabled.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const issuer = yield* clientMetadataIssuer({
          publicOrigins: { [publicOrigin]: target.metadata.origin },
        });
        // Without the setting the host registers, even where documents are accepted.
        const existing = yield* deployApp(issuer.origin, "Existing client");
        yield* finishSignIn(yield* startSignIn(existing));
        expect((yield* issuer.metrics).registrations).toHaveLength(1);
        expect(yield* setupMode(existing)).toBe("saved");

        // The operator turns the setting on, as Cloud's deploy does.
        yield* serverControl("stop");
        yield* serverControl("environment", 200, { EXECUTOR_OAUTH_CLIENT_METADATA_URL: clientId });
        yield* serverControl("start");
        expect((yield* fetchProduct(documentPath)).status, "the document is now served").toBe(200);

        // A server without document support keeps the client registered before.
        yield* issuer.configure({ documents: false });
        expect(yield* setupMode(existing), "the registered client is still saved").toBe("saved");
        const kept = yield* startSignIn(existing);
        expect(kept.authorization.searchParams.get("client_id")).toBe("registered-client-1");
        yield* finishSignIn(kept);

        // A saved client is used before the document, also where the server accepts documents.
        yield* issuer.configure({ documents: true });
        expect(yield* setupMode(existing)).toBe("saved");
        const preferred = yield* startSignIn(existing);
        expect(preferred.authorization.searchParams.get("client_id")).toBe("registered-client-1");
        yield* finishSignIn(preferred);

        // An owner without a client for a service uses the document.
        const added = yield* startSignIn(yield* deployApp(issuer.origin, "New client"));
        expect(added.authorization.searchParams.get("client_id")).toBe(clientId);
        yield* finishSignIn(added);
        const metrics = yield* issuer.metrics;
        expect(metrics.registrations, "no owner registered again").toHaveLength(1);
        expect(metrics.authorizations.map((entry) => entry.client)).toEqual([
          "registered",
          "registered",
          "registered",
          "document",
        ]);
      }),
    ),
  );

  it.effect(scenarios.oauthClientMetadataUnset.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const issuer = yield* clientMetadataIssuer({
          publicOrigins: { [publicOrigin]: target.metadata.origin },
        });
        expect((yield* fetchProduct(documentPath)).status, "no document is published").toBe(404);
        const { authorization } = yield* startSignIn(
          yield* deployApp(issuer.origin, "Unset metadata client"),
        );
        expect(authorization.searchParams.get("client_id")).toBe("registered-client-1");
        const metrics = yield* issuer.metrics;
        expect(metrics.registrations).toHaveLength(1);
        expect(metrics.fetches).toEqual([]);
      }),
    ),
  );
});
