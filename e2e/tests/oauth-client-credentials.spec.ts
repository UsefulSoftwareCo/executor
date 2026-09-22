import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { Resource, Inventory } from "../support/contracts.ts";
import { clientCredentialsIssuer, machineClient } from "../support/client-credentials-issuer.ts";
import { scenarios } from "../test-plan.ts";
import { Browser } from "../support/browser.ts";

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  account: Schema.Struct({ id: Schema.String, label: Schema.String }),
});
const Selection = Schema.Struct({ accounts: Schema.Struct({ service: Schema.String }) });
const Read = Schema.Struct({ authenticated: Schema.Boolean, generation: Schema.Number });

layer(HostedLive, { excludeTestServices: true })("Machine OAuth", (it) => {
  it.effect(scenarios.oauthClientForm.title, (context) =>
    withCase(
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
              content: `import { defineApp, defineProvider, oauth2 } from "apps";
const service=defineProvider({name:"Reporting",auth:{machine:oauth2({grant:"client_credentials",tokenUrl:${JSON.stringify(issuer.origin + "/token")},scopes:["reports:read"],tokenEndpointAuthMethod:"client_secret_post"})}});
export default defineApp({accounts:{service}},async()=>({queries:{}}));`,
            },
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
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=overview`),
        );
        yield* browser.use("Open Connect", (page) =>
          page.getByRole("button", { name: "Connect Reporting", exact: true }).click(),
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
            .then(() => dialog.getByLabel("Account name", { exact: true }).fill("Team reports"))
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
            .then(() =>
              Promise.all([
                dialog.getByLabel("Account name", { exact: true }).inputValue(),
                dialog
                  .getByLabel("Client secret", { exact: true })
                  .inputValue()
                  .then((value) => value === machineClient.clientSecret),
              ]),
            )
            .then(([name, secretRetained]) => {
              expect(name).toBe("Team reports");
              expect(secretRetained).toBe(true);
            });
        });
        yield* browser.use("Retry the same connection", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Connect Reporting", exact: true })
            .click(),
        );
        yield* browser.use("Immediate completion updates the app", (page) =>
          page
            .getByRole("dialog")
            .waitFor({ state: "hidden" })
            .then(() =>
              page
                .getByRole("region", { name: "App accounts", exact: true })
                .getByText("Team reports", { exact: true })
                .waitFor({ state: "visible" }),
            )
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
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const issuer = yield* clientCredentialsIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        for (const authMethod of [
          "client_secret_basic",
          "client_secret_post",
          "client_secret_basic_raw",
        ] as const) {
          yield* issuer.configure({ method: authMethod, expiresIn: 1, rejected: false });
          const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Machine OAuth ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2, query, object } from "apps";
const service=defineProvider({name:${JSON.stringify(authMethod)},auth:{machine:oauth2({grant:"client_credentials",${authMethod === "client_secret_post" ? `discover:${JSON.stringify(issuer.origin)}` : `tokenUrl:${JSON.stringify(issuer.origin + "/token")}`},scopes:["reports:read"],resource:${JSON.stringify(issuer.origin + "/resource")},tokenEndpointAuthMethod:${JSON.stringify(authMethod)}})}});
export default defineApp({accounts:{service}},async({accounts})=>({queries:{read:query({input:object({})},async({fetch})=>{const result=await fetch(${JSON.stringify(issuer.origin + "/resource")},{headers:{authorization:"Bearer "+accounts.service.fields.access_token}});return result.json();})}}));`,
              },
            ],
          });
          expect(response.status).toBe(200);
          const app = yield* body(Resource, response);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
              requirement: "service",
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
              yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}`),
            )).accounts.service,
          ).toBe(completed.account.id);
          const read = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${app.id}/tools/call`,
            { tool: "queries.read", input: {} },
          );
          expect(read.status).toBe(200);
          const value = yield* body(Read, read);
          expect(value.authenticated).toBe(true);
          expect(value.generation).toBeGreaterThan(issued);
          expect((yield* issuer.metrics).observed?.scope).toBe("reports:read");
          yield* issuer.configure({ rejected: true });
          const failed = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${app.id}/tools/call`,
            { tool: "queries.read", input: {} },
          );
          expect(failed.status).not.toBe(200);
          yield* issuer.configure({ rejected: false, expiresIn: 120 });
          const reconnect = yield* body(
            Resource,
            yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/accounts/${completed.account.id}/connections`,
            ),
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
            }),
          );
          const exchange = yield* api
            .request(actors.owner, "POST", `${prefix}/connections/${raced.id}/oauth/start`, payload)
            .pipe(Effect.forkChild);
          yield* pause.entered;
          expect(
            (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/accounts`, {
              accounts: {},
            })).status,
          ).toBe(200);
          yield* pause.release;
          expect((yield* Fiber.join(exchange)).status).toBe(409);
          expect(
            (yield* body(
              Schema.Struct({ accounts: Schema.Record(Schema.String, Schema.Unknown) }),
              yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}`),
            )).accounts,
          ).toEqual({});
          const after = yield* body(
            Inventory,
            yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
          );
          expect(after.accounts.map((account) => account.id).sort()).toEqual(
            before.accounts.map((account) => account.id).sort(),
          );
        }
      }),
    ),
  );
});
