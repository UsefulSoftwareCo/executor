import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsVersion } from "../support/apps-release.ts";
import { Committed, saveAndDeploy, Workspace } from "../support/app-authoring.ts";
import { connectionsPath, linkedAccountIds } from "../support/app-accounts.ts";
import { eventually } from "../support/background-service.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { publishScenarioApp } from "../support/public-catalogs.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Installed = Schema.Struct({ id: Schema.String, activeVersion: Schema.String });
const Source = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, content: Schema.optional(Schema.String) }),
  ),
});
const Offer = Schema.NullOr(
  Schema.Struct({
    reconnect: Schema.Number,
    reasons: Schema.Array(Schema.String),
    touched: Schema.Boolean,
  }),
);

const packageName = "@executor.sh/synthetic-notes";
const notes = (marker: string, provider = "Synthetic Notes") => ({
  package: packageName,
  files: [
    {
      path: "index.ts",
      content: `import { defineApp, defineProvider, object, query, router, secrets, string } from "apps";

const notes = defineProvider({
  name: ${JSON.stringify(provider)},
  auth: { apiKey: secrets({ label: "API key", fields: object({ token: string({ minLength: 1 }) }) }) },
});

export default defineApp({ user: { accounts: { notes } } }, async () => ({
  tools: router({
    list: query({ input: object({}), description: ${JSON.stringify(marker)} }, async () => []),
  }),
}));
`,
    },
    {
      path: "package.json",
      content: `${JSON.stringify(
        {
          name: packageName,
          private: true,
          type: "module",
          dependencies: { apps: appsVersion },
          executor: { title: "Synthetic Notes" },
        },
        null,
        2,
      )}\n`,
    },
  ],
});

