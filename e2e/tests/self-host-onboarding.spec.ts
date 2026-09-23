import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
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
        yield* browser.use("Agent instructions are visible", (page) =>
          page.getByRole("heading", { name: "Continue in your agent", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Onboarding stays outside the dashboard shell", (page) =>
            page.locator(".shell").count(),
          ),
        ).toBe(0);
        yield* browser.use("Reload the handoff", (page) => page.reload());
        yield* browser.use("Reload retains the agent instructions", (page) =>
          page.getByRole("heading", { name: "Continue in your agent", exact: true }).waitFor(),
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
        yield* browser.use("Copy the instance MCP URL", (page) =>
          page.getByRole("button", { name: "Copy MCP URL", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the copied MCP URL", (page) =>
            page.evaluate(() => navigator.clipboard.readText()),
          ),
        ).toBe(`${origin}/mcp`);
        yield* browser.use("Copy the starter prompt", (page) =>
          page.getByRole("button", { name: "Copy starter prompt", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the copied prompt", (page) =>
            page.evaluate(() => navigator.clipboard.readText()),
          ),
        ).toBe(
          `Help me connect to Executor over MCP at ${origin}/mcp.\n\nRead the docs to understand the product at https://v2.executor.sh/docs/, then help me get my first app set up.`,
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
        yield* browser.use("Sign out", (page) =>
          page.getByRole("button", { name: "Sign out", exact: true }).click(),
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
