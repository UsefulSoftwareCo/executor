/** Copies go through real product authorization, Git storage, runtime builds and browser forms. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Workspace, saveAndDeploy } from "../support/app-authoring.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { Browser } from "../support/browser.ts";
import { holdQuery } from "../support/query-transition.ts";

const App = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  code: Schema.String,
  activeDeployment: Schema.NullOr(Schema.String),
  copiedFrom: Schema.NullOr(
    Schema.Struct({
      reference: Schema.String,
      name: Schema.String,
      commit: Schema.NullOr(Schema.String),
    }),
  ),
});
const files = (message: string) => [
  {
    path: "index.ts",
    content: `import {defineApp,object,query} from 'apps'; export default defineApp({accounts:{}},async()=>({queries:{hello:query({input:object({})},async()=>${JSON.stringify(message)})}}));`,
  },
];

layer(HostedLive, { excludeTestServices: true })("Independent app copies", (it) => {
  it.effect(scenarios.appCopies.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const name = `Copy example ${randomUUID().slice(0, 8)}`;
        const remember = (app: typeof App.Type) =>
          Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
        const create = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files: files("running"),
        });
        expect(create.status).toBe(200);
        const original = yield* body(App, create);
        yield* remember(original);
        const path = `${prefix}/apps/${original.id}`;
        const working = yield* body(
          Workspace,
          yield* api.request(actors.owner, "GET", `${path}/workspace`),
        );
        const edited = yield* api.request(actors.owner, "POST", `${path}/commits`, {
          expected: working.revision.commit,
          files: files("unpublished"),
          message: "Private working edit",
        });
        expect(edited.status).toBe(200);
        const ahead = yield* body(Workspace, edited);
        const copyInput = { from: { app: original.id }, name: `${name} own copy` };
        expect(
          (yield* api.request(yield* api.session(), "POST", `${prefix}/apps/copies`, copyInput))
            .status,
        ).toBe(401);
        expect(
          (yield* api.request(actors.member, "POST", `${prefix}/apps/copies`, copyInput)).status,
        ).toBe(403);
        const copied = yield* api.request(actors.owner, "POST", `${prefix}/apps/copies`, copyInput);
        expect(copied.status).toBe(200);
        const copy = yield* body(App, copied);
        yield* remember(copy);
        expect(copy.code).not.toBe(original.code);
        expect(copy.activeDeployment).not.toBeNull();
        expect(copy.activeDeployment).not.toBe(original.activeDeployment);
        expect(copied.body).not.toHaveProperty("accounts");
        expect(copy.copiedFrom?.reference).toBe(`app:${original.id}`);
        expect(copy.copiedFrom?.name).toBe(original.name);
        const copyPath = `${prefix}/apps/${copy.id}`;
        expect(
          (yield* body(Workspace, yield* api.request(actors.owner, "GET", `${copyPath}/workspace`)))
            .files,
        ).toEqual(files("running"));
        const history = yield* body(
          Schema.Array(Schema.Struct({ commit: Schema.String })),
          yield* api.request(actors.owner, "GET", `${copyPath}/history`),
        );
        expect(history).toHaveLength(1);
        expect(history.map((entry) => entry.commit)).not.toContain(ahead.revision.commit);
        const pinned = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          commit: working.revision.commit,
        });
        expect(pinned.status).toBe(200);
        expect(
          (yield* body(Workspace, yield* api.request(actors.owner, "GET", `${path}/workspace`)))
            .revision.commit,
        ).toBe(ahead.revision.commit);
        const renamed = yield* body(
          App,
          yield* api.request(actors.owner, "PATCH", `${copyPath}/name`, {
            name: `${name} renamed`,
          }),
        );
        expect(renamed.copiedFrom).toEqual(copy.copiedFrom);
        const deployed = yield* saveAndDeploy(actors.owner, copyPath, {
          files: files("my edit"),
        });
        expect(deployed.status).toBe(200);
        expect((yield* body(Schema.Struct({ app: App }), deployed)).app.copiedFrom).toEqual(
          copy.copiedFrom,
        );
        expect(
          (yield* body(Workspace, yield* api.request(actors.owner, "GET", `${path}/workspace`)))
            .files,
        ).toEqual(files("unpublished"));
        const unfinished = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/drafts`, {
            name: `${name} unfinished`,
            files: [{ path: "index.ts", content: "Unfinished source" }],
          }),
        );
        yield* remember(unfinished);
        const saved = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/copies`, {
            from: { app: unfinished.id },
            name: `${name} saved`,
          }),
        );
        yield* remember(saved);
        expect(saved.activeDeployment).toBeNull();
        expect(saved.copiedFrom?.reference).toBe(`app:${unfinished.id}`);

        yield* browser.login(actors.owner);
        yield* browser.use("Open the copied app settings", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${copy.id}?view=settings`),
        );
        yield* browser.use("The copied origin is visible", (page) =>
          page
            .getByRole("region", { name: "Copied from" })
            .getByText(original.name, { exact: true })
            .waitFor(),
        );
        yield* browser.checkpoint("Independent copy with its origin");
        yield* browser.use("Start another copy", (page) =>
          page
            .getByRole("region", { name: "Copy app", exact: true })
            .getByRole("button", { name: "Make a copy", exact: true })
            .click(),
        );
        const browserName = `${name} browser`;
        yield* browser.use("Name the copy", (page) =>
          page.getByRole("dialog").getByLabel("App name").fill(browserName),
        );
        const hold = yield* holdQuery(
          [`${prefix}/apps/copies`, `/api/organizations/${actors.organization.slug}/apps/copies`],
          "continue",
          { method: "POST" },
        );
        yield* browser.use("Submit the copy", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Make a copy", exact: true })
            .click(),
        );
        yield* hold.requested;
        expect(
          yield* browser.use("Cancel stays disabled while copying", (page) =>
            page
              .getByRole("dialog")
              .getByRole("button", { name: "Cancel", exact: true })
              .isDisabled(),
          ),
        ).toBe(true);
        expect(
          yield* browser.use("The name is retained while copying", (page) =>
            page.getByRole("dialog").getByLabel("App name").inputValue(),
          ),
        ).toBe(browserName);
        yield* browser.checkpoint("Copy submission pending");
        yield* hold.release;
        yield* browser.use("The copy opens after its metadata is saved", (page) =>
          page.getByRole("heading", { name: `${browserName} overview`, exact: true }).waitFor(),
        );
        const listed = yield* body(
          Schema.Array(App),
          yield* api.request(actors.owner, "GET", `${prefix}/apps`),
        );
        const browserCopy = listed.find((app) => app.name === browserName);
        expect(browserCopy).toBeDefined();
        if (browserCopy) yield* remember(browserCopy);
        yield* browser.checkpoint("Copied app opened");
      }),
    ),
  );
});