layer(HostedLive, { excludeTestServices: true })("Catalog app updates", (it) => {
  it.effect(scenarios.catalogAppUpdates.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const suffix = randomUUID().slice(0, 8);
        const entry = yield* publishScenarioApp(`notes-${suffix}`, notes("Notes 1"));
        const install = (name: string) =>
          Effect.gen(function* () {
            const app = yield* body(
              Installed,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/install`, { entry, name }),
            );
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const read = (app: string) =>
          api
            .request(actors.owner, "GET", `${prefix}/apps/${app}`)
            .pipe(Effect.flatMap((response) => body(Installed, response)));
        const index = (app: string) =>
          api.request(actors.owner, "GET", `${prefix}/apps/${app}/source`).pipe(
            Effect.flatMap((response) => body(Source, response)),
            Effect.map(({ files }) => files.find((file) => file.path === "index.ts")?.content),
          );
        const workspaceIndex = (app: string) =>
          api.request(actors.owner, "GET", `${prefix}/apps/${app}/workspace`).pipe(
            Effect.flatMap((response) => body(Workspace, response)),
            Effect.map(({ files }) => files.find((file) => file.path === "index.ts")?.content),
          );
        const versions = (app: string) =>
          api.request(actors.owner, "GET", `${prefix}/apps/${app}/versions`).pipe(
            Effect.flatMap((response) => body(Schema.Array(Schema.Unknown), response)),
            Effect.map((listed) => listed.length),
          );
        const offer = (app: string) =>
          api
            .request(actors.owner, "GET", `${prefix}/apps/${app}/catalog-update`)
            .pipe(Effect.flatMap((response) => body(Offer, response)));

        const untouched = yield* install(`Notes ${suffix}`);
        const edited = yield* install(`Edited notes ${suffix}`);
        const dirty = yield* install(`Dirty notes ${suffix}`);
        const connection = yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(`${prefix}/apps/${untouched.id}`, "user", "notes"),
          {},
        );
        expect(connection.status, JSON.stringify(connection.body)).toBe(200);
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${(yield* body(Resource, connection)).id}/submit`,
          { method: "apiKey", label: `Notes key ${suffix}`, fields: { token: "synthetic-notes" } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(
          yield* linkedAccountIds(actors.owner, `${prefix}/apps/${untouched.id}`),
        ).toHaveLength(1);
        const edit = notes("Edited by hand").files;
        const deployed = yield* saveAndDeploy(actors.owner, `${prefix}/apps/${edited.id}`, {
          files: edit,
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const editedVersion = (yield* read(edited.id)).activeVersion;
        const before = yield* body(
          Workspace,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${dirty.id}/workspace`),
        );
        yield* body(
          Committed,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/${dirty.id}/commits`, {
            expected: before.revision.commit,
            files: notes("Saved, not deployed").files,
            message: "Work in progress",
          }),
        );

        yield* publishScenarioApp(`notes-${suffix}`, notes("Notes 2"));
        yield* serverControl("restart");
        const updated = yield* eventually(
          read(untouched.id),
          (app) => app.activeVersion !== untouched.activeVersion,
          "20 seconds",
        );
        expect(yield* index(untouched.id)).toContain('"Notes 2"');
        yield* eventually(
          workspaceIndex(untouched.id),
          (content) => content?.includes('"Notes 2"') === true,
          "20 seconds",
        );
        expect(yield* offer(untouched.id)).toBeNull();
        expect(
          yield* eventually(offer(edited.id), (found) => found !== null, "20 seconds"),
        ).toEqual({ reconnect: 0, reasons: [], touched: true });
        expect((yield* read(edited.id)).activeVersion).toBe(editedVersion);
        expect(yield* index(edited.id)).toContain('"Edited by hand"');

        yield* publishScenarioApp(`notes-${suffix}`, notes("Notes 3", "Synthetic Notes Two"));
        yield* serverControl("restart");
        expect(
          yield* eventually(offer(untouched.id), (found) => found !== null, "20 seconds"),
        ).toEqual({ reconnect: 1, reasons: ["provider"], touched: false });
        expect((yield* read(untouched.id)).activeVersion).toBe(updated.activeVersion);
        expect(yield* versions(untouched.id)).toBe(2);
        expect(yield* index(untouched.id)).toContain('"Notes 2"');
        const refused = yield* api.request(
          actors.member,
          "POST",
          `${prefix}/apps/${untouched.id}/catalog-update`,
        );
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        const hidden = yield* api.request(
          actors.member,
          "GET",
          `${prefix}/apps/${untouched.id}/catalog-update`,
        );
        expect(hidden.status, JSON.stringify(hidden.body)).toBe(403);

        yield* browser.login(actors.owner);
        yield* browser.use("Open the app's versions", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${untouched.id}?view=versions`),
        );
        yield* browser.use("The update is offered", (page) =>
          page
            .getByRole("status")
            .filter({ hasText: "Update available · 1 account needs reconnecting" })
            .waitFor(),
        );
        yield* browser.checkpoint("A breaking catalog update waits for a manager");
        yield* browser.use("Start the update", (page) =>
          page.getByRole("button", { name: "Update", exact: true }).click(),
        );
        yield* browser.use("The update asks first", (page) =>
          page
            .getByRole("dialog", { name: "Update this app?" })
            .getByText("1 linked account stops working until reconnected.", { exact: false })
            .waitFor(),
        );
        yield* browser.checkpoint("The update names the account it breaks");
        yield* browser.use("Confirm the update", (page) =>
          page
            .getByRole("dialog", { name: "Update this app?" })
            .getByRole("button", { name: "Update", exact: true })
            .click(),
        );
        yield* browser.use("The dialog closes once applied", (page) =>
          page.getByRole("dialog", { name: "Update this app?" }).waitFor({ state: "detached" }),
        );
        yield* browser.use("The offer is gone", (page) =>
          page.getByText("Update available", { exact: false }).waitFor({ state: "detached" }),
        );
        yield* browser.checkpoint("The catalog update is applied");
        expect((yield* read(untouched.id)).activeVersion).not.toBe(updated.activeVersion);
        expect(yield* index(untouched.id)).toContain('"Notes 3"');
        expect(yield* workspaceIndex(untouched.id)).toContain('"Notes 3"');
        expect(yield* versions(untouched.id)).toBe(3);
        expect(yield* offer(untouched.id)).toBeNull();
        expect((yield* read(edited.id)).activeVersion).toBe(editedVersion);
        expect(yield* versions(dirty.id)).toBe(1);
        expect(yield* offer(dirty.id)).toBeNull();
        expect(yield* workspaceIndex(dirty.id)).toContain('"Saved, not deployed"');
      }),
    ),
  );
});
