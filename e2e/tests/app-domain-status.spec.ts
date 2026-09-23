/** Exercise domain readiness states at the browser's public HTTP boundary. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";

layer(HostedLive, { excludeTestServices: true })("App domain readiness", (it) => {
  it.effect(scenarios.appDomainStatus.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Domain status ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content:
                'import { defineApp } from "apps"; export default defineApp({ accounts: {} }, {});',
            },
            { path: "ui/index.html", content: "<!doctype html><h1>Domain ready</h1>" },
          ],
        });
        expect(response.status).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
        yield* browser.login(actors.owner);
        let status: "pending" | "failed" | "ready" | "too_long" = "pending";
        let intercepted = 0;
        yield* browser.use("Control domain status at its HTTP boundary", (page) =>
          page.route(
            (request) => request.pathname.endsWith(`/apps/${app.id}/ui`),
            (route) => {
              intercepted++;
              return route.fulfill({
                status: status === "too_long" ? 422 : 200,
                json:
                  status === "too_long"
                    ? { _tag: "AppUiAddressInvalid", reason: "too_long" }
                    : { status, url: status === "ready" ? url : null },
              });
            },
          ),
        );
        yield* browser.use("Open the deployed app details", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}`),
        );
        yield* browser.use("Pending setup is visible", (page) =>
          page.getByRole("status").filter({ hasText: "Preparing app domain…" }).waitFor(),
        );
        expect(intercepted).toBeGreaterThan(0);
        expect(
          yield* browser.use("No app link is exposed before readiness", (page) =>
            page.getByRole("link", { name: "Open app", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Team certificate is pending");
        status = "failed";
        yield* browser.use("Polling reports a provisioning failure", (page) =>
          page
            .getByRole("status")
            .filter({ hasText: "App domain setup needs attention." })
            .waitFor(),
        );
        expect(
          yield* browser.use("Failure still exposes no app link", (page) =>
            page.getByRole("link", { name: "Open app", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Provisioning failure offers a retry");
        status = "ready";
        yield* browser.use("Retry the failed domain lookup", (page) =>
          page.getByRole("button", { name: "Check again", exact: true }).click(),
        );
        yield* browser.use("The ready app link appears", (page) =>
          page.getByRole("link", { name: "Open app", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("The link uses the real certified origin", (page) =>
            page.getByRole("link", { name: "Open app", exact: true }).getAttribute("href"),
          ),
        ).toBe(url);
        yield* browser.checkpoint("Retry exposes the ready app origin");
        status = "too_long";
        yield* browser.use("An oversized team address is rejected", (page) => page.reload());
        yield* browser.use("The address error explains how to fix the team slug", (page) =>
          page
            .getByRole("status")
            .filter({ hasText: "Shorten the team slug. The app domain is too long for this host." })
            .waitFor(),
        );
        expect(
          yield* browser.use("An invalid address exposes no app link", (page) =>
            page.getByRole("link", { name: "Open app", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("An oversized address has an actionable error");
      }),
    ),
  );
});
