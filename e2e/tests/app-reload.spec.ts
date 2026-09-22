/** Deploy and roll back a real hosted app while its original browser tab stays open. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { openPrivateApp, waitForAppUrl } from "../support/app-pages.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";

const Deployed = Schema.Struct({ ...App.fields, activeDeployment: Schema.String });
const files = (live: boolean) => [
  {
    path: "index.ts",
    content: `import { defineApp, query, object, string } from "apps";
export const version = query({ input: object({}), output: string() }, async () => "Live version");
export default defineApp({ accounts: {} }, { queries: { version } });`,
  },
  {
    path: "package.json",
    content: JSON.stringify({ dependencies: { react: "19.2.0", "react-dom": "19.2.0" } }),
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Reload fixture</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
  },
  {
    path: "ui/main.tsx",
    content: live
      ? `import React from "react";
import { createRoot } from "react-dom/client";
import { string } from "apps";
import { createAppClient, queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type { version } from "../index";
const client = createAppClient();
const result = client.queryAtom(queryReference<typeof version>("version"), {}, string());
function App() {
  const { data, error } = useAppQuery(result);
  return <main><h1>{data || "Loading"}</h1><p role="status">{error || "Ready"}</p></main>;
}
createRoot(document.getElementById("root")).render(<App />);`
      : `import React from "react";
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")).render(<main><h1>Static version</h1><label>Draft<input /></label></main>);`,
  },
];

layer(HostedLive, { excludeTestServices: true })("Hosted app reload", (it) => {
  it.effect(scenarios.appReload.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Reload ${randomUUID().slice(0, 8)}`,
          files: files(false),
        });
        expect(response.status).toBe(200);
        const original = yield* body(Deployed, response);
        const path = `${prefix}/apps/${original.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const url = yield* waitForAppUrl(actors.owner, `${path}/ui`);
        const bookmark = `${url}/notes?filter=active#draft`;
        yield* browser.omitNetworkTrace;
        for (const endpoint of ["version", "watch.js"]) {
          expect(
            (yield* browser.use("Unsigned watcher requests stay private", (page) =>
              page.context().request.get(`${url}/_executor/${endpoint}`),
            )).status(),
          ).toBe(401);
        }
        yield* browser.login(actors.owner);
        yield* openPrivateApp(bookmark);
        yield* browser.use("A page without app queries is ready", (page) =>
          page.getByRole("heading", { name: "Static version", exact: true }).waitFor(),
        );
        // The initial page's watcher stays open. Disable only the next document's
        // version connection, so its query stream must recover a missed notification.
        let blockedVersions = 0;
        yield* browser.use("Drop the next version connection", (page) =>
          page.route("**/_executor/version", (route) => {
            blockedVersions++;
            return route.abort();
          }),
        );
        const updated = yield* saveAndDeploy(actors.owner, path, {
          files: files(true),
        });
        expect(updated.status).toBe(200);
        const { app: live } = yield* body(Schema.Struct({ app: Deployed }), updated);
        yield* browser.use("The static page automatically loads the new deployment", (page) =>
          page
            .getByRole("heading", { name: "Live version", exact: true })
            .waitFor({ timeout: 20_000 }),
        );
        expect(blockedVersions).toBeGreaterThan(0);
        expect(
          yield* browser.use("Reload keeps the bookmark", (page) => Promise.resolve(page.url())),
        ).toBe(bookmark);
        yield* browser.checkpoint("New deployment loaded automatically");
        const activated = yield* api.request(actors.owner, "POST", `${path}/activate`, {
          deployment: original.activeDeployment,
          expectedDeployment: live.activeDeployment,
        });
        expect(activated.status).toBe(200);
        yield* browser.use(
          "An outdated query stream automatically reloads after rollback",
          (page) =>
            page
              .getByRole("heading", { name: "Static version", exact: true })
              .waitFor({ timeout: 20_000 }),
        );
        expect(
          yield* browser.use("Rollback keeps the bookmark", (page) => Promise.resolve(page.url())),
        ).toBe(bookmark);
        yield* browser.use("Restore the version connection", (page) =>
          page.unroute("**/_executor/version"),
        );
        yield* browser.checkpoint("Rollback loaded automatically");
        expect(
          (yield* browser.use("Cross-origin version reads are rejected", (page) =>
            page.context().request.get(`${url}/_executor/version`, {
              headers: { origin: "https://other.example.test" },
            }),
          )).status(),
        ).toBe(403);
      }),
    ),
  );
});
