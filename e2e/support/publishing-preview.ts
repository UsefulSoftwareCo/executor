/** Exercise the shared dialog with server-result fixtures; registry authorization is tested separately. */
import { Effect, Schema } from "effect";
import type { Route } from "playwright";
import { Browser } from "./browser.ts";

/** Self-host does not publish; replace only that capability on real workspace reads for UI checks. */
export const publishingPreview = (
  app: string,
  publication: unknown,
  published: readonly unknown[] = [],
) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const workspace = (url: URL) => url.pathname.endsWith(`/apps/${app}/workspace`);
    const authoring = (url: URL) => url.pathname.endsWith(`/apps/${app}/authoring`);
    const listings = (url: URL) => url.pathname.endsWith("/app-publications/published");
    const source = (route: Route) =>
      route.fetch().then((response) => {
        if (response.status() !== 200) throw new Error("The real workspace must be readable");
        return response.json().then((body: unknown) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(body),
              publication,
            }),
          }),
        );
      });
    const entries = (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(published),
      });
    yield* browser.use("Enable publishing in the shared authoring controls", (page) =>
      page.route(authoring, (route) =>
        route.fetch().then((response) => {
          if (response.status() !== 200) throw new Error("Real authoring access must succeed");
          return response.json().then((body: unknown) =>
            route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(body),
                canPublish: true,
              }),
            }),
          );
        }),
      ),
    );
    yield* browser.use("Provide publishing results for the shared dialog", (page) =>
      page.route(workspace, source),
    );
    yield* browser.use("Provide the existing public listings", (page) =>
      page.route(listings, entries),
    );
    yield* Effect.addFinalizer(() =>
      browser
        .use("Release publishing result fixtures", (page) => page.unrouteAll({ behavior: "wait" }))
        .pipe(Effect.orDie),
    );
  });
