import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { holdOrganizationEntry, trackEntryNavigations } from "../support/organization-entry.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Sign-in entry", (it) => {
  it.effect(scenarios.signInEntry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        const evidence = yield* Evidence;
        const paths = yield* trackEntryNavigations;
        const destination = `/org/${actors.organization.slug}/apps`;
        for (const viewport of [
          { width: 864, height: 720 },
          { width: 390, height: 844 },
        ] as const) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* browser.use("Leave the previous document", (page) => page.goto("about:blank"));
              yield* browser.login(actors.owner);
              yield* browser.use("Set the sign-in viewport", (page) =>
                page.setViewportSize(viewport),
              );
              const list = yield* holdOrganizationEntry;
              const response = yield* browser.use(
                "Sign-in completion chooses its destination on the server",
                (page) =>
                  page.request.get("/login", { maxRedirects: 0 }).then((response) => ({
                    status: response.status(),
                    location: response.headers().location,
                    cache: response.headers()["cache-control"],
                  })),
              );
              expect(response.status).toBe(302);
              expect(response.location).toBe(destination);
              expect(response.cache).toContain("no-store");
              yield* browser.use("Open the same completion URL in the browser", (page) =>
                page.goto("/login"),
              );
              yield* browser.use("The browser lands directly in its organization", (page) =>
                page.waitForURL(`**${destination}`),
              );
              expect(
                yield* browser.use("There is no sign-in loading screen", (page) =>
                  page.locator(".auth-pending").count(),
                ),
              ).toBe(0);
              yield* browser.checkpoint(`${viewport.width}px: server selected the organization`);
              yield* list.release;
            }),
          );
        }
        expect(paths).not.toContain("/");
        for (const [requested, expected] of [
          [
            "/mcp/authorize?state=keep%2Fthis&redirect_uri=https%3A%2F%2Fclient.example%2Fcb#return",
            "/mcp/authorize?state=keep%2Fthis&redirect_uri=https%3A%2F%2Fclient.example%2Fcb#return",
          ],
          ["/invite?invitation=synthetic-invite", "/invite?invitation=synthetic-invite"],
          ["//external.example/", destination],
          ["/api/auth/sign-out", destination],
          ["/login?redirect=/login", destination],
        ] as const) {
          const response = yield* browser.use(
            "Validate the explicit return destination without following it",
            (page) =>
              page.request
                .get(`/login?redirect=${encodeURIComponent(requested)}`, { maxRedirects: 0 })
                .then((response) => ({
                  status: response.status(),
                  location: response.headers().location,
                })),
          );
          expect(response.status).toBe(302);
          expect(response.location).toBe(expected);
        }
        yield* evidence.json("sign-in-entry.json", {
          paths: [...paths],
          sessionInjected: true,
          destinationResolvedOnServer: true,
          explicitReturnsVerified: true,
        });
      }),
    ),
  );
});
