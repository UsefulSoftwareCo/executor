/**
 * A self-host served over plain HTTP at a LAN address, with no TLS proxy. Browsers give such a page
 * no secure context, so `crypto.randomUUID` and `navigator.clipboard` are missing there.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { chromium } from "playwright";
import { appsManifest } from "../support/apps-release.ts";
import { Browser, BrowserDriver } from "../support/browser.ts";
import { withCase } from "../support/case.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { RuntimeLive, Target, driver } from "../support/platform.ts";
import { freePort } from "../support/ports.ts";
import { officialApps } from "../support/public-catalogs.ts";
import { scenarios } from "../test-plan.ts";

/**
 * The LAN name the dashboard is served at. Chromium resolves it to the scenario's loopback server,
 * so nothing listens on the network, but the origin is not loopback and so not a secure context.
 */
const lanHost = "executor.lan";
const LanBrowserLive = Layer.effect(
  BrowserDriver,
  Effect.gen(function* () {
    const target = yield* Target;
    return yield* Effect.acquireRelease(
      driver("launch a browser that resolves the LAN name", () =>
        chromium.launch({
          headless: target.headless ?? !target.metadata.interactive,
          slowMo: target.recordingPaceMs,
          args: [`--host-resolver-rules=MAP ${lanHost} 127.0.0.1`],
        }),
      ),
      (browser) => driver("close browser", () => browser.close()).pipe(Effect.orDie),
    );
  }),
).pipe(Layer.provideMerge(RuntimeLive));

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const workflowIndex = `import { defineApp, object, query, router, string, workflow } from "apps";

const echo = query({ input: object({ text: string() }) }, async (_ctx, input) => input);
const greet = workflow({ input: object({}) }, async () => ({ hello: "LAN" }));

export default defineApp({}, async () => ({ tools: router({ echo }), workflows: { greet } }));
`;

