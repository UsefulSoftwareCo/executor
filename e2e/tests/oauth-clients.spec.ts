/**
 * OAuth sign-in clients are the organization's resources. Administrators register them, each has
 * an audience, and every connection names the client it signs in with; nothing is reused because
 * an owner happened to connect before. Client credentials are each account's own.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { oauthMcpAppFiles } from "../support/authored-templates.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { clientCredentialsIssuer, machineClient } from "../support/client-credentials-issuer.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";
import { connectionsPath } from "../support/app-accounts.ts";

const DeployedApp = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Options = Schema.Struct({
  mode: Schema.Literals(["automatic", "client-required"]),
  clients: Schema.Array(Schema.Struct({ id: Schema.String, clientId: Schema.String })),
});
const Audience = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["private", "everyone"]) }),
  Schema.Struct({ kind: Schema.Literal("groups"), groups: Schema.Array(Schema.String) }),
]);
const Directory = Schema.Struct({
  clients: Schema.Array(
    Schema.Struct({
      client: Schema.Struct({ id: Schema.String, clientId: Schema.String, source: Schema.String }),
      access: Schema.Struct({ revision: Schema.String, audience: Audience }),
    }),
  ),
});
const Registered = Schema.Struct({
  client: Schema.Struct({ id: Schema.String, clientId: Schema.String, hasSecret: Schema.Boolean }),
  access: Schema.Struct({ revision: Schema.String, audience: Audience }),
});
const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  account: Schema.Struct({ id: Schema.String }),
});
const Tagged = Schema.Struct({ _tag: Schema.String });
const CompletionFailure = Schema.Struct({ _tag: Schema.String, reason: Schema.String });
const Members = Schema.Struct({
  members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
});
const Ownership = Schema.Struct({ ownership: Schema.Struct({ kind: Schema.String }) });

/** Synthetic client details the loopback service accepts once allowed. */
const teamClient = { clientId: "synthetic-team-client", clientSecret: "synthetic-team-secret" };
const restrictedClient = {
  clientId: "synthetic-restricted-client",
  clientSecret: "synthetic-restricted-secret",
};
const groupClient = { clientId: "synthetic-group-client", clientSecret: "synthetic-group-secret" };
const editedClient = { clientId: "synthetic-edit-before", clientSecret: "synthetic-edit-old" };
const replacementClient = {
  clientId: "synthetic-edit-after",
  clientSecret: "synthetic-edit-new",
};
const recheckedClient = {
  clientId: "synthetic-recheck-client",
  clientSecret: "synthetic-recheck-secret",
};

