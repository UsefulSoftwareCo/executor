/** Exercise the shared dialog with server-result fixtures; registry authorization is tested separately. */
import { Effect, Schema } from "effect";
import { Browser } from "./browser.ts";
import { type ReceivedResponse, replaceResponses } from "./browser-responses.ts";

type WorkspaceDisplay = { readonly revision: { readonly commit: string } };
const WorkspaceDisplay = Schema.Struct({
  revision: Schema.Struct({ commit: Schema.String }),
});
const Fields = Schema.Record(Schema.String, Schema.Unknown);

/**
 * Self-host does not publish; replace only that capability on real workspace reads for UI checks.
 * A function derives the result from the real revision, so saved repairs can change readiness.
 */
export const publishingPreview = (
  app: string,
  publication: object | ((display: WorkspaceDisplay) => object),
  published: readonly unknown[] = [],
) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const listings = (url: URL) => url.pathname.endsWith("/app-publications/published");
    /** Add `fields` to the server's real answer for the reads whose path ends with `path`. */
    const extend = (
      path: string,
      unreadable: string,
      fields: (body: Readonly<Record<string, unknown>>) => object,
    ) =>
      replaceResponses(`*${path}*`, (response: ReceivedResponse) => {
        if (!new URL(response.url).pathname.endsWith(path)) return "unchanged";
        if (response.status !== 200) throw new Error(unreadable);
        return response.body().then((text) => {
          const body = Schema.decodeUnknownSync(Fields)(JSON.parse(text));
          return {
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ...body, ...fields(body) }),
          };
        });
      });
    yield* extend(`/apps/${app}/authoring`, "Real authoring access must succeed", () => ({
      canPublish: true,
    }));
    yield* extend(
      `/apps/${app}/workspace/display`,
      "The real workspace must be readable",
      (body) => ({
        publication:
          typeof publication === "function"
            ? publication(Schema.decodeUnknownSync(WorkspaceDisplay)(body))
            : publication,
      }),
    );
    yield* browser.use("Provide the existing public listings", (page) =>
      page.route(listings, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(published),
        }),
      ),
    );
    yield* Effect.addFinalizer(() =>
      browser
        .use("Release the public listings fixture", (page) => page.unroute(listings))
        .pipe(Effect.orDie),
    );
  });
