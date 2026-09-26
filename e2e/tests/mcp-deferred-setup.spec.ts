/**
 * Quick add cannot confirm an unavailable server, so it keeps the form and retries. After an app is
 * added, a later outage cannot erase an account setup draft or hide the app.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
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
        const apps: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* issuer.configure({ mcpStatus: null });
            yield* upstream.configure(undefined);
            for (const id of apps)
              yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${id}`);
          }).pipe(Effect.orDie),
        );
        yield* issuer.configure({ mcpStatus: 520 });
        const name = `MCP connection ${randomUUID().slice(0, 8)}`;
        yield* browser.login(actors.owner);
        const submit = (label: string) =>
          browser.use(label, (page) =>
            Promise.all([
              page.waitForResponse(
                (response) =>
                  response.url().endsWith("/apps/import") && response.request().method() === "POST",
              ),
              page.getByRole("button", { name: "Add app", exact: true }).click(),
            ]).then(([saved]) => saved.json().then((body) => ({ status: saved.status(), body }))),
          );
        yield* browser.use("Fill the MCP server form", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/apps/add/custom`)
            .then(() => page.getByLabel("App name", { exact: true }).fill(name))
            .then(() =>
              page.getByLabel("MCP server URL", { exact: true }).fill(`${issuer.origin}/mcp`),
            ),
        );
        const rejected = yield* submit("Add MCP app while its server returns 520");
        expect(rejected.status, "An unconfirmed server is not added").toBe(422);
        expect(rejected.body).toMatchObject({ code: "mcp_probe" });
        expect(
          yield* browser.use("The form keeps its draft beside the error", (page) =>
            Promise.all([
              page.getByLabel("App name", { exact: true }).inputValue(),
              page.getByText("The MCP server could not respond right now.").count(),
            ]),
          ),
        ).toEqual([name, 1]);
        yield* browser.checkpoint("Quick add reports an unreachable MCP server");
        yield* issuer.configure({ mcpStatus: null });
        // The saved app's Accounts tab preloads setup. Hold that separate read to isolate import.
        const initialSetup = yield* holdQuery(
          /\/providers\/[^/]+\/oauth\/oauth\/setup$/,
          "continue",
        );
        const imported = yield* submit("Retry after the server recovers");
        expect(imported.status, JSON.stringify(imported.body)).toBe(200);
        const app = yield* Schema.decodeUnknownEffect(App)(imported.body);
        apps.push(app.id);
        yield* issuer.configure({ mcpStatus: 520 });
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

        const remote = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
          source: { kind: "mcp", name: "Public MCP connection", url: `${upstream.origin}/mcp` },
        });
        expect(remote.status, JSON.stringify(remote.body)).toBe(200);
        expect(remote.body, "A public server needs no account").toMatchObject({
          requirements: { accounts: {} },
        });
        const publicApp = yield* body(App, remote);
        apps.push(publicApp.id);
        const path = `${prefix}/apps/${publicApp.id}`;
        const profile = yield* createProfile(actors.owner, path);
        yield* upstream.configure({ status: 520, accounts: "all" });
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
            .then(() =>
              page.getByRole("heading", { name: "queries.identity", exact: true }).waitFor(),
            ),
        );
        expect(
          (yield* api.request(actors.owner, "GET", `${path}/tools?profile=${profile.id}`)).status,
        ).toBe(200);
      }),
    ),
  );
});