layer(HostedLive, { excludeTestServices: true })("OAuth clients", (it) => {
  /** Shared steps over the organization's HTTP API for the browser sign-in scenarios. */
  const organizationOAuth = Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      http = yield* HttpClient.HttpClient;
    const issuer = yield* oauthSetupIssuer;
    const prefix = `/api/organizations/${actors.organization.id}`;
    // Only registered or entered clients can sign in: the service offers no registration.
    yield* issuer.configure({ registration: false, tokenError: null });
    /** An app every member may use, whose provider signs in through the loopback service. */
    const deploy = Effect.gen(function* () {
      const name = `OAuth clients ${randomUUID().slice(0, 8)}`;
      const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name,
        files: oauthMcpAppFiles(name, `${issuer.origin}/mcp`),
      });
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
      const app = yield* body(DeployedApp, deployed);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      const access = yield* body(
        Schema.Struct({ revision: Schema.String }),
        yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
      );
      const shared = yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
        audience: { kind: "everyone" },
        revision: access.revision,
      });
      expect(shared.status, JSON.stringify(shared.body)).toBe(200);
      // The provider is named after the app.
      return { id: app.id, name, provider: app.requirements.accounts.service.provider };
    });
    const options = (actor: Session, provider: string) =>
      api
        .request(actor, "GET", `${prefix}/providers/${provider}/oauth/oauth/setup`)
        .pipe(Effect.flatMap((response) => body(Options, response)));
    /**
     * A personal connection from the app, which links the saved account to it for the actor, or
     * one that replaces an existing account's credentials.
     */
    const connection = (actor: Session, app: string, account?: string) =>
      Effect.gen(function* () {
        return (yield* body(
          Resource,
          yield* api.request(
            actor,
            "POST",
            connectionsPath(`${prefix}/apps/${app}`, "user", "service"),
            account === undefined ? {} : { account },
          ),
        )).id;
      });
    const start = (actor: Session, connection: string, client?: unknown) =>
      api.request(actor, "POST", `${prefix}/connections/${connection}/oauth/start`, {
        method: "oauth",
        ...(client === undefined ? {} : { client }),
      });
    /** Approve the sign-in at the service and return to Executor's callback. */
    const consent = (authorizationUrl: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const response = yield* HttpClient.withScope(http).get(authorizationUrl);
          expect(response.status).toBe(302);
          const location = response.headers.location;
          if (location === undefined) return yield* Effect.die("Issuer did not return a callback");
          return location;
        }),
      ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    const complete = (actor: Session, connection: string, callbackUrl: string) =>
      api.request(actor, "POST", `${prefix}/connections/${connection}/oauth/complete`, {
        callbackUrl,
      });
    /**
     * Other scenarios' apps may be installed too, so the service is always chosen. A service is
     * the server the app signs in at, listed with every app that signs in there.
     */
    const chooseService = (page: Page, name: string) =>
      page
        .getByRole("form", { name: "Register OAuth client" })
        .getByRole("combobox", { name: "Service", exact: true })
        .click()
        .then(() => page.getByRole("option").filter({ hasText: name }).click());
    return {
      api,
      actors,
      issuer,
      prefix,
      deploy,
      options,
      connection,
      start,
      consent,
      complete,
      chooseService,
    };
  });

  it.effect(scenarios.oauthClientRegistration.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          issuer,
          prefix,
          deploy,
          options,
          connection,
          start,
          consent,
          complete,
          chooseService,
        } = yield* organizationOAuth;
        const browser = yield* Browser;
        const app = yield* deploy;
        // Members cannot register clients through the API, and the account list offers them no manager.
        expect(
          (yield* api.request(actors.member, "POST", `${prefix}/oauth-clients`, {
            issuer: issuer.origin,
            ...teamClient,
          })).status,
        ).toBe(403);
        expect((yield* api.request(actors.member, "GET", `${prefix}/oauth-clients`)).status).toBe(
          403,
        );
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.admin);
        yield* browser.use("Open accounts as an administrator", (page) =>
          page.goto(`/org/${actors.organization.slug}/accounts`),
        );
        yield* browser.use("Open the OAuth client manager", (page) =>
          page.getByRole("button", { name: "OAuth clients", exact: true }).click(),
        );
        yield* browser.use("Start registering a client", (page) =>
          page
            .getByRole("dialog", { name: "OAuth clients" })
            .getByRole("button", { name: "Register client", exact: true })
            .click(),
        );
        // A client is not named, and everyone in the organization may use it unless chosen otherwise.
        yield* browser.use("Everyone may use a new client by default", (page) =>
          page
            .getByRole("form", { name: "Register OAuth client" })
            .getByRole("combobox", { name: "Who can use this client?", exact: true })
            .filter({ hasText: "Everyone in the organization" })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Registering asks for no client name", (page) =>
            page
              .getByRole("form", { name: "Register OAuth client" })
              .getByLabel("Name", { exact: true })
              .count(),
          ),
        ).toBe(0);
        yield* browser.use("Enter the client from the service's developer settings", (page) =>
          chooseService(page, app.name)
            .then(() => page.getByLabel("Client ID", { exact: true }).fill(teamClient.clientId))
            .then(() =>
              page
                .getByLabel("Client secret (optional)", { exact: true })
                .fill(teamClient.clientSecret),
            ),
        );
        yield* browser.checkpoint("Register OAuth client");
        yield* browser.use("Register the client", (page) =>
          page
            .getByRole("button", { name: "Register", exact: true })
            .click()
            .then(() =>
              page
                .getByRole("list", { name: "OAuth clients" })
                .getByText(teamClient.clientId, { exact: true })
                .waitFor({ state: "visible" }),
            ),
        );
        yield* browser.checkpoint("Registered OAuth clients");
        const listed = yield* api.request(actors.admin, "GET", `${prefix}/oauth-clients`);
        // The secret is write-only.
        expect(JSON.stringify(listed.body)).not.toContain(teamClient.clientSecret);
        const registered = (yield* body(Directory, listed)).clients.find(
          (entry) => entry.client.clientId === teamClient.clientId,
        );
        if (registered === undefined) return yield* Effect.die("The registered client is missing");
        expect(registered.access.audience).toEqual({ kind: "everyone" });

        // A member is offered the client for their own account, and signs in with it.
        expect(yield* options(actors.member, app.provider)).toEqual({
          mode: "client-required",
          clients: [{ id: registered.client.id, clientId: teamClient.clientId }],
        });
        yield* browser.login(actors.member);
        yield* browser.use("Open accounts as a member", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/accounts`)
            // The heading shows the account count once the list has loaded.
            .then(() => page.getByRole("heading", { name: /^Accounts\s*\d+$/ }).waitFor()),
        );
        expect(
          yield* browser.use("Members have no OAuth client manager", (page) =>
            page.getByRole("button", { name: "OAuth clients", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.use("Open the app as a member", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Open the connect form", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        // With one client to sign in with there is nothing to choose: the form uses it, and keeps
        // the choice, with entering details, under Advanced.
        expect(
          yield* browser.use("A single registered client is not offered as a choice", (page) =>
            page
              .getByRole("dialog")
              .getByRole("button", { name: "Connect " + app.name, exact: true })
              .waitFor({ state: "visible" })
              .then(() =>
                page.getByRole("dialog").getByRole("combobox", { name: "OAuth client" }).count(),
              ),
          ),
        ).toBe(0);
        yield* browser.use("Advanced shows the registered client is used", (page) =>
          page
            .getByRole("dialog")
            .getByText("Advanced", { exact: true })
            .click()
            .then(() =>
              page
                .getByRole("dialog")
                .getByRole("combobox", { name: "OAuth client" })
                .filter({ hasText: teamClient.clientId })
                .waitFor({ state: "visible" }),
            ),
        );
        expect(
          yield* browser.use("A registered client asks for no client details", (page) =>
            page.getByRole("dialog").getByLabel("Client ID", { exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.use("Let the dialog finish opening", (page) =>
          page.waitForFunction(() =>
            document.getAnimations().every((animation) => animation.playState !== "running"),
          ),
        );
        yield* browser.checkpoint("Member connect form with a registered client");
        yield* browser.use("Close the connect form", (page) =>
          page.getByRole("button", { name: "Close", exact: true }).click(),
        );
        const personal = yield* connection(actors.member, app.id);
        const started = yield* body(
          Redirect,
          yield* start(actors.member, personal, { id: registered.client.id }),
        );
        expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe(
          teamClient.clientId,
        );
        yield* issuer.allowClient({ ...teamClient, redirect: started.redirectUri });
        const completed = yield* complete(
          actors.member,
          personal,
          yield* consent(started.authorizationUrl),
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const account = yield* body(Resource, completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.member, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );
        expect(
          (yield* body(
            Ownership,
            yield* api.request(actors.member, "GET", `${prefix}/accounts/${account.id}/access`),
          )).ownership.kind,
        ).toBe("personal");
        // Removing the client stops new connections and keeps the connected account, but its
        // details are withdrawn: a reconnect does not sign in with the grant's copy of them.
        expect(
          (yield* api.request(
            actors.admin,
            "DELETE",
            `${prefix}/oauth-clients/${registered.client.id}`,
          )).status,
        ).toBe(200);
        expect((yield* options(actors.member, app.provider)).clients).toEqual([]);
        const after = yield* connection(actors.member, app.id);
        expect((yield* start(actors.member, after, { id: registered.client.id })).status).toBe(403);
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/accounts/${account.id}/access`))
            .status,
        ).toBe(200);
        const reconnect = yield* start(
          actors.member,
          yield* connection(actors.member, app.id, account.id),
        );
        expect(reconnect.status, JSON.stringify(reconnect.body)).toBe(404);
        expect((yield* body(Tagged, reconnect))._tag).toBe("OAuthClientNotFound");
        // The sign-in found the client itself, so the refusal does not name it.
        expect(JSON.stringify(reconnect.body)).not.toContain(registered.client.id);
        // Nor does entering them: they were withdrawn from everyone.
        const entered = yield* start(actors.member, yield* connection(actors.member, app.id), {
          ...teamClient,
        });
        expect(entered.status, JSON.stringify(entered.body)).toBe(404);
        expect((yield* body(Tagged, entered))._tag).toBe("OAuthClientNotFound");
        expect(JSON.stringify(entered.body)).not.toContain(registered.client.id);
      }),
    ),
  );

  it.effect(scenarios.oauthClientMissing.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, deploy, options } = yield* organizationOAuth;
        const browser = yield* Browser;
        const app = yield* deploy;
        expect(yield* options(actors.admin, app.provider)).toEqual({
          mode: "client-required",
          clients: [],
        });
        const notice = `No OAuth client is registered for ${app.name}, and Executor doesn’t provide one.`;
        const openConnect = (actor: string) =>
          browser.use(`Open the connect form as ${actor}`, (page) =>
            page
              .goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`)
              .then(() =>
                page.getByRole("button", { name: "Connect new account", exact: true }).click(),
              ),
          );
        yield* browser.omitNetworkTrace;

        // Members cannot register clients, so they enter their own OAuth app's details.
        yield* browser.login(actors.member);
        yield* openConnect("a member");
        yield* browser.use("Members enter client details", (page) =>
          page
            .getByRole("dialog")
            .getByLabel("Client ID", { exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Members are not offered registration", (page) =>
            page
              .getByRole("dialog")
              .getByRole("button", { name: "Register OAuth client", exact: true })
              .count(),
          ),
        ).toBe(0);

        // Administrators are told why they cannot connect yet, and how to fix it.
        yield* browser.login(actors.admin);
        yield* openConnect("an administrator");
        yield* browser.use("Administrators are told no client exists", (page) =>
          page.getByRole("dialog").getByText(notice, { exact: true }).waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Connecting waits for a client", (page) =>
            Promise.all([
              page
                .getByRole("dialog")
                .getByRole("button", { name: "Connect " + app.name, exact: true })
                .count(),
              page.getByRole("dialog").getByLabel("Client ID", { exact: true }).count(),
            ]),
          ),
        ).toEqual([0, 0]);
        yield* browser.use("Let the dialog finish opening", (page) =>
          page.waitForFunction(() =>
            document.getAnimations().every((animation) => animation.playState !== "running"),
          ),
        );
        yield* browser.checkpoint("Connect form without an OAuth client");
        yield* browser.use("Register a client from the connect form", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Register OAuth client", exact: true })
            .click(),
        );
        // The service being connected is already chosen.
        yield* browser.use("The form registers a client for this service", (page) =>
          page
            .getByRole("form", { name: "Register OAuth client" })
            .getByRole("combobox", { name: "Service", exact: true })
            .filter({ hasText: app.name })
            .waitFor({ state: "visible" })
            .then(() => page.getByLabel("Client ID", { exact: true }).fill(teamClient.clientId))
            .then(() =>
              page
                .getByLabel("Client secret (optional)", { exact: true })
                .fill(teamClient.clientSecret),
            ),
        );
        yield* browser.checkpoint("Register OAuth client from the connect form");
        // Registering returns to connecting, now with the client to sign in with.
        yield* browser.use("Register and return to connecting", (page) =>
          page
            .getByRole("button", { name: "Register", exact: true })
            .click()
            .then(() =>
              page
                .getByRole("dialog")
                .getByRole("button", { name: "Connect " + app.name, exact: true })
                .waitFor({ state: "visible" }),
            ),
        );
        expect(
          yield* browser.use("The notice is gone", (page) =>
            page.getByRole("dialog").getByText(notice, { exact: true }).count(),
          ),
        ).toBe(0);
        expect((yield* options(actors.admin, app.provider)).clients).toEqual([
          expect.objectContaining({ clientId: teamClient.clientId }),
        ]);
      }),
    ),
  );

  it.effect(scenarios.oauthClientAudience.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          issuer,
          prefix,
          deploy,
          options,
          connection,
          start,
          consent,
          complete,
          chooseService,
        } = yield* organizationOAuth;
        const app = yield* deploy;
        // An administrator connects a shared account with client details entered for it alone.
        const shared = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
            {
              destination: { kind: "shared", audience: { kind: "everyone" } },
            },
          ),
        );
        const entered = { clientId: "synthetic-entered-client", clientSecret: "synthetic-entered" };
        const sharedStart = yield* body(Redirect, yield* start(actors.owner, shared.id, entered));
        yield* issuer.allowClient({ ...entered, redirect: sharedStart.redirectUri });
        const sharedAccount = yield* complete(
          actors.owner,
          shared.id,
          yield* consent(sharedStart.authorizationUrl),
        );
        expect(sharedAccount.status, JSON.stringify(sharedAccount.body)).toBe(200);
        const sharedId = (yield* body(Resource, sharedAccount)).id;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/accounts/${sharedId}`).pipe(Effect.orDie),
        );
        // The organization's earlier connection gives a member nothing to sign in with: setup
        // says a client is required, and a personal connection without one is refused the same.
        expect(yield* options(actors.member, app.provider)).toEqual({
          mode: "client-required",
          clients: [],
        });
        const personal = yield* connection(actors.member, app.id);
        const unavailable = yield* start(actors.member, personal);
        expect(unavailable.status).toBe(409);
        expect((yield* body(Tagged, unavailable))._tag).toBe("OAuthClientUnavailable");

        // Administrators choose a client's audience when they register it. A client registered
        // for a group the member is not in is neither offered nor usable.
        const memberIdentity = yield* body(
          Schema.Struct({ userId: Schema.String }),
          yield* api.request(actors.member, "GET", "/api/viewer"),
        );
        const members = (yield* body(
          Members,
          yield* api.request(actors.owner, "GET", `${prefix}/groups`),
        )).members;
        const outsider = members.find((member) => member.userId !== memberIdentity.userId);
        const insider = members.find((member) => member.userId === memberIdentity.userId);
        if (outsider === undefined || insider === undefined)
          return yield* Effect.die("Synthetic members missing");
        const createGroup = (name: string, member: string) =>
          Effect.gen(function* () {
            const group = yield* body(
              Schema.Struct({ id: Schema.String, revision: Schema.String }),
              yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
                name,
                description: "",
                memberIds: [member],
              }),
            );
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "DELETE", `${prefix}/groups/${group.id}`, {
                  revision: group.revision,
                })
                .pipe(Effect.orDie),
            );
            return group;
          });
        const suffix = randomUUID().slice(0, 8);
        const group = yield* createGroup(`OAuth client group ${suffix}`, outsider.id);
        const memberGroupName = `OAuth client members ${suffix}`;
        const memberGroup = yield* createGroup(memberGroupName, insider.id);
        const directory = api
          .request(actors.admin, "GET", `${prefix}/oauth-clients`)
          .pipe(Effect.flatMap((response) => body(Directory, response)));
        // An unknown group is refused before any client exists.
        const before = (yield* directory).clients.length;
        const unknownGroup = yield* api.request(actors.admin, "POST", `${prefix}/oauth-clients`, {
          issuer: issuer.origin,
          ...restrictedClient,
          audience: { kind: "groups", groups: [`missing-${suffix}`] },
        });
        expect(unknownGroup.status).toBe(403);
        expect((yield* body(Tagged, unknownGroup))._tag).toBe("OrganizationForbidden");
        expect((yield* directory).clients).toHaveLength(before);
        const registered = yield* body(
          Registered,
          yield* api.request(actors.admin, "POST", `${prefix}/oauth-clients`, {
            issuer: issuer.origin,
            ...restrictedClient,
            audience: { kind: "groups", groups: [group.id] },
          }),
        );
        expect(registered.access.audience).toEqual({ kind: "groups", groups: [group.id] });
        expect(yield* options(actors.member, app.provider)).toEqual({
          mode: "client-required",
          clients: [],
        });
        // The server rechecks the audience when the member names the client anyway.
        const refused = yield* start(actors.member, personal, { id: registered.client.id });
        expect(refused.status).toBe(403);
        expect((yield* body(Tagged, refused))._tag).toBe("OrganizationForbidden");
        // Its ID and secret are the same client however they arrive, so entering them is refused
        // as an implicit reconnect that would keep it is.
        const typed = yield* start(actors.member, personal, restrictedClient);
        expect(typed.status, JSON.stringify(typed.body)).toBe(404);
        expect((yield* body(Tagged, typed))._tag).toBe("OAuthClientNotFound");

        // A client registered in the browser for the member's group is offered only to them.
        const browser = yield* Browser;
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.admin);
        yield* browser.use("Open accounts as an administrator", (page) =>
          page.goto(`/org/${actors.organization.slug}/accounts`),
        );
        yield* browser.use("Open the OAuth client manager", (page) =>
          page.getByRole("button", { name: "OAuth clients", exact: true }).click(),
        );
        yield* browser.use("Start registering a client", (page) =>
          page
            .getByRole("dialog", { name: "OAuth clients" })
            .getByRole("button", { name: "Register client", exact: true })
            .click(),
        );
        yield* browser.use("Enter the client", (page) =>
          chooseService(page, app.name)
            .then(() => page.getByLabel("Client ID", { exact: true }).fill(groupClient.clientId))
            .then(() =>
              page
                .getByLabel("Client secret (optional)", { exact: true })
                .fill(groupClient.clientSecret),
            ),
        );
        yield* browser.use("Limit the client to selected groups", (page) =>
          page
            .getByRole("combobox", { name: "Who can use this client?", exact: true })
            .click()
            .then(() => page.getByRole("option", { name: "Selected groups", exact: true }).click()),
        );
        // A group audience needs a group before the client can be registered.
        yield* browser.use("Registering without a group is refused", (page) =>
          page
            .getByRole("button", { name: "Register", exact: true })
            .click()
            .then(() =>
              page
                .getByRole("form", { name: "Register OAuth client" })
                .getByRole("alert")
                .filter({ hasText: "Choose at least one group." })
                .waitFor({ state: "visible" }),
            ),
        );
        yield* browser.use("Choose the member's group", (page) =>
          page.getByRole("checkbox", { name: memberGroupName, exact: true }).check(),
        );
        yield* browser.checkpoint("Register OAuth client for a group");
        yield* browser.use("Register the client", (page) =>
          page
            .getByRole("button", { name: "Register", exact: true })
            .click()
            .then(() =>
              page
                .getByRole("list", { name: "OAuth clients" })
                .getByText(groupClient.clientId, { exact: true })
                .waitFor({ state: "visible" }),
            ),
        );
        const groupRegistered = (yield* directory).clients.find(
          (entry) => entry.client.clientId === groupClient.clientId,
        );
        if (groupRegistered === undefined)
          return yield* Effect.die("The client registered for a group is missing");
        expect(groupRegistered.access.audience).toEqual({
          kind: "groups",
          groups: [memberGroup.id],
        });
        expect((yield* options(actors.member, app.provider)).clients).toEqual([
          { id: groupRegistered.client.id, clientId: groupClient.clientId },
        ]);
        const grouped = yield* body(
          Redirect,
          yield* start(actors.member, personal, { id: groupRegistered.client.id }),
        );
        expect(new URL(grouped.authorizationUrl).searchParams.get("client_id")).toBe(
          groupClient.clientId,
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.admin, "DELETE", `${prefix}/oauth-clients/${groupRegistered.client.id}`)
            .pipe(Effect.orDie),
        );

        // Widening the restricted client's audience lets the member use it too.
        expect(
          (yield* api.request(
            actors.admin,
            "PATCH",
            `${prefix}/oauth-clients/${registered.client.id}`,
            { audience: { kind: "everyone" }, revision: registered.access.revision },
          )).status,
        ).toBe(200);
        expect(
          [...(yield* options(actors.member, app.provider)).clients].sort((a, b) =>
            a.clientId.localeCompare(b.clientId),
          ),
        ).toEqual([
          { id: groupRegistered.client.id, clientId: groupClient.clientId },
          { id: registered.client.id, clientId: restrictedClient.clientId },
        ]);
        const allowed = yield* body(
          Redirect,
          yield* start(actors.member, personal, { id: registered.client.id }),
        );
        expect(new URL(allowed.authorizationUrl).searchParams.get("client_id")).toBe(
          restrictedClient.clientId,
        );
      }),
    ),
  );

  it.effect(scenarios.oauthClientEdit.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          issuer,
          prefix,
          deploy,
          options,
          connection,
          start,
          consent,
          complete,
        } = yield* organizationOAuth;
        const app = yield* deploy;
        const registered = yield* body(
          Registered,
          yield* api.request(actors.admin, "POST", `${prefix}/oauth-clients`, {
            issuer: issuer.origin,
            ...editedClient,
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.admin, "DELETE", `${prefix}/oauth-clients/${registered.client.id}`)
            .pipe(Effect.orDie),
        );
        expect((yield* options(actors.member, app.provider)).clients).toEqual([
          { id: registered.client.id, clientId: editedClient.clientId },
        ]);
        // Members can neither edit a client's details nor its audience.
        const memberEdit = yield* api.request(
          actors.member,
          "PATCH",
          `${prefix}/oauth-clients/${registered.client.id}`,
          { ...replacementClient, revision: registered.access.revision },
        );
        expect(memberEdit.status).toBe(403);
        expect((yield* body(Tagged, memberEdit))._tag).toBe("OrganizationForbidden");

        // The new audience is a group of the administrator alone, so the member falls outside it.
        const adminIdentity = yield* body(
          Schema.Struct({ userId: Schema.String }),
          yield* api.request(actors.admin, "GET", "/api/viewer"),
        );
        const adminMember = (yield* body(
          Members,
          yield* api.request(actors.owner, "GET", `${prefix}/groups`),
        )).members.find((member) => member.userId === adminIdentity.userId);
        if (adminMember === undefined) return yield* Effect.die("Synthetic administrator missing");
        const groupName = `OAuth client editors ${randomUUID().slice(0, 8)}`;
        const group = yield* body(
          Schema.Struct({ id: Schema.String, revision: Schema.String }),
          yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
            name: groupName,
            description: "",
            memberIds: [adminMember.id],
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/groups/${group.id}`, {
              revision: group.revision,
            })
            .pipe(Effect.orDie),
        );

        // An administrator edits the client's details and audience in one save.
        const browser = yield* Browser;
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.admin);
        yield* browser.use("Open accounts as an administrator", (page) =>
          page.goto(`/org/${actors.organization.slug}/accounts`),
        );
        yield* browser.use("Open the OAuth client manager", (page) =>
          page.getByRole("button", { name: "OAuth clients", exact: true }).click(),
        );
        const settled = (page: Page) =>
          page.waitForFunction(() =>
            document.getAnimations().every((animation) => animation.playState !== "running"),
          );
        const menu = (clientId: string) => `Manage ${app.name} client ${clientId}`;
        const openEdit = (page: Page, clientId: string) =>
          page
            .getByRole("button", { name: menu(clientId), exact: true })
            .click()
            .then(() => page.getByRole("menuitem", { name: "Edit", exact: true }).click());
        // A long client ID truncates inside the dialog, and the row's menu stays beside it.
        const layout = yield* browser.use("Measure the client's row", (page) => {
          const dialog = page.getByRole("dialog", { name: "OAuth clients" });
          return Promise.all([
            // The dialog's content edge: inside its scrollbar and padding, whatever the fonts.
            dialog.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              const right =
                rect.left +
                element.clientLeft +
                element.clientWidth -
                Number.parseFloat(getComputedStyle(element).paddingRight);
              return { x: rect.left, width: right - rect.left };
            }),
            dialog.getByRole("list", { name: "OAuth clients" }).boundingBox(),
            dialog.getByText(editedClient.clientId, { exact: true }).boundingBox(),
            dialog
              .getByRole("button", { name: menu(editedClient.clientId), exact: true })
              .boundingBox(),
          ]);
        });
        const [content, list, details, action] = layout;
        if (content === null || list === null || details === null || action === null)
          return yield* Effect.die("Row is not visible");
        expect(list.x + list.width).toBeLessThanOrEqual(content.x + content.width + 0.5);
        expect(action.x).toBeGreaterThan(details.x + details.width);
        expect(action.y).toBeLessThan(details.y + details.height);
        yield* browser.use("Let the dialog finish opening", settled);
        yield* browser.checkpoint("OAuth client row");
        yield* browser.use("Edit the client", (page) => openEdit(page, editedClient.clientId));
        const form = (page: Page) => page.getByRole("form", { name: "Edit OAuth client" });
        // The form starts from the client: its service is fixed and its secret is kept unless replaced.
        const prefilled = yield* browser.use("Read the prefilled form", (page) =>
          Promise.all([
            form(page).getByLabel("Service", { exact: true }).inputValue(),
            form(page).getByLabel("Service", { exact: true }).isEditable(),
            form(page).getByLabel("Client ID", { exact: true }).inputValue(),
            form(page)
              .getByLabel("Client secret (optional)", { exact: true })
              .inputValue()
              .then((value) => value.length > 0),
            form(page)
              .getByRole("combobox", { name: "Who can use this client?", exact: true })
              .textContent(),
          ]),
        );
        expect(prefilled).toEqual([
          app.name,
          false,
          editedClient.clientId,
          // The saved secret shows as filled rather than blank; its value is never sent back.
          true,
          "Everyone in the organization",
        ]);
        yield* browser.use("Replace the client's details and limit it to a group", (page) =>
          form(page)
            .getByLabel("Client ID", { exact: true })
            .fill(replacementClient.clientId)
            .then(() =>
              form(page)
                .getByLabel("Client secret (optional)", { exact: true })
                .fill(replacementClient.clientSecret),
            )
            .then(() =>
              form(page)
                .getByRole("combobox", { name: "Who can use this client?", exact: true })
                .click(),
            )
            .then(() => page.getByRole("option", { name: "Selected groups", exact: true }).click())
            .then(() => form(page).getByRole("checkbox", { name: groupName, exact: true }).check()),
        );
        yield* browser.use("Let the form settle", settled);
        yield* browser.checkpoint("Edit OAuth client");
        yield* browser.use("Save the client", (page) =>
          form(page)
            .getByRole("button", { name: "Save", exact: true })
            .click()
            .then(() =>
              page
                .getByRole("list", { name: "OAuth clients" })
                .getByText(replacementClient.clientId, { exact: true })
                .waitFor({ state: "visible" }),
            )
            .then(() => form(page).waitFor({ state: "detached" })),
        );
        yield* browser.use("Let the row settle", settled);
        yield* browser.checkpoint("Edited OAuth client row");

        const listed = yield* api.request(actors.admin, "GET", `${prefix}/oauth-clients`);
        const edited = (yield* body(Directory, listed)).clients.find(
          (entry) => entry.client.id === registered.client.id,
        );
        expect(edited?.client.clientId).toBe(replacementClient.clientId);
        expect(edited?.access.audience).toEqual({ kind: "groups", groups: [group.id] });
        // Neither secret is ever returned.
        for (const secret of [editedClient.clientSecret, replacementClient.clientSecret])
          expect(JSON.stringify(listed.body)).not.toContain(secret);

        // The member outside the new audience is no longer offered the client, nor may name it.
        const memberOptions = yield* api.request(
          actors.member,
          "GET",
          `${prefix}/providers/${app.provider}/oauth/oauth/setup`,
        );
        expect((yield* body(Options, memberOptions)).clients).toEqual([]);
        const personal = yield* connection(actors.member, app.id);
        expect((yield* start(actors.member, personal, { id: registered.client.id })).status).toBe(
          403,
        );

        // The next sign-in uses the new client ID, and the service accepts the new secret.
        const adminOptions = yield* api.request(
          actors.admin,
          "GET",
          `${prefix}/providers/${app.provider}/oauth/oauth/setup`,
        );
        expect((yield* body(Options, adminOptions)).clients).toEqual([
          { id: registered.client.id, clientId: replacementClient.clientId },
        ]);
        const adminConnection = yield* connection(actors.admin, app.id);
        const started = yield* body(
          Redirect,
          yield* start(actors.admin, adminConnection, { id: registered.client.id }),
        );
        expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe(
          replacementClient.clientId,
        );
        yield* issuer.allowClient({ ...replacementClient, redirect: started.redirectUri });
        const completed = yield* complete(
          actors.admin,
          adminConnection,
          yield* consent(started.authorizationUrl),
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const account = yield* body(Resource, completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.admin, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );
        for (const response of [memberOptions, adminOptions, completed])
          for (const secret of [editedClient.clientSecret, replacementClient.clientSecret])
            expect(JSON.stringify(response.body)).not.toContain(secret);

        // Saving the form again with its filled secret untouched keeps the new secret: the
        // service still accepts the client below.
        yield* browser.use("Open the edited client", (page) =>
          openEdit(page, replacementClient.clientId),
        );
        yield* browser.use("Open it to everyone without touching the secret", (page) =>
          form(page)
            .getByRole("combobox", { name: "Who can use this client?", exact: true })
            .click()
            .then(() =>
              page
                .getByRole("option", { name: "Everyone in the organization", exact: true })
                .click(),
            )
            .then(() => form(page).getByRole("button", { name: "Save", exact: true }).click())
            .then(() => form(page).waitFor({ state: "detached" })),
        );
        const reopened = (yield* body(
          Directory,
          yield* api.request(actors.admin, "GET", `${prefix}/oauth-clients`),
        )).clients.find((entry) => entry.client.id === registered.client.id);
        expect(reopened?.client.clientId).toBe(replacementClient.clientId);
        expect(reopened?.access.audience).toEqual({ kind: "everyone" });
        const again = yield* connection(actors.member, app.id);
        const retried = yield* body(
          Redirect,
          yield* start(actors.member, again, { id: registered.client.id }),
        );
        const kept = yield* complete(
          actors.member,
          again,
          yield* consent(retried.authorizationUrl),
        );
        expect(kept.status, JSON.stringify(kept.body)).toBe(200);
        const memberAccount = yield* body(Resource, kept);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.member, "DELETE", `${prefix}/accounts/${memberAccount.id}`)
            .pipe(Effect.orDie),
        );

        // Automatic clients keep the service's registration and are not edited.
        yield* issuer.configure({ registration: true, tokenError: null });
        const automaticConnection = yield* connection(actors.member, app.id);
        expect((yield* start(actors.member, automaticConnection)).status).toBe(200);
        const automatic = (yield* body(
          Directory,
          yield* api.request(actors.admin, "GET", `${prefix}/oauth-clients`),
        )).clients.find(
          (entry) => entry.client.source !== "manual" && entry.client.id !== registered.client.id,
        );
        if (automatic === undefined) return yield* Effect.die("No automatic client was created");
        const refused = yield* api.request(
          actors.admin,
          "PATCH",
          `${prefix}/oauth-clients/${automatic.client.id}`,
          { clientId: replacementClient.clientId, revision: automatic.access.revision },
        );
        expect(refused.status).toBe(409);
        expect((yield* body(Tagged, refused))._tag).toBe("OAuthClientNotEditable");
        // The manager offers no edit for it either; the same views in dark mode.
        yield* browser.use("Reopen the manager in dark mode", (page) =>
          page
            .emulateMedia({ colorScheme: "dark" })
            .then(() => page.goto(`/org/${actors.organization.slug}/accounts`))
            .then(() => page.getByRole("button", { name: "OAuth clients", exact: true }).click())
            .then(() => settled(page)),
        );
        expect(
          yield* browser.use("Automatic clients cannot be edited", (page) =>
            page
              .getByRole("button", { name: menu(automatic.client.clientId), exact: true })
              .click()
              .then(() =>
                page
                  .getByRole("menuitem", { name: "Edit", exact: true })
                  .getAttribute("aria-disabled"),
              )
              .then((disabled) => page.keyboard.press("Escape").then(() => disabled)),
          ),
        ).toBe("true");
        yield* browser.checkpoint("OAuth client rows dark");
        yield* browser.use("Edit the client in dark mode", (page) =>
          openEdit(page, replacementClient.clientId)
            .then(() => form(page).waitFor({ state: "visible" }))
            .then(() => settled(page)),
        );
        yield* browser.checkpoint("Edit OAuth client dark");
      }),
    ),
  );

  it.effect(scenarios.oauthClientAudienceRecheck.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          issuer,
          prefix,
          deploy,
          options,
          connection,
          start,
          consent,
          complete,
        } = yield* organizationOAuth;
        const app = yield* deploy;
        const registered = yield* body(
          Registered,
          yield* api.request(actors.admin, "POST", `${prefix}/oauth-clients`, {
            issuer: issuer.origin,
            ...recheckedClient,
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.admin, "DELETE", `${prefix}/oauth-clients/${registered.client.id}`)
            .pipe(Effect.orDie),
        );
        // While everyone may use the client, a member connects an account with it.
        const first = yield* connection(actors.member, app.id);
        const started = yield* body(
          Redirect,
          yield* start(actors.member, first, { id: registered.client.id }),
        );
        yield* issuer.allowClient({ ...recheckedClient, redirect: started.redirectUri });
        const completed = yield* complete(
          actors.member,
          first,
          yield* consent(started.authorizationUrl),
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const account = yield* body(Resource, completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.member, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );
        // Another sign-in with it is at the service, consent given, when the audience narrows.
        const pending = yield* connection(actors.member, app.id);
        const pendingStart = yield* body(
          Redirect,
          yield* start(actors.member, pending, { id: registered.client.id }),
        );
        const callback = yield* consent(pendingStart.authorizationUrl);
        const narrowed = yield* api.request(
          actors.admin,
          "PATCH",
          `${prefix}/oauth-clients/${registered.client.id}`,
          { audience: { kind: "private" }, revision: registered.access.revision },
        );
        expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
        const restricted = yield* body(Registered, narrowed);

        // The member is neither offered the client nor may name it.
        expect((yield* options(actors.member, app.provider)).clients).toEqual([]);
        const named = yield* start(actors.member, yield* connection(actors.member, app.id), {
          id: registered.client.id,
        });
        expect(named.status).toBe(403);
        // A reconnect that names no client does not keep it, nor fall back to the grant's copy.
        const reconnect = yield* start(
          actors.member,
          yield* connection(actors.member, app.id, account.id),
        );
        expect(reconnect.status, JSON.stringify(reconnect.body)).toBe(404);
        expect((yield* body(Tagged, reconnect))._tag).toBe("OAuthClientNotFound");
        // The pending sign-in is refused before its code is exchanged.
        const exchanges = (yield* issuer.metrics).tokenExchanges;
        const refused = yield* complete(actors.member, pending, callback);
        expect(refused.status, JSON.stringify(refused.body)).toBe(400);
        expect(yield* body(CompletionFailure, refused)).toEqual({
          _tag: "OAuthCompletionFailed",
          reason: "client_unavailable",
        });
        expect((yield* issuer.metrics).tokenExchanges).toBe(exchanges);

        // Widening the audience again lets the member reconnect with it: the audience refused it.
        expect(
          (yield* api.request(
            actors.admin,
            "PATCH",
            `${prefix}/oauth-clients/${registered.client.id}`,
            { audience: { kind: "everyone" }, revision: restricted.access.revision },
          )).status,
        ).toBe(200);
        const kept = yield* body(
          Redirect,
          yield* start(actors.member, yield* connection(actors.member, app.id, account.id)),
        );
        expect(new URL(kept.authorizationUrl).searchParams.get("client_id")).toBe(
          recheckedClient.clientId,
        );
      }),
    ),
  );

  it.effect(scenarios.oauthClientRemovedPending.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, issuer, prefix, deploy, connection, start, consent, complete } =
          yield* organizationOAuth;
        const app = yield* deploy;
        // The service registers clients, so a sign-in naming none registers one and stores it.
        yield* issuer.configure({ registration: true, tokenError: null });
        const pending = yield* connection(actors.member, app.id);
        const started = yield* body(Redirect, yield* start(actors.member, pending));
        const automatic = (yield* body(
          Directory,
          yield* api.request(actors.admin, "GET", `${prefix}/oauth-clients`),
        )).clients.find(
          (entry) =>
            entry.client.source === "registered" &&
            entry.client.clientId ===
              new URL(started.authorizationUrl).searchParams.get("client_id"),
        );
        if (automatic === undefined) return yield* Effect.die("No automatic client was created");
        // The member gives consent at the service while an administrator removes the client.
        const callback = yield* consent(started.authorizationUrl);
        const removed = yield* api.request(
          actors.admin,
          "DELETE",
          `${prefix}/oauth-clients/${automatic.client.id}`,
        );
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);

        // Removing it withdrew its credentials: the pending sign-in is refused before its code
        // is exchanged.
        const exchanges = (yield* issuer.metrics).tokenExchanges;
        const refused = yield* complete(actors.member, pending, callback);
        expect(refused.status, JSON.stringify(refused.body)).toBe(400);
        expect(yield* body(CompletionFailure, refused)).toEqual({
          _tag: "OAuthCompletionFailed",
          reason: "client_unavailable",
        });
        expect((yield* issuer.metrics).tokenExchanges).toBe(exchanges);

        // Starting again registers a new client, and that sign-in completes.
        const again = yield* connection(actors.member, app.id);
        const restarted = yield* body(Redirect, yield* start(actors.member, again));
        expect(new URL(restarted.authorizationUrl).searchParams.get("client_id")).not.toBe(
          automatic.client.clientId,
        );
        const completed = yield* complete(
          actors.member,
          again,
          yield* consent(restarted.authorizationUrl),
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const account = yield* body(Resource, completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.member, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );
      }),
    ),
  );

  it.effect(scenarios.oauthClientEditRevision.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, issuer, prefix, deploy, connection, start, consent, complete } =
          yield* organizationOAuth;
        const app = yield* deploy;
        const before = { clientId: "synthetic-revision-before", clientSecret: "synthetic-kept" };
        const after = "synthetic-revision-after";
        const registered = yield* body(
          Registered,
          yield* api.request(actors.admin, "POST", `${prefix}/oauth-clients`, {
            issuer: issuer.origin,
            ...before,
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.admin, "DELETE", `${prefix}/oauth-clients/${registered.client.id}`)
            .pipe(Effect.orDie),
        );
        const edit = (payload: object) =>
          api.request(actors.admin, "PATCH", `${prefix}/oauth-clients/${registered.client.id}`, {
            ...payload,
          });
        const current = api.request(actors.admin, "GET", `${prefix}/oauth-clients`).pipe(
          Effect.flatMap((response) => body(Directory, response)),
          Effect.map((directory) =>
            directory.clients.find((entry) => entry.client.id === registered.client.id),
          ),
        );
        // Changing only the client ID advances the revision.
        const edited = yield* body(
          Registered,
          yield* edit({ clientId: after, revision: registered.access.revision }),
        );
        expect(edited.client.clientId).toBe(after);
        expect(edited.access.revision).not.toBe(registered.access.revision);
        // Edits made from the earlier revision are refused, whether they change the details or
        // leave the audience as it is, and change nothing.
        for (const payload of [
          { clientSecret: "synthetic-stale-secret" },
          { clientId: "synthetic-stale-client" },
          { audience: { kind: "everyone" } },
        ]) {
          const stale = yield* edit({ ...payload, revision: registered.access.revision });
          expect(stale.status, JSON.stringify(payload)).toBe(409);
          expect((yield* body(Tagged, stale))._tag).toBe("AccessConflict");
        }
        const unchanged = yield* current;
        expect(unchanged?.client.clientId).toBe(after);
        expect(unchanged?.access.revision).toBe(edited.access.revision);
        // Saving from the current revision without a change keeps the revision.
        const same = yield* body(
          Registered,
          yield* edit({ audience: { kind: "everyone" }, revision: edited.access.revision }),
        );
        expect(same.access.revision).toBe(edited.access.revision);
        // The refused secret was never stored: the service accepts the original one.
        const adminConnection = yield* connection(actors.admin, app.id);
        const started = yield* body(
          Redirect,
          yield* start(actors.admin, adminConnection, { id: registered.client.id }),
        );
        expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe(after);
        yield* issuer.allowClient({
          clientId: after,
          clientSecret: before.clientSecret,
          redirect: started.redirectUri,
        });
        const completed = yield* complete(
          actors.admin,
          adminConnection,
          yield* consent(started.authorizationUrl),
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const account = yield* body(Resource, completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.admin, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );

        // In the manager, an edit saved after the client changed elsewhere is refused and says so.
        const browser = yield* Browser;
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.admin);
        yield* browser.use("Open the OAuth client manager", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/accounts`)
            .then(() => page.getByRole("button", { name: "OAuth clients", exact: true }).click()),
        );
        const form = (page: Page) => page.getByRole("form", { name: "Edit OAuth client" });
        yield* browser.use("Edit the client", (page) =>
          page
            .getByRole("button", { name: `Manage ${app.name} client ${after}`, exact: true })
            .click()
            .then(() => page.getByRole("menuitem", { name: "Edit", exact: true }).click())
            .then(() => form(page).waitFor({ state: "visible" })),
        );
        // Another administrator narrows the audience while the form is open.
        expect(
          (yield* edit({ audience: { kind: "private" }, revision: edited.access.revision })).status,
        ).toBe(200);
        yield* browser.use("Save a new client ID from the stale form", (page) =>
          form(page)
            .getByLabel("Client ID", { exact: true })
            .fill("synthetic-revision-browser")
            .then(() => form(page).getByRole("button", { name: "Save", exact: true }).click())
            .then(() =>
              form(page)
                .getByRole("alert")
                .filter({ hasText: "This client changed while you were editing" })
                .waitFor({ state: "visible" }),
            ),
        );
        yield* browser.checkpoint("Stale OAuth client edit refused");
        const refused = yield* current;
        expect(refused?.client.clientId).toBe(after);
        expect(refused?.access.audience).toEqual({ kind: "private" });
      }),
    ),
  );

  it.effect(scenarios.oauthClientCredentialIdentity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          issuer,
          prefix,
          deploy,
          connection,
          start,
          consent,
          complete,
          chooseService,
        } = yield* organizationOAuth;
        const app = yield* deploy;
        const original = {
          clientId: "synthetic-identity-client",
          clientSecret: "synthetic-identity-old",
        };
        const rotated = "synthetic-identity-new";
        const register = (details: object) =>
          api.request(actors.admin, "POST", `${prefix}/oauth-clients`, {
            issuer: issuer.origin,
            ...details,
          });
        const registered = yield* body(Registered, yield* register(original));
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.admin, "DELETE", `${prefix}/oauth-clients/${registered.client.id}`)
            .pipe(Effect.orDie),
        );
        const edit = (client: string, payload: object) =>
          api.request(actors.admin, "PATCH", `${prefix}/oauth-clients/${client}`, payload);
        const directory = api
          .request(actors.admin, "GET", `${prefix}/oauth-clients`)
          .pipe(Effect.flatMap((response) => body(Directory, response)));

        // A member connects an account while everyone may use the client.
        const first = yield* connection(actors.member, app.id);
        const started = yield* body(
          Redirect,
          yield* start(actors.member, first, { id: registered.client.id }),
        );
        yield* issuer.allowClient({ ...original, redirect: started.redirectUri });
        const completed = yield* complete(
          actors.member,
          first,
          yield* consent(started.authorizationUrl),
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const account = yield* body(Resource, completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.member, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );

        // An administrator replaces the secret. The service may accept the old one until it is
        // revoked there, so the account's copy of it is still this client.
        const replaced = yield* body(
          Registered,
          yield* edit(registered.client.id, {
            clientSecret: rotated,
            revision: registered.access.revision,
          }),
        );

        // The same details are one client: registering them again, old or current, is refused.
        for (const details of [original, { ...original, clientSecret: rotated }]) {
          const again = yield* register(details);
          expect(again.status, JSON.stringify(again.body)).toBe(409);
          expect(
            yield* body(Schema.Struct({ _tag: Schema.String, client: Schema.String }), again),
          ).toEqual({ _tag: "OAuthClientExists", client: registered.client.id });
        }
        // An edit into another client's earlier details is refused with its audience change.
        const other = yield* body(
          Registered,
          yield* register({
            clientId: "synthetic-identity-other",
            clientSecret: "synthetic-other",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.admin, "DELETE", `${prefix}/oauth-clients/${other.client.id}`)
            .pipe(Effect.orDie),
        );
        const taken = yield* edit(other.client.id, {
          ...original,
          audience: { kind: "private" },
          revision: other.access.revision,
        });
        expect(taken.status, JSON.stringify(taken.body)).toBe(409);
        expect((yield* body(Tagged, taken))._tag).toBe("OAuthClientExists");
        const untouched = (yield* directory).clients.find(
          (entry) => entry.client.id === other.client.id,
        );
        expect(untouched?.client.clientId).toBe("synthetic-identity-other");
        expect(untouched?.access).toEqual(other.access);

        // The member falls outside the client's audience.
        const narrowed = yield* body(
          Registered,
          yield* edit(registered.client.id, {
            audience: { kind: "private" },
            revision: replaced.access.revision,
          }),
        );
        const exchanges = (yield* issuer.metrics).tokenExchanges;
        // A reconnect with the account's copy of the old secret is still the client, and refused.
        const reconnect = yield* start(
          actors.member,
          yield* connection(actors.member, app.id, account.id),
        );
        expect(reconnect.status, JSON.stringify(reconnect.body)).toBe(404);
        expect((yield* body(Tagged, reconnect))._tag).toBe("OAuthClientNotFound");
        // The member cannot list the client, so the refusal does not name it.
        expect(JSON.stringify(reconnect.body)).not.toContain(registered.client.id);
        // So is entering the old details by hand.
        const entered = yield* start(actors.member, yield* connection(actors.member, app.id), {
          ...original,
        });
        expect(entered.status, JSON.stringify(entered.body)).toBe(404);
        expect((yield* body(Tagged, entered))._tag).toBe("OAuthClientNotFound");
        expect(JSON.stringify(entered.body)).not.toContain(registered.client.id);
        expect((yield* issuer.metrics).tokenExchanges).toBe(exchanges);

        // Admitted again, the reconnect keeps the client and signs in with its current secret:
        // the service now accepts only that one.
        expect(
          (yield* edit(registered.client.id, {
            audience: { kind: "everyone" },
            revision: narrowed.access.revision,
          })).status,
        ).toBe(200);
        const again = yield* connection(actors.member, app.id, account.id);
        const kept = yield* body(Redirect, yield* start(actors.member, again));
        expect(new URL(kept.authorizationUrl).searchParams.get("client_id")).toBe(
          original.clientId,
        );
        yield* issuer.allowClient({
          clientId: original.clientId,
          clientSecret: rotated,
          redirect: kept.redirectUri,
        });
        const reconnected = yield* complete(
          actors.member,
          again,
          yield* consent(kept.authorizationUrl),
        );
        expect(reconnected.status, JSON.stringify(reconnected.body)).toBe(200);

        // The client manager says why registering the same details again is refused.
        const browser = yield* Browser;
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.admin);
        yield* browser.use("Open the OAuth client manager", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/accounts`)
            .then(() => page.getByRole("button", { name: "OAuth clients", exact: true }).click())
            .then(() =>
              page
                .getByRole("dialog", { name: "OAuth clients" })
                .getByRole("button", { name: "Register client", exact: true })
                .click(),
            ),
        );
        yield* browser.use("Register a client's earlier details again", (page) =>
          chooseService(page, app.name)
            .then(() => page.getByLabel("Client ID", { exact: true }).fill(original.clientId))
            .then(() =>
              page
                .getByLabel("Client secret (optional)", { exact: true })
                .fill(original.clientSecret),
            )
            .then(() => page.getByRole("button", { name: "Register", exact: true }).click())
            .then(() =>
              page
                .getByRole("form", { name: "Register OAuth client" })
                .getByRole("alert")
                .filter({ hasText: "Another OAuth client for this service has this client ID" })
                .waitFor({ state: "visible" }),
            ),
        );
        yield* browser.checkpoint("Duplicate OAuth client details refused");
        expect(
          (yield* directory).clients.filter((entry) => entry.client.clientId === original.clientId),
        ).toHaveLength(1);

        // Other credentials with the same client ID are another client. The manager and the connect
        // form tell clients sharing a client ID apart without a secret: how and when each was added,
        // and the end of its stored ID, which clients with a client ID of their own do not show.
        const twin = yield* body(
          Registered,
          yield* register({ clientId: original.clientId, clientSecret: "synthetic-identity-twin" }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.admin, "DELETE", `${prefix}/oauth-clients/${twin.client.id}`)
            .pipe(Effect.orDie),
        );
        const end = (id: string) => `…${id.slice(-6)}`;
        const ends = [registered.client.id, twin.client.id, other.client.id].map(end);
        expect(
          yield* browser.use("Clients sharing a client ID show the end of their IDs", (page) =>
            // The manager's open state is in the address, so it reopens with the reloaded list.
            page.reload().then(() => {
              const list = page
                .getByRole("dialog", { name: "OAuth clients" })
                .getByRole("list", { name: "OAuth clients" });
              return list
                .getByText(end(twin.client.id))
                .waitFor({ state: "visible" })
                .then(() => Promise.all(ends.map((shown) => list.getByText(shown).count())));
            }),
          ),
        ).toEqual([1, 1, 0]);
        yield* browser.checkpoint("OAuth clients sharing a client ID");
        expect(
          yield* browser.use("The connect form tells clients sharing a client ID apart", (page) =>
            page
              .goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`)
              .then(() =>
                page.getByRole("button", { name: "Connect new account", exact: true }).click(),
              )
              .then(() =>
                page.getByRole("dialog").getByRole("combobox", { name: "OAuth client" }).click(),
              )
              .then(() => page.getByRole("option").first().waitFor({ state: "visible" }))
              .then(() =>
                Promise.all(
                  ends.map((shown) => page.getByRole("option").filter({ hasText: shown }).count()),
                ),
              ),
          ),
        ).toEqual([1, 1, 0]);
        yield* browser.checkpoint("Connect form with clients sharing a client ID");
      }),
    ),
  );

  it.effect(scenarios.oauthClientCredentialsIsolation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const issuer = yield* clientCredentialsIssuer;
        yield* issuer.configure({ method: "client_secret_basic", expiresIn: 120, rejected: false });
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Machine isolation ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Machine isolation",auth:{machine:oauth2({grant:"client_credentials",tokenUrl:${JSON.stringify(issuer.origin + "/token")},scopes:["reports:read"],tokenEndpointAuthMethod:"client_secret_basic"})}});
export default defineApp({user: { accounts:{service:service.many()} }},async()=>({tools: router({})}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(DeployedApp, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const connect = (client?: typeof machineClient | { readonly id: string }) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
                {},
              ),
            );
            return yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/start`,
              { method: "machine", ...(client === undefined ? {} : { client }) },
            );
          });
        const first = yield* body(Completed, yield* connect(machineClient));
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${first.account.id}`)
            .pipe(Effect.orDie),
        );
        const requests = (yield* issuer.metrics).requests;
        // Another account must bring its own credentials; the first account's are never reused.
        const second = yield* connect();
        expect(second.status, JSON.stringify(second.body)).toBe(409);
        expect((yield* body(Tagged, second))._tag).toBe("OAuthClientUnavailable");
        expect((yield* issuer.metrics).requests).toBe(requests);
        // A machine client is the account itself, so a stored client, even one registered for
        // the same server, never signs in a client credentials connection.
        const shared = yield* api.request(actors.owner, "POST", `${prefix}/oauth-clients`, {
          issuer: `${issuer.origin}/token`,
          ...machineClient,
        });
        expect(shared.status, JSON.stringify(shared.body)).toBe(200);
        const stored = yield* body(
          Schema.Struct({ client: Schema.Struct({ id: Schema.String }) }),
          shared,
        );
        const named = yield* connect({ id: stored.client.id });
        expect(named.status, JSON.stringify(named.body)).toBe(422);
        expect(yield* body(CompletionFailure, named)).toMatchObject({
          _tag: "OAuthSetupFailed",
          reason: "invalid_client",
        });
        expect((yield* issuer.metrics).requests).toBe(requests);
      }),
    ),
  );
});