layer(LanBrowserLive, { excludeTestServices: true })("LAN HTTP dashboard", (it) => {
  it.effect(scenarios.lanHttpDashboard.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          target = yield* Target;
        const port = yield* freePort;
        const lan = `http://${lanHost}:${port}`;
        const loopback = yield* startFreshSelfHost(target, {
          PORT: String(port),
          EXECUTOR_PORT: String(port),
          BETTER_AUTH_URL: lan,
          EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify([lan]),
        });
        yield* browser.use("Open first-run setup at the LAN address", (page) =>
          page.goto(`${lan}/login`),
        );
        expect(
          yield* browser.use("The page has no secure context", (page) =>
            page.evaluate(() => ({
              secure: isSecureContext,
              randomUUID: typeof crypto.randomUUID,
              clipboard: typeof navigator.clipboard,
            })),
          ),
        ).toEqual({ secure: false, randomUUID: "undefined", clipboard: "undefined" });
        yield* browser.use("Name the organization", (page) =>
          page.getByLabel("Organization name", { exact: true }).fill("LAN Studio"),
        );
        yield* browser.use("Name the administrator", (page) =>
          page.getByLabel("Your name", { exact: true }).fill("Alex Example"),
        );
        yield* browser.use("Enter administrator email", (page) =>
          page.getByLabel("Email", { exact: true }).fill("alex@example.test"),
        );
        yield* browser.use("Enter administrator password", (page) =>
          page.getByLabel("Password", { exact: true }).fill("password"),
        );
        yield* browser.use("Create the administrator", (page) =>
          page.getByRole("button", { name: "Create administrator account", exact: true }).click(),
        );
        const organization = yield* browser.use("Setup opens the account step", (page) =>
          page
            .waitForURL(new RegExp(`^${lan}/org/[^/]+/setup/accounts$`, "u"))
            .then(() => new URL(page.url()).pathname.split("/")[2] ?? ""),
        );
        const org = `${lan}/org/${organization}`;
        // Every dashboard request names its page with a UUID, so a missing one failed them all.
        yield* browser.use("The account step lists the catalog", (page) =>
          page.getByRole("searchbox", { name: "Search apps" }).waitFor(),
        );
        yield* browser.checkpoint("Account step loads over plain HTTP");

        yield* browser.use("Open the assistant step", (page) =>
          page.goto(`${org}/setup/assistant`),
        );
        yield* browser.use("Copy the MCP URL", (page) =>
          page.getByRole("button", { name: "Copy MCP URL" }).click(),
        );
        yield* browser.use("The button confirms the copy", (page) =>
          page
            .getByRole("button", { name: "Copy MCP URL" })
            .getByText("Copied", { exact: true })
            .waitFor(),
        );
        // Only a secure context can read the clipboard back; the server's loopback origin is one.
        yield* browser.use("Allow clipboard reads on loopback", (page) =>
          page.context().grantPermissions(["clipboard-read"], { origin: loopback }),
        );
        yield* browser.use("Open the server on loopback", (page) =>
          page.goto(`${loopback}/health`),
        );
        expect(
          yield* browser.use("Read the clipboard", (page) =>
            page.evaluate(() => navigator.clipboard.readText()),
          ),
        ).toBe(`${lan}/mcp`);

        yield* browser.use("Open Add app", (page) => page.goto(`${org}/apps/add`));
        yield* browser.use("Add an app from the catalog", (page) =>
          page
            .getByRole("button", { name: `Add ${officialApps.tracker.name}`, exact: true })
            .click(),
        );
        yield* browser.use("The added app offers Open", (page) =>
          page
            .locator(".catalog-row", { hasText: officialApps.tracker.name })
            .getByRole("link", { name: "Open" })
            .waitFor(),
        );
        expect(
          yield* browser.use("No request failed", (page) =>
            page.getByText("Unable to complete this request").count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("App added over plain HTTP");

        // The page's own session deploys it, as an agent's request through the dashboard would.
        const app = yield* browser.use("Deploy an app with a workflow", (page) =>
          page.evaluate(
            ({ files }) =>
              fetch("/api/auth/organization/list")
                .then((response) => response.json() as Promise<readonly { id: string }[]>)
                .then(([organization]) =>
                  fetch(`/api/organizations/${organization?.id}/apps/deploy`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ name: "LAN Notes", files }),
                  }),
                )
                .then((response) =>
                  response.ok
                    ? (response.json() as Promise<{ id: string }>)
                    : Promise.reject(new Error(`Deploy failed with ${response.status}`)),
                )
                .then((deployed) => deployed.id),
            { files: [{ path: "index.ts", content: workflowIndex }, appsManifest] },
          ),
        );
        yield* browser.use("Open the app's workflows", (page) =>
          page
            .goto(`${org}/apps/${app}`)
            .then(() => page.getByRole("link", { name: "Workflows", exact: true }).first().click()),
        );
        yield* browser.use("Choose the workflow", (page) =>
          page.getByText("greet", { exact: true }).first().click(),
        );
        // The start form keys each start with a UUID, so a retried start is not run twice.
        yield* browser.use("Start the workflow", (page) =>
          page.getByRole("button", { name: "Start workflow", exact: true }).click(),
        );
        yield* browser.use("The workflow starts", (page) =>
          page.getByText("Workflow started.", { exact: true }).waitFor(),
        );
        yield* browser.checkpoint("Workflow started over plain HTTP");

        yield* browser.use("Open Connections", (page) => page.goto(`${org}/connect`));
        yield* browser.use("Start a new connection", (page) =>
          page.getByRole("link", { name: "New connection" }).click(),
        );
        yield* browser.use("Name the connection", (page) =>
          page.getByLabel("Name", { exact: true }).fill("LAN agent"),
        );
        yield* browser.use("Turn on the app", (page) =>
          page.getByRole("checkbox", { name: "LAN Notes" }).click(),
        );
        yield* browser.use("Create the connection", (page) =>
          page.getByRole("button", { name: "Create connection", exact: true }).click(),
        );
        // The form chose the connection's ID in the browser.
        const connection = yield* browser.use("The connection is saved", (page) =>
          page
            .waitForURL(new RegExp(`^${org}/connect/(?!new$)[^/]+$`, "u"))
            .then(() => new URL(page.url()).pathname.split("/").at(-1) ?? ""),
        );
        expect(connection).toMatch(uuidV4);

        // The connection's menu copies its MCP URL, and says so when the browser refuses.
        yield* browser.use("Open the connection's actions", (page) =>
          page.getByRole("button", { name: "More actions", exact: true }).click(),
        );
        yield* browser.use("Copy its MCP URL from the menu", (page) =>
          page.getByRole("menuitem", { name: "Copy MCP URL" }).click(),
        );
        yield* browser.use("The menu confirms the copy", (page) =>
          page.getByRole("menuitem", { name: "Copied" }).waitFor(),
        );
        yield* browser.use("Close the actions", (page) => page.keyboard.press("Escape"));
        yield* browser.use("Make the browser refuse to copy", (page) =>
          page.evaluate(() => {
            document.execCommand = () => false;
          }),
        );
        yield* browser.use("Open the connection's actions again", (page) =>
          page.getByRole("button", { name: "More actions", exact: true }).click(),
        );
        yield* browser.use("Copy its MCP URL again", (page) =>
          page.getByRole("menuitem", { name: "Copy MCP URL" }).click(),
        );
        yield* browser.use("The menu says the copy failed", (page) =>
          page.getByRole("menuitem", { name: "Copy failed" }).waitFor(),
        );
        yield* browser.checkpoint("A refused copy says Copy failed");
      }),
    ),
  );
});
