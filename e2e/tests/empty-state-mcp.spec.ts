import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { Target } from "../support/platform.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("MCP empty state", (it) => {
  it.effect(scenarios.emptyStateMcp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target;
        yield* browser.login(actors.owner);
        yield* browser.use("Use dark theme", (page) => page.emulateMedia({ colorScheme: "dark" }));
        yield* browser.use("Provide a no-membership result", (page) =>
          page.route("**/api/auth/organization/list", (route) => route.fulfill({ json: [] })),
        );
        yield* browser.use("Provide synthetic client metadata", (page) =>
          page.route("**/api/auth/oauth2/public-client?*", (route) =>
            route.fulfill({
              json: { client_id: "empty-state-client", client_name: "Example client" },
            }),
          ),
        );
        for (const viewport of [
          { width: 1440, height: 960 },
          { width: 390, height: 844 },
        ]) {
          yield* browser.use("Set consent viewport", (page) => page.setViewportSize(viewport));
          yield* browser.use("Open consent without organizations", (page) =>
            page.goto(
              `/mcp/authorize?client_id=empty-state-client&resource=${encodeURIComponent(`${target.metadata.origin}/api`)}`,
            ),
          );
          yield* browser.use("Consent gives the actual recovery step", (page) =>
            page
              .getByText(
                "Ask an organization admin for an invitation, then return here to connect.",
                { exact: true },
              )
              .waitFor(),
          );
          expect(
            yield* browser.use("No unusable organization selector", (page) =>
              page.getByRole("combobox").count(),
            ),
          ).toBe(0);
          expect(
            yield* browser.use("No impossible Connect action", (page) =>
              page.getByRole("button", { name: "Connect", exact: true }).count(),
            ),
          ).toBe(0);
          yield* browser.checkpoint(`${viewport.width} consent without organization membership`);
        }
      }),
    ),
  );
});
