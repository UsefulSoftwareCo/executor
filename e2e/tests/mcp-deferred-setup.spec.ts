/** An unavailable remote server cannot prevent saving an app or erase its setup draft. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import {
  publicProviderErrorUpstream,
  providerSecretMarker,
} from "../support/provider-error-upstream.ts";
import { createProfile } from "../support/profiles.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Deferred MCP setup", (it) => {
  it.effect(scenarios.mcpDeferredSetup.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const issuer = yield* oauthSetupIssuer;
        const upstream = yield* publicProviderErrorUpstream;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const apps: string[] = [],
          accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* issuer.configure({ mcpStatus: null });
            yield* upstream.configure(undefined);
            for (const id of apps)
              yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${id}`);
            for (const id of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
          }).pipe(Effect.orDie),
        );
        yield* issuer.configure({ mcpStatus: 520 });
        const name = `MCP connection ${randomUUID().slice(0, 8)}`;
        yield* browser.login(actors.owner);
        // The saved app's Accounts tab preloads setup. Hold that separate read to isolate import.
        const initialSetup = yield* holdQuery(
          /\/providers\/[^/]+\/oauth\/oauth\/setup$/,
          "continue",
        );
        const imported = yield* browser.use("Add MCP app while its server returns 520", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/apps/add/custom`)
            .then(() => page.getByLabel("App name", { exact: true }).fill(name))
            .then(() => page.getByLabel("Server URL", { exact: true }).fill(`${issuer.origin}/mcp`))
            .then(() =>
              Promise.all([
                page.waitForResponse(
                  (response) =>
                    response.url().endsWith("/apps/import") &&
                    response.request().method() === "POST",
                ),
                page.getByRole("button", { name: "Add app", exact: true }).click(),
              ]),
            )
            .then(([saved]) => saved.json().then((body) => ({ status: saved.status(), body }))),
        );
        expect(imported.status, "An outage must not reject adding the app").toBe(200);
        const app = yield* Schema.decodeUnknownEffect(App)(imported.body);
        apps.push(app.id);
        expect((yield* issuer.metrics).probes, "Import makes no probe request").toBe(0);
        yield* initialSetup.requested;
        yield* initialSetup.release;
        yield* browser.use("Open account setup on the saved app", (page) =>
          page
            .getByRole("button", { name: `Add ${name} account`, exact: true })
            .click()
            .then(() =>
              page
                .getByRole("alert")
                .getByText("The connected service’s sign-in is unavailable", { exact: true })
                .waitFor(),
            )
            .then(() => page.getByLabel("Account name", { exact: true }).fill("Work reports")),
        );
        expect((yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}`)).status).toBe(
          200,
        );
        expect((yield* issuer.metrics).probes).toBeGreaterThan(0);
        yield* browser.checkpoint("Saved MCP app with retryable account setup error");
        const held = yield* holdQuery(
          /\/providers\/[^/]+\/oauth\/oauth\/setup(?:\?|$)/,
          "continue",
        );
        yield* browser.use("Retry setup", (page) =>
          page.getByRole("button", { name: "Try again", exact: true }).click(),
        );
        yield* held.requested;
        expect(
          yield* browser.use("Retry keeps the account draft", (page) =>
            page.getByLabel("Account name", { exact: true }).inputValue(),
          ),
        ).toBe("Work reports");
        expect(
          yield* browser.use("Retry stays pending", (page) =>
            page.getByRole("button", { name: "Checking…", exact: true }).isDisabled(),
          ),
        ).toBe(true);
        yield* issuer.configure({ mcpStatus: null });
        yield* held.release;
        yield* browser.use("Recovered server offers OAuth sign-in", (page) =>
          page.getByRole("button", { name: `Connect ${name}`, exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Recovery retains the account draft", (page) =>
            page.getByLabel("Account name", { exact: true }).inputValue(),
          ),
        ).toBe("Work reports");
        expect(
          yield* browser.use("Recovery clears the error", (page) =>
            page.getByRole("alert").count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("OAuth setup recovers without adding the app again");

        yield* upstream.configure({ status: 520, accounts: "all" });
        const remote = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
          source: {
            kind: "mcp",
            name: "Public MCP connection",
            url: `${upstream.origin}/mcp`,
            auth: { type: "auto" },
          },
        });
        expect(remote.status).toBe(200);
        const publicApp = yield* body(App, remote);
        apps.push(publicApp.id);
        const path = `${prefix}/apps/${publicApp.id}`;
        const profile = yield* createProfile(actors.owner, path);
        yield* browser.use("Explicitly choose a public connection", (page) =>
          page
            .goto(
              `/org/${actors.organization.slug}/apps/${publicApp.id}?view=accounts&profile=${profile.id}`,
            )
            .then(() =>
              page
                .getByRole("button", { name: "Add Public MCP connection account", exact: true })
                .click(),
            )
            .then(() => page.getByRole("combobox", { name: "Sign-in method" }).click())
            .then(() =>
              page
                .getByRole("option", { name: "No authentication (public server)", exact: true })
                .click(),
            )
            .then(() =>
              page
                .getByText(
                  "This connection sends no credentials. Continue only if the service supports public access.",
                  { exact: true },
                )
                .waitFor(),
            )
            .then(() => page.getByLabel("Account name", { exact: true }).fill("Public connection")),
        );
        yield* browser.checkpoint("Public access requires an explicit selection");
        const saved = yield* browser.use("Save the explicit public connection", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.url().endsWith("/submit") && response.request().method() === "POST",
            ),
            page.getByRole("button", { name: "Connect account", exact: true }).click(),
          ]).then(([response]) => response.json()),
        );
        accounts.push((yield* Schema.decodeUnknownEffect(Resource)(saved)).id);
        const tools = yield* api.request(
          actors.owner,
          "GET",
          `${path}/tools?profile=${profile.id}`,
        );
        expect(tools.status).toBe(502);
        expect(tools.body).toMatchObject({
          _tag: "AppProviderFailed",
          reason: "unavailable",
          status: 520,
        });
        expect(JSON.stringify(tools.body)).not.toContain(providerSecretMarker);
        yield* browser.use("Show the outage inside the saved app", (page) =>
          page
            .goto(
              `/org/${actors.organization.slug}/apps/${publicApp.id}?view=tools&profile=${profile.id}`,
            )
            .then(() =>
              page
                .getByRole("heading", { name: "Service temporarily unavailable", exact: true })
                .waitFor(),
            ),
        );
        expect(
          yield* browser.use("Outages do not direct users to replace credentials", (page) =>
            page.getByRole("link", { name: "Manage account", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("MCP server outage appears inside the app with retry");
        yield* browser.use("Mobile connection error", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.checkpoint("MCP server outage on mobile");
        yield* upstream.configure(undefined);
        yield* browser.use("Retry tools after recovery", (page) =>
          page
            .getByRole("button", { name: "Try again", exact: true })
            .click()
            .then(() => page.getByText("queries.identity", { exact: true }).first().waitFor()),
        );
        expect(
          (yield* api.request(actors.owner, "GET", `${path}/tools?profile=${profile.id}`)).status,
        ).toBe(200);
        // Explicit public imports retain their account-free shape even while the server is down.
        yield* upstream.configure({ status: 520, accounts: "all" });
        const direct = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
          source: {
            kind: "mcp",
            name: "Known public MCP",
            url: `${upstream.origin}/mcp`,
            auth: { type: "none" },
          },
        });
        expect(direct.status).toBe(200);
        const known = yield* body(App, direct);
        apps.push(known.id);
        expect(direct.body).toMatchObject({ requirements: { accounts: {} } });
        const anonymousFailure = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${known.id}/tools`,
        );
        expect(anonymousFailure.body).toMatchObject({
          _tag: "AppProviderFailed",
          reason: "unavailable",
          status: 520,
        });
      }),
    ),
  );
});
