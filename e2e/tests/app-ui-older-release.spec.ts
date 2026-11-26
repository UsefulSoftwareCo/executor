import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";

const beforeVersions = "0.0.1-beta.84";

const files = [
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: { apps: beforeVersions, react: "^19.2.0", "react-dom": "^19.2.0" },
    }),
  },
  {
    path: "index.ts",
    content: `import { defineApp, query, object, string, router } from "apps";
export const greeting = query({ input: object({}), output: string() }, async () => "Loaded from the host");
export default defineApp({ accounts: {} }, { tools: router({ greeting }) });`,
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Older page</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
  },
  {
    path: "ui/main.tsx",
    content: `import React from "react";
import { createRoot } from "react-dom/client";
import { string } from "apps";
import { createAppClient, queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type { greeting } from "../index";
const client = createAppClient();
const current = client.queryAtom(queryReference<typeof greeting>("greeting"), {}, string());
function App() {
  const { data, pending, error } = useAppQuery(current);
  return <main><h1>Older page</h1><p role="status">{error ?? (pending ? "Loading" : data)}</p></main>;
}
createRoot(document.getElementById("root")).render(<App />);`,
  },
];

layer(HostedLive, { excludeTestServices: true })("App UI from an older release", (it) => {
  it.effect(scenarios.appUiOlderRelease.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Older page ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
        yield* browser.login(actors.owner);
        yield* browser.use("Open the page built with the older release", (page) => page.goto(url));
        const status = yield* browser.use("The page's query settles", (page) => {
          const status = page.getByRole("status");
          return status
            .filter({ hasNotText: "Loading" })
            .waitFor()
            .then(() => status.textContent());
        });
        expect(status).toBe("Loaded from the host");
        yield* browser.checkpoint("Older page with its data");
      }),
    ),
  );
});
