import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { authorizeBrowserMcp } from "../support/mcp-oauth.ts";
import { Target, driver } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Self-host onboarding", (it) => {
  it.effect(scenarios.selfHostOnboarding.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          target = yield* Target;
        const origin = yield* startFreshSelfHost(target);
        yield* browser.use("Open first-run setup", (page) => page.goto(`${origin}/login`));
        yield* browser.use("Name the organization", (page) =>
          page.getByLabel("Organization name", { exact: true }).fill("Example Studio"),
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
        expect(
          yield* browser.use("An eight-character password can be submitted", (page) =>
            page
              .locator("form")
              .evaluate((form) => form instanceof HTMLFormElement && form.checkValidity()),
          ),
        ).toBe(true);
        yield* browser.checkpoint("Administrator setup with an eight-character password");
        yield* browser.use("Create the administrator", (page) =>
          page.getByRole("button", { name: "Create administrator account", exact: true }).click(),
        );
        yield* browser.use("Administrator setup opens the agent handoff", (page) =>
          page.waitForURL(`${origin}/setup/agent`),
        );
        yield* browser.use("The assistant choices are visible", (page) =>
          page.getByRole("heading", { name: "Connect your assistant", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Onboarding stays outside the dashboard shell", (page) =>
            page.locator(".shell").count(),
          ),
        ).toBe(0);
        yield* browser.use("Reload the handoff", (page) => page.reload());
        yield* browser.use("Reload retains the assistant choices", (page) =>
          page.getByRole("heading", { name: "Connect your assistant", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("Self-host administrator agent handoff");
        yield* browser.use("Use a phone viewport", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.checkpoint("Self-host agent handoff on mobile");
        yield* browser.use("Restore desktop viewport", (page) =>
          page.setViewportSize({ width: 1440, height: 960 }),
        );
        yield* browser.use("Allow clipboard access", (page) =>
          page.context().grantPermissions(["clipboard-read", "clipboard-write"]),
        );
        yield* browser.use("Choose Claude", (page) =>
          page.getByRole("button", { name: "Claude", exact: true }).click(),
        );
        yield* browser.use("Claude's guide replaces the choices", (page) =>
          page.getByRole("heading", { name: "Add Executor to Claude", exact: true }).waitFor(),
        );
        yield* browser.use("Copy the instance MCP URL", (page) =>
          page.getByRole("button", { name: "Copy MCP URL", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the copied MCP URL", (page) =>
            page.evaluate(() => navigator.clipboard.readText()),
          ),
        ).toBe(`${origin}/mcp`);
        yield* browser.use("Setup waits for Claude", (page) =>
          page.getByText("Waiting for Claude to connect…", { exact: true }).waitFor(),
        );
        // The assistant signs in from its own tab, so agent setup keeps its state.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* browser.omitNetworkTrace;
            const tab = yield* Effect.acquireRelease(
              browser.use("Open the assistant's sign-in tab", (page) => page.context().newPage()),
              (tab) =>
                driver("Close the assistant's sign-in tab", () => tab.close()).pipe(Effect.orDie),
            );
            yield* authorizeBrowserMcp(tab, origin, { client: "Self-host assistant" });
            yield* browser.use("Return to agent setup", (page) => page.bringToFront());
          }),
        );
        yield* browser.use("The new agent is detected", (page) =>
          page.getByText("Approved for Self-host assistant", { exact: true }).waitFor(),
        );
        yield* browser.use("Continue to the first prompt", (page) =>
          page.getByRole("button", { name: "Next: send your first prompt", exact: true }).click(),
        );
        yield* browser.use("Copy the starter prompt", (page) =>
          page.getByRole("button", { name: "Copy starter prompt", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the copied prompt", (page) =>
            page.evaluate(() => navigator.clipboard.readText()),
          ),
        ).toBe(
          `Use Executor, which I connected over MCP at ${origin}/mcp. If you cannot see its tools yet, connect to that server first.\n\nRead the docs to understand the product at https://executor.sh/docs/, then help me get my first app set up.`,
        );
        yield* browser.use("Open the dashboard when ready", (page) =>
          page.getByRole("link", { name: "Open dashboard", exact: false }).click(),
        );
        yield* browser.use("The new organization opens Apps", (page) =>
          page.waitForURL(`${origin}/org/*/apps`),
        );
        const dashboard = yield* browser.use("Remember the organization destination", (page) =>
          Promise.resolve(page.url()),
        );
        yield* browser.use("Open the account menu", (page) =>
          page.getByRole("button", { name: /^Account: / }).click(),
        );
        yield* browser.use("Sign out", (page) =>
          page.getByRole("menuitem", { name: "Sign out", exact: true }).click(),
        );
        yield* browser.use("Enter returning administrator email", (page) =>
          page.getByLabel("Email", { exact: true }).fill("alex@example.test"),
        );
        yield* browser.use("Enter returning administrator password", (page) =>
          page.getByLabel("Password", { exact: true }).fill("password"),
        );
        yield* browser.use("Sign in again", (page) =>
          page.getByRole("button", { name: "Sign in", exact: true }).click(),
        );
        yield* browser.use("Returning sign-in opens the existing dashboard", (page) =>
          page.waitForURL(dashboard),
        );
      }),
    ),
  );
});
