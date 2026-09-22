/** Deploy and roll back a real hosted app while its original browser tab stays open. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { openPrivateApp, waitForAppUrl } from "../support/app-pages.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";

const Deployed = Schema.Struct({ ...App.fields, activeDeployment: Schema.String });
const files = (live: boolean) => [
  {
    path: "index.ts",
    content: `import { defineApp, query, object, string } from "apps";
export const version = query({ input: object({}), output: string() }, async () => "${live ? "Live version" : "Static version"}");
export const hostCache = query({ input: object({ key: string() }), output: string() }, async (_, { key }) => {
  try {
    const cache = await caches.open("executor-private-runtime-builds-v1");
    return (await cache.match(key)) === undefined ? "isolated" : "visible";
  } catch { return "unavailable"; }
});
export default defineApp({ accounts: {} }, { queries: { version, hostCache } });`,
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
        const readVersion = () =>
          api.request(actors.owner, "POST", `${path}/data/query`, {
            name: "version",
            input: {},
          });
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        expect((yield* readVersion()).body).toBe("Static version");
        expect((yield* readVersion()).body).toBe("Static version");
        const target = yield* Target;
        if (target.metadata.target === "cloud") {
          const evidence = yield* Evidence;
          const telemetry = yield* Telemetry;
          const request = (yield* evidence.requests).at(-1);
          if (request === undefined)
            return yield* Effect.die("Warm query request evidence missing");
          const warm = yield* telemetry.query(request.traceId).pipe(
            Effect.flatMap((result) =>
              result.data.some((row) => row.span.operationName === "http.server POST") &&
              result.data.some((row) => row.span.operationName === "runtime.cloud.query")
                ? Effect.succeed(result)
                : Effect.fail(new Error("The warm query trace has not reached the collector")),
            ),
            Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
          );
          yield* evidence.json("warm-runtime-query.json", warm);
          expect(
            warm.data.filter((row) => row.span.operationName === "runtime.cloud.build.cached"),
            "A warm API runtime does not load its retained server build again",
          ).toHaveLength(0);
          expect(warm.data.some((row) => row.span.operationName === "storage.blob.get")).toBe(
            false,
          );
          const deployment = yield* body(
            Schema.Struct({ build: Schema.String }),
            yield* api.request(actors.owner, "GET", `${path}/source`),
          );
          const isolation = yield* api.request(actors.owner, "POST", `${path}/data/query`, {
            name: "hostCache",
            input: {
              key: new URL(
                `/_executor/runtime-build-cache/${encodeURIComponent(deployment.build)}`,
                target.metadata.origin,
              ).href,
            },
          });
          expect(isolation.status).toBe(200);
          expect(["isolated", "unavailable"]).toContain(isolation.body);
          yield* evidence.json("runtime-cache-isolation.json", { result: isolation.body });
        }
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
        expect((yield* readVersion()).body).toBe("Live version");
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
        expect((yield* readVersion()).body).toBe("Static version");
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
