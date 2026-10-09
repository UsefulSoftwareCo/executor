/** A failing app query backs off, shows its failure and recovers when the app does. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { withApps } from "../support/apps-release.ts";

const files = [
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: withApps({ react: "^19.2.0", "react-dom": "^19.2.0" }),
    }),
  },
  {
    path: "index.ts",
    content: `import { defineApp, query, mutation, object, string, router } from "apps";
export const status = query({ input: object({}), output: string() }, async ({ sql }) => {
  const repairs = sql.exec("SELECT note FROM repairs").toArray();
  if (repairs.length === 0) throw new Error("Upstream is unavailable");
  return "Repaired";
});
export const repair = mutation({ input: object({}), output: string() }, async ({ sql }) => {
  sql.exec("INSERT INTO repairs (note) VALUES ('repaired')"); return "ok";
});
export default defineApp({ accounts: {} }, { tools: router({ status, repair }) });`,
  },
  {
    path: "migrations/0001_repairs.sql",
    content: "CREATE TABLE repairs (note TEXT NOT NULL);\n",
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Failing app</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
  },
  {
    path: "ui/main.tsx",
    content: `import React from "react";
import { createRoot } from "react-dom/client";
import { string } from "apps";
import { createAppClient, queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type { status } from "../index";
const client = createAppClient();
const current = client.queryAtom(queryReference<typeof status>("status"), {}, string());
function App() {
  const { data, pending, error } = useAppQuery(current);
  return <main><h1>Failing app</h1><p role="status">{error ?? (pending ? "Loading" : data)}</p></main>;
}
createRoot(document.getElementById("root")).render(<App />);`,
  },
];

/** Minimum waits before the first three retries: 1, 2 and 4 seconds, less 20% jitter. */
const minimumGaps = [800, 1_600, 3_200];

layer(HostedLive, { excludeTestServices: true })("App query failure", (it) => {
  it.effect(scenarios.appQueryFailureBackoff.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Failing ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
        yield* browser.login(actors.owner);

        const attempts: number[] = [];
        yield* browser.use("Count subscription attempts", (page) =>
          Promise.resolve(
            page.on("request", (request) => {
              if (new URL(request.url()).pathname === "/_executor/api/subscribe")
                attempts.push(Date.now());
            }),
          ),
        );
        yield* browser.use("Open the app while its query fails", (page) => page.goto(url));
        yield* browser.use("The failure is shown instead of a loading state", (page) =>
          page.getByRole("status").filter({ hasText: "Could not load app data." }).waitFor(),
        );
        yield* Effect.suspend(() =>
          attempts.length > minimumGaps.length ? Effect.void : Effect.fail("pending" as const),
        ).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 200 }), Effect.orDie);
        const gaps = yield* Effect.forEach(minimumGaps, (minimum, index) => {
          const before = attempts[index];
          const after = attempts[index + 1];
          return before === undefined || after === undefined
            ? Effect.die(new Error("A counted attempt is missing"))
            : Effect.succeed({ retry: index + 1, gap: after - before, minimum });
        });
        yield* evidence.json("failing-subscription-gaps.json", { gaps });
        // The former fixed one-second retry left about the same short gap after every failure.
        for (const { retry, gap, minimum } of gaps)
          expect(gap, `wait before retry ${retry}`).toBeGreaterThanOrEqual(minimum);
        yield* browser.use("The failure stays visible while retrying", (page) =>
          page.getByRole("status").filter({ hasText: "Could not load app data." }).waitFor(),
        );

        // Repair through the API, so only a new subscription can show it on the watching page.
        const repaired = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/tools/call`,
          { tool: "repair", kind: "mutation", input: {} },
        );
        expect(repaired.status, "repair").toBe(200);
        // The next retry, at most 9.6 seconds after the fourth attempt, reads the repaired app.
        yield* browser.use("The watching page recovers by subscribing again", (page) =>
          page.getByRole("status").filter({ hasText: "Repaired" }).waitFor({ timeout: 20_000 }),
        );
        yield* browser.checkpoint("Recovered app page");
      }),
    ),
  );
});
