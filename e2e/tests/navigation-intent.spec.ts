import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import type { Page, Request } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

/** Whether a request reads this app's record, batched with other reads or on its own. */
const readsApp = (request: Request, app: string) => {
  const path = new URL(request.url()).pathname;
  if (request.method() === "GET")
    return new RegExp(`^/api/organizations/[^/]+/apps/${app}$`).test(path);
  const batch = request.postData() ?? "";
  return (
    path === "/api/dashboard/batch" &&
    batch.includes(`"group":"apps","endpoint":"get"`) &&
    batch.includes(app)
  );
};

/** Whether a dashboard read batch also asks for this app's tool index. */
const readsTools = (request: Request, app: string) =>
  (request.postData() ?? "").includes(`"group":"tools","endpoint":"index"`) &&
  (request.postData() ?? "").includes(app);

layer(HostedLive, { excludeTestServices: true })("Navigation intent", (it) => {
  it.effect(scenarios.navigationIntentReads.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Intent example ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `
import { defineApp, query, object, router } from "apps";
export default defineApp({}, async () => ({
  tools: router({
    hello: query({ description: "A simple greeting", input: object({}) }, async () => "Hello"),
  })
}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        yield* browser.login(actors.owner);
        const appsPath = `/org/${actors.organization.slug}/apps`;
        const link = (page: Page) => page.getByRole("main").getByRole("link", { name: app.name });
        yield* browser.use("Open the app list", (page) => page.goto(appsPath));
        yield* browser.use("Wait for the app's link", (page) => link(page).waitFor());
        const reads: Request[] = [];
        yield* browser.use("Watch for reads of the app", (page) => {
          page.on("request", (request) => {
            if (readsApp(request, app.id)) reads.push(request);
          });
          return Promise.resolve();
        });
        // Hovering shows intent: the app is read while the list is still open. The list already
        // names the app's version and accounts, so its tools are read in the same batch.
        const [hovered] = yield* browser.use("Hover the app's link", (page) =>
          Promise.all([
            page
              .waitForRequest((request) => readsApp(request, app.id))
              .then((read) => read.response().then(() => read)),
            link(page).hover(),
          ]),
        );
        expect(readsTools(hovered, app.id)).toBe(true);
        expect(
          yield* browser.use("Read the current path", (page) =>
            Promise.resolve(new URL(page.url()).pathname),
          ),
        ).toBe(appsPath);
        expect(reads).toHaveLength(1);
        // Opening the app renders it from that read instead of reading it again.
        yield* browser.use("Open the app", (page) => link(page).click());
        // The tools preview reads the app's tools after the page mounts, so any read of the app
        // the page started itself has been sent by the time it shows.
        yield* browser.use("Wait for the app's tools", (page) =>
          page.getByRole("main").getByText("A simple greeting").first().waitFor(),
        );
        expect(reads).toHaveLength(1);
      }),
    ),
  );
});
