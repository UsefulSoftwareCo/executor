/**
 * A live app query runs only while a page holds it. The image serves its product from a Durable
 * Object, and workerd never cancelled a response body the object streamed after its client went
 * away. Every live query a page opened kept running its query every 15 seconds until the server
 * restarted, so the work of pages long closed piled up on the instance's one JavaScript thread.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schedule, Schema } from "effect";
import { chromium } from "playwright";
import { withApps } from "../support/apps-release.ts";
import { releasedServer } from "../support/docker-release-server.ts";
import { driver } from "../support/platform.ts";

const files = [
  {
    path: "index.ts",
    content: `import { defineApp, query, object, number, router } from "apps";
// Each run counts itself in the app cache, so the test sees whether the query still runs.
export const live = query({ input: object({}), output: number() }, async ({ cache }) => {
  const runs = ((await cache.read("runs", number())) ?? 0) + 1;
  await cache.write([{ key: "runs", value: runs }], "1 hour");
  return runs;
});
export const runs = query({ input: object({}), output: number() }, async ({ cache }) =>
  (await cache.read("runs", number())) ?? 0);
export default defineApp({}, { tools: router({ live, runs }) });`,
  },
  {
    path: "package.json",
    content: JSON.stringify({ dependencies: withApps({ react: "19.2.0", "react-dom": "19.2.0" }) }),
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Live runs</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
  },
  {
    path: "ui/main.tsx",
    content: `import React from "react";
import { createRoot } from "react-dom/client";
import { number } from "apps";
import { createAppClient, queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type { live } from "../index";
const client = createAppClient();
const runs = client.queryAtom(queryReference<typeof live>("live"), {}, number());
function App() {
  const { data } = useAppQuery(runs);
  return <p role="status">{data === undefined ? "Loading" : "Runs " + data}</p>;
}
createRoot(document.getElementById("root")).render(<App />);`,
  },
];

it.live(
  "released image stops a live app query when its page closes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* releasedServer;
        const app = yield* server.deploy("Live runs", files);
        const route = `${server.prefix}/apps/${app.id}`;
        const location = yield* server
          .json(
            Schema.Struct({ status: Schema.String, url: Schema.optional(Schema.String) }),
            `${route}/ui`,
          )
          .pipe(
            Effect.flatMap((ui) =>
              ui.status === "ready" && ui.url !== undefined
                ? Effect.succeed(ui.url)
                : Effect.fail(new Error(`app page is ${ui.status}`)),
            ),
            Effect.retry({ schedule: Schedule.spaced("1 second"), times: 60 }),
          );
        const runs = server.json(Schema.Number, `${route}/tools/call`, {
          tool: "runs",
          kind: "query",
          input: {},
        });

        const browser = yield* Effect.acquireRelease(
          driver("launch a browser", () => chromium.launch()),
          (browser) => driver("close the browser", () => browser.close()).pipe(Effect.orDie),
        );
        const context = yield* driver("open a session", () => browser.newContext());
        yield* driver("sign the browser in as the owner", () =>
          context.addCookies(
            server.session.split("; ").map((pair) => {
              const at = pair.indexOf("=");
              return { name: pair.slice(0, at), value: pair.slice(at + 1), url: server.origin };
            }),
          ),
        );
        const page = yield* driver("open a tab", () => context.newPage());
        let subscribes = 0;
        page.on("request", (request) => {
          if (new URL(request.url()).pathname === "/_executor/api/subscribe") subscribes++;
        });
        yield* driver("open the app page", () => page.goto(location));
        // The second run comes from the open subscription's own 15-second refresh.
        yield* driver("the page's live query runs again while the page is open", () =>
          page
            .getByRole("status")
            .filter({ hasText: /^Runs ([2-9]|\d{2,})$/ })
            .waitFor({ timeout: 40_000 }),
        );
        expect(subscribes, "one subscription stays open while the page does").toBe(1);
        yield* driver("close the browser", () => browser.close());

        // The server finds the client gone on a heartbeat write a few seconds later; give it time.
        yield* Effect.sleep("30 seconds");
        const settled = yield* runs;
        // Two of the subscription's 15-second refreshes would fall in this window.
        yield* Effect.sleep("35 seconds");
        const later = yield* runs;
        expect(later - settled, "runs of the live query after its page closed").toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  300_000,
);
