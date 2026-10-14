/** Tool groups that are routers, such as one MCP server each, show the router's own metadata. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const billingDescription = "Invoices and payment history for the synthetic store.";
const refundsDescription = "Refund requests awaiting review.";

const source = {
  path: "index.ts",
  content: `import { defineApp, query, object, router } from "apps";
const tool = (description: string) => query({ description, input: object({}) }, async () => description);
export default defineApp({}, async () => ({
  tools: router({
    billing: router(
      {
        invoices_list: tool("List invoices"),
        invoices_get: tool("Get one invoice"),
        refunds: router({ open: tool("Open refunds") }, {
          title: "Refunds desk",
          description: ${JSON.stringify(refundsDescription)},
        }),
      },
      { title: "Billing service", description: ${JSON.stringify(billingDescription)} },
    ),
    plain: router({ check: tool("Plain check") }),
  }),
}));`,
};

/** The Tools tree labels routers by title, shows their descriptions, and keeps plain groups. */
const checkTree = Effect.gen(function* () {
  const browser = yield* Browser;
  const tree = "App tools";
  yield* browser.use("A router group uses its title", (page) =>
    page
      .getByRole("navigation", { name: tree, exact: true })
      .getByRole("button", { name: /^Billing service/ })
      .waitFor(),
  );
  const visible = (label: string, text: string) =>
    browser.use(label, (page) =>
      page.getByRole("navigation", { name: tree, exact: true }).getByText(text).isVisible(),
    );
  expect(yield* visible("The router's description is shown", billingDescription)).toBe(true);
  expect(
    yield* browser.use("A nested router uses its own title", (page) =>
      page
        .getByRole("navigation", { name: tree, exact: true })
        .getByRole("button", { name: /^Refunds desk/ })
        .isVisible(),
    ),
  ).toBe(true);
  expect(yield* visible("A nested router shows its description", refundsDescription)).toBe(true);
  expect(
    yield* browser.use("A router without metadata keeps its key", (page) =>
      page
        .getByRole("navigation", { name: tree, exact: true })
        .getByRole("button", { name: /^Plain/ })
        .isVisible(),
    ),
  ).toBe(true);
  yield* browser.checkpoint("Tool groups show router metadata");
  yield* browser.use("Collapse the router group", (page) =>
    page
      .getByRole("navigation", { name: tree, exact: true })
      .getByRole("button", { name: /^Billing service/ })
      .click(),
  );
  expect(yield* visible("A collapsed group hides its description", billingDescription)).toBe(false);
});

layer(HostedLive, { excludeTestServices: true })("Tool router metadata", (it) => {
  it.effect(scenarios.toolRouterMetadata.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Grouped tools",
          files: [source, appsManifest],
        });
        expect(response.status).toBe(200);
        const app = yield* body(Schema.Struct({ id: Schema.String }), response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Open the app's Tools page", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=tools`),
        );
        yield* checkTree;
      }),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("Local tool router metadata", (it) => {
  it.effect(scenarios.localToolRouterMetadata.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          target = yield* Target,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const send = (method: "GET" | "POST" | "DELETE", path: string, data?: unknown) =>
          session.send(method, path, data, headers);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
          yield* send("POST", "/v1/apps/deploy", {
            owner: "local",
            name: `Grouped tools ${randomUUID().slice(0, 8)}`,
            files: [source, appsManifest],
          }),
        );
        yield* Effect.addFinalizer(() => send("DELETE", `/v1/apps/${app.id}`).pipe(Effect.orDie));
        const { url } = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* send("POST", "/auth/pair"),
        );
        yield* browser.use("Pair the local dashboard", (page) => page.goto(url));
        yield* browser.use("The local dashboard is ready", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor(),
        );
        yield* browser.use("Open the app's Tools page", (page) =>
          page.goto(`/apps/${app.id}?view=tools`),
        );
        yield* checkTree;
      }),
    ),
  );
});
