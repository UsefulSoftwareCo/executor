import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource, Inventory } from "../support/contracts.ts";
import { clientCredentialsIssuer, machineClient } from "../support/client-credentials-issuer.ts";
import { scenarios } from "../test-plan.ts";
import { Browser } from "../support/browser.ts";
import { managementApp } from "../support/management-app.ts";
import {
  accountNameField,
  accountNamePrompt,
  nameConnectedAccount,
} from "../support/name-account.ts";
import { appsManifest } from "../support/apps-release.ts";

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  account: Schema.Struct({ id: Schema.String, label: Schema.String }),
});
const Selection = Schema.Struct({ accounts: Schema.Struct({ service: Schema.String }) });
const Read = Schema.Struct({ authenticated: Schema.Boolean, generation: Schema.Number });
const SetupStatus = Schema.Struct({ status: Schema.String });

layer(HostedLive, { excludeTestServices: true })("Machine OAuth", (it) => {
  it.effect(scenarios.oauthClientForm.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const issuer = yield* clientCredentialsIssuer;
        yield* issuer.configure({ method: "client_secret_post" });
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Machine form ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Reporting",auth:{machine:oauth2({grant:"client_credentials",tokenUrl:${JSON.stringify(issuer.origin + "/token")},scopes:["reports:read"],tokenEndpointAuthMethod:"client_secret_post"})}});
export default defineApp({accounts:{service}},async()=>({tools: router({})}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(Resource, deployed);
        let saved: unknown;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
            if (saved !== undefined) {
              const result = yield* Schema.decodeUnknownEffect(Completed)(saved);
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${result.account.id}`);
            }
          }).pipe(Effect.orDie),
        );
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the configured machine provider", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Open Connect", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        yield* browser.use("Machine credentials appear without protocol controls", (page) => {
          const dialog = page.getByRole("dialog");
          return dialog
            .getByLabel("Client secret", { exact: true })
            .waitFor({ state: "visible" })
            .then(() =>
              Promise.all([
                dialog.getByRole("combobox").count(),
                dialog.getByRole("button", { name: "Copy redirect URL" }).count(),
                dialog.getByText("reports:read", { exact: true }).count(),
              ]),
            )
            .then((counts) => {
              expect(counts).toEqual([0, 0, 1]);
            })
            .then(() => dialog.getByLabel("Account name", { exact: true }).count())
            .then((nameFields) => {
              expect(nameFields).toBe(0);
            })
            .then(() =>
              dialog.getByLabel("Client ID", { exact: true }).fill(machineClient.clientId),
            )
            .then(() =>
              dialog.getByLabel("Client secret", { exact: true }).fill(machineClient.clientSecret),
            );
        });
        expect((yield* issuer.metrics).requests).toBe(0);
        yield* browser.checkpoint("Machine OAuth form from provider code");
        yield* browser.use("Use the form on a narrow screen", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.checkpoint("Machine OAuth form on mobile");
        yield* browser.use("Restore the desktop viewport", (page) =>
          page.setViewportSize({ width: 1440, height: 1000 }),
        );
        let dropped = false;
        yield* browser.use("Lose the first response after committing the account", (page) =>
          page.route(/\/connections\/[^/]+\/oauth\/start$/, (route) => {
            if (dropped) return route.fallback();
            dropped = true;
            const request: unknown = route.request().postDataJSON();
            const submitted = Schema.decodeUnknownSync(
              Schema.Struct({ client: Schema.Record(Schema.String, Schema.Unknown) }),
            )(request);
            expect(Object.keys(submitted.client).sort()).toEqual(["clientId", "clientSecret"]);
            return route
              .fetch()
              .then((response) => response.json())
              .then((value: unknown) => {
                saved = value;
                return route.abort("failed");
              });
          }),
        );
        yield* browser.use("Connect using the declared grant", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Connect Reporting", exact: true })
            .click(),
        );
        yield* browser.use("Keep the draft after losing the response", (page) => {
          const dialog = page.getByRole("dialog");
          return dialog
            .getByRole("alert")
            .waitFor({ state: "visible" })
            .then(() => dialog.getByLabel("Client secret", { exact: true }).inputValue())
            .then((secret) => {
              expect(secret === machineClient.clientSecret).toBe(true);
            });
        });
        yield* browser.use("Retry the same connection", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Connect Reporting", exact: true })
            .click(),
        );
        // Immediate completion closes the connection dialog and asks for a name over the app.
        const prompt = yield* browser.use("Immediate completion asks to name the account", (page) =>
          page
            .getByRole("dialog", { name: "Connect Reporting", exact: true })
            .waitFor({ state: "hidden" })
            .then(() => accountNamePrompt(page))
            .then(() =>
              accountNameField(page)
                .inputValue()
                .then((name) => ({ name, url: new URL(page.url()) })),
            ),
        );
        expect(prompt.name).toBe("Default");
        expect(prompt.url.pathname).toBe(`/org/${actors.organization.slug}/apps/${app.id}`);
        expect(prompt.url.searchParams.has("rename")).toBe(false);
        yield* browser.checkpoint("Machine account asks for a name");
        yield* browser.use("Keep the default name", (page) => nameConnectedAccount(page));
        yield* browser.use("The app shows the account without navigation", (page) =>
          page
            .getByRole("radio", { name: "Default", exact: true, checked: true })
            .waitFor({ state: "visible" })
            .then(() => {
              expect(page.url()).toContain(`/apps/${app.id}`);
            }),
        );
        expect((yield* issuer.metrics).generation).toBe(1);
        yield* browser.checkpoint("Machine account connected without navigation");
      }),
    ),
  );
  it.effect(scenarios.oauthClientCredentials.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const issuer = yield* clientCredentialsIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        /** Background profile setup's outcome, once it has finished. */
        const setupStatus = (path: string) =>
          api.request(actors.owner, "GET", path).pipe(
            Effect.flatMap((response) => body(SetupStatus, response)),
            Effect.flatMap((current) =>
              current.status === "pending"
                ? Effect.fail(new Error("Profile setup has not finished"))
                : Effect.succeed(current.status),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );
        // The inventory baseline must include the asynchronously provisioned personal account.
        yield* managementApp(actors.owner);
        for (const authMethod of [
          "client_secret_basic",
          "client_secret_post",
          "client_secret_basic_raw",
        ] as const) {
          yield* issuer.configure({ method: authMethod, expiresIn: 120, rejected: false });
          const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Machine OAuth ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service=defineProvider({name:${JSON.stringify(authMethod)},auth:{machine:oauth2({grant:"client_credentials",${authMethod === "client_secret_post" ? `discover:${JSON.stringify(issuer.origin)}` : `tokenUrl:${JSON.stringify(issuer.origin + "/token")}`},scopes:["reports:read"],resource:${JSON.stringify(issuer.origin + "/resource")},tokenEndpointAuthMethod:${JSON.stringify(authMethod)}})}});
export default defineApp({accounts:{service}},async({accounts})=>({tools: router({
  read:query({input:object({})},async({fetch})=>{const result=await fetch(${JSON.stringify(issuer.origin + "/resource")},{headers:{authorization:"Bearer "+accounts.service.fields.access_token}});return result.json();}),
})}));`,
              },
              appsManifest,
            ],
          });
          expect(response.status).toBe(200);
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
              ...(authMethod === "client_secret_post"
                ? { destination: { kind: "shared", audience: { kind: "everyone" } } }
                : {}),
            }),
          );
          const path = `${prefix}/connections/${connection.id}/oauth/start`;
          const payload = {
            method: "machine",
            label: "Reporting",
            client: machineClient,
          };
          expect((yield* api.request(actors.member, "POST", path, payload)).status).toBe(403);
          expect(
            (yield* api.request(actors.owner, "POST", path, {
              ...payload,
              client: { clientId: machineClient.clientId },
            })).status,
          ).toBe(422);
          const saved = yield* api.request(actors.owner, "POST", path, payload);
          expect(saved.status).toBe(200);
          const completed = yield* body(Completed, saved);
          expect(completed.account.label).toBe("Reporting");
          const access = yield* body(
            Schema.Struct({
              ownership: Schema.Struct({ kind: Schema.String }),
              canUse: Schema.Boolean,
            }),
            yield* api.request(
              actors.owner,
              "GET",
              `${prefix}/accounts/${completed.account.id}/access`,
            ),
          );
          expect(access.ownership.kind).toBe(
            authMethod === "client_secret_post" ? "shared" : "personal",
          );
          expect(access.canUse).toBe(true);
          expect(
            (yield* api.request(actors.member, "GET", `${prefix}/accounts/${completed.account.id}`))
              .status,
          ).toBe(authMethod === "client_secret_post" ? 200 : 403);
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "DELETE", `${prefix}/accounts/${completed.account.id}`)
              .pipe(Effect.orDie),
          );
          expect((yield* issuer.metrics).observed).toEqual({
            grant: "client_credentials",
            scope: "reports:read",
            resource: `${issuer.origin}/resource`,
            contentType: "application/x-www-form-urlencoded",
            hasCallback: false,
            authenticated: true,
          });
          const issued = (yield* issuer.metrics).generation;
          const repeated = yield* body(
            Completed,
            yield* api.request(actors.owner, "POST", path, payload),
          );
          expect(repeated.account.id).toBe(completed.account.id);
          expect((yield* issuer.metrics).generation).toBe(issued);
          expect(
            (yield* body(
              Selection,
              yield* api.request(
                actors.owner,
                "GET",
                `${prefix}/apps/${app.id}/profiles/${profile.id}`,
              ),
            )).accounts.service,
          ).toBe(completed.account.id);
          // Selecting the account started background profile setup, which resolves the account.
          // Once the renewal phase issues tokens inside the host's refresh window, every resolve
          // renews, so setup must be done before then or its renewals are counted here.
          expect(yield* setupStatus(`${prefix}/apps/${app.id}/profiles/${profile.id}`)).toBe(
            "ready",
          );
          yield* issuer.configure({ expiresIn: 20 });
          const expiringConnection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
              requirement: "service",
              profile: profile.id,
              account: completed.account.id,
            }),
          );
          const expiring = yield* body(
            Completed,
            yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${expiringConnection.id}/oauth/start`,
              { method: "machine", label: "Unused renewal label" },
            ),
          );
          expect(expiring.account).toEqual(completed.account);
          const beforeRenewal = (yield* issuer.metrics).generation;
          const read = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${app.id}/tools/call`,
            { profile: profile.id, tool: "read", kind: "query", input: {} },
          );
          expect(read.status).toBe(200);
          const value = yield* body(Read, read);
          expect(value.authenticated).toBe(true);
          expect(value.generation).toBeGreaterThan(beforeRenewal);
          expect((yield* issuer.metrics).observed?.scope).toBe("reports:read");
          // A refused client keeps the grant. The renewed token is still valid, so the call's
          // renewal ahead of expiry fails and the call uses that token.
          yield* issuer.configure({ rejected: true });
          const requests = (yield* issuer.metrics).requests;
          const kept = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${app.id}/tools/call`,
            { profile: profile.id, tool: "read", kind: "query", input: {} },
          );
          expect(kept.status, JSON.stringify(kept.body)).toBe(200);
          expect(yield* body(Read, kept)).toEqual(value);
          expect((yield* issuer.metrics).requests).toBe(requests + 1);
          yield* issuer.configure({ rejected: false, expiresIn: 120 });
          const reconnect = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
              requirement: "service",
              profile: profile.id,
              account: completed.account.id,
            }),
          );
          const reconnected = yield* body(
            Completed,
            yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${reconnect.id}/oauth/start`,
              { method: "machine", label: "Unused reconnect label" },
            ),
          );
          expect(reconnected.account).toEqual(completed.account);
          const before = yield* body(
            Inventory,
            yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
          );
          const pause = yield* issuer.pauseNextToken;
          const raced = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
              requirement: "service",
              profile: profile.id,
            }),
          );
          const exchange = yield* api
            .request(actors.owner, "POST", `${prefix}/connections/${raced.id}/oauth/start`, payload)
            .pipe(Effect.forkChild);
          yield* pause.entered;
          expect(
            (yield* selectProfileAccounts(actors.owner, `${prefix}/apps/${app.id}`, profile.id, {}))
              .status,
          ).toBe(200);
          yield* pause.release;
          expect((yield* Fiber.join(exchange)).status).toBe(409);
          expect(
            (yield* body(
              Schema.Struct({ accounts: Schema.Record(Schema.String, Schema.Unknown) }),
              yield* api.request(
                actors.owner,
                "GET",
                `${prefix}/apps/${app.id}/profiles/${profile.id}`,
              ),
            )).accounts,
          ).toEqual({});
          const after = yield* body(
            Inventory,
            yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
          );
          expect(after.accounts.map((account) => account.id).sort()).toEqual(
            before.accounts.map((account) => account.id).sort(),
          );
          // Unnamed machine accounts take the owner's next free default name for the provider.
          const unnamed = [];
          for (const expected of ["Default", "Default 2"]) {
            const next = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
                requirement: "service",
                profile: profile.id,
                ...(authMethod === "client_secret_post"
                  ? { destination: { kind: "shared", audience: { kind: "everyone" } } }
                  : {}),
              }),
            );
            const named = yield* body(
              Completed,
              yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${next.id}/oauth/start`,
                { method: "machine", client: machineClient },
              ),
            );
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "DELETE", `${prefix}/accounts/${named.account.id}`)
                .pipe(Effect.orDie),
            );
            expect(named.account.label).toBe(expected);
            unnamed.push(named.account);
          }
          const [firstDefault] = unnamed;
          if (firstDefault === undefined) return yield* Effect.die("Missing default account");
          const unnamedReconnect = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
              requirement: "service",
              profile: profile.id,
              account: firstDefault.id,
            }),
          );
          expect(
            (yield* body(
              Completed,
              yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${unnamedReconnect.id}/oauth/start`,
                { method: "machine" },
              ),
            )).account,
          ).toEqual(firstDefault);
        }
      }),
    ),
  );
  it.effect(scenarios.oauthClientCredentialsRequestOptions.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const issuer = yield* clientCredentialsIssuer;
        // A service that reads only JSON token requests and comma-separated scopes.
        yield* issuer.configure({ method: "client_secret_basic", format: "json", expiresIn: 20 });
        const prefix = `/api/organizations/${actors.organization.id}`;
        const connect = (options: string) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `Machine request options ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service=defineProvider({name:"JSON reporting",auth:{machine:oauth2({grant:"client_credentials",tokenUrl:${JSON.stringify(issuer.origin + "/token")},scopes:["reports:read","reports:write"],tokenEndpointAuthMethod:"client_secret_basic"${options}})}});
export default defineApp({accounts:{service}},async({accounts})=>({tools: router({
  read:query({input:object({})},async({fetch})=>{const result=await fetch(${JSON.stringify(issuer.origin + "/resource")},{headers:{authorization:"Bearer "+accounts.service.fields.access_token}});return result.json();}),
})}));`,
                },
                appsManifest,
              ],
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
            const started = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/start`,
              { method: "machine", label: "JSON reporting", client: machineClient },
            );
            return { app, profile, started };
          });

        // The default form request is refused by this service.
        const requests = (yield* issuer.metrics).requests;
        const form = yield* connect("");
        expect(form.started.status, JSON.stringify(form.started.body)).toBe(422);
        expect(form.started.body).toMatchObject({
          _tag: "OAuthSetupFailed",
          reason: "token_exchange",
          cause: { stage: "clientCredentials", status: 400, providerError: "invalid_request" },
        });
        expect((yield* issuer.metrics).requests).toBe(requests + 1);
        expect((yield* issuer.metrics).observed).toMatchObject({
          contentType: "application/x-www-form-urlencoded",
          scope: "reports:read reports:write",
        });

        const json = yield* connect(`,scopeSeparator:",",tokenRequestFormat:"json"`);
        expect(json.started.status, JSON.stringify(json.started.body)).toBe(200);
        const completed = yield* body(Completed, json.started);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${completed.account.id}`)
            .pipe(Effect.orDie),
        );
        const sent = {
          grant: "client_credentials",
          scope: "reports:read,reports:write",
          resource: null,
          contentType: "application/json",
          hasCallback: false,
          authenticated: true,
        };
        expect((yield* issuer.metrics).observed).toEqual(sent);

        // The token expires inside the host's refresh window, so the call renews with the same
        // options the account connected with.
        const before = (yield* issuer.metrics).generation;
        const read = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${json.app.id}/tools/call`,
          { profile: json.profile.id, tool: "read", kind: "query", input: {} },
        );
        expect(read.status, JSON.stringify(read.body)).toBe(200);
        const value = yield* body(Read, read);
        expect(value.authenticated).toBe(true);
        expect(value.generation).toBeGreaterThan(before);
        expect((yield* issuer.metrics).observed).toEqual(sent);
      }),
    ),
  );
});
