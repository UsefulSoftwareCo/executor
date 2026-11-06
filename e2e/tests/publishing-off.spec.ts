/** A host that does not publish says so, refuses publications and leaves no Publish control. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { App, PublishingStatus } from "../support/contracts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { openThroughBrowser } from "../support/in-app-navigation.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";
import { withApps } from "../support/apps-release.ts";

layer(HostedLive, { excludeTestServices: true })("Publishing off", (it) => {
  it.effect(scenarios.publishingOff.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // Self-host reads another host's catalog and keeps none of its own, so it never publishes.
        const status = yield* api.request(actors.owner, "GET", `${prefix}/app-publications/status`);
        expect(status.status).toBe(200);
        expect(yield* body(PublishingStatus, status)).toEqual({ publishing: false });
        const unpublish = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/app-publications/unpublish`,
          { package: `@${actors.organization.slug}.executor.community/absent` },
        );
        expect(unpublish.status).toBe(403);

        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Unpublished example ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: 'import {defineApp} from "apps"; export default defineApp({},{});',
            },
            {
              path: "package.json",
              content: JSON.stringify({ name: "unpublished", dependencies: withApps() }),
            },
          ],
        });
        expect(response.status).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)
            .pipe(Effect.asVoid, Effect.orDie),
        );
        const publish = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/publication`,
          { commit: "a".repeat(40) },
        );
        expect(publish.status).toBe(403);
        yield* browser.login(actors.owner);
        const statusHold = yield* holdQuery(
          [actors.organization.id, actors.organization.slug].map(
            (organization) => `/api/organizations/${organization}/app-publications/status`,
          ),
          "continue",
        );
        yield* openThroughBrowser(
          "Open the app as its owner",
          `/org/${actors.organization.slug}/apps/${app.id}`,
        );
        yield* statusHold.requested;
        yield* browser.use("Publishing access holds its place while the host answers", (page) =>
          page.getByLabel("Loading publishing access").waitFor(),
        );
        yield* statusHold.release;
        yield* browser.use("The placeholder leaves once the host answers", (page) =>
          page.getByLabel("Loading publishing access").waitFor({ state: "detached" }),
        );
        yield* browser.use("App navigation is available", (page) =>
          page.getByRole("navigation", { name: "App navigation" }).waitFor(),
        );
        expect(
          yield* browser.use("No Publish control, enabled or disabled", (page) =>
            page.getByRole("button", { name: "Publish", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Owner app page without publishing");
      }),
    ),
  );
});
