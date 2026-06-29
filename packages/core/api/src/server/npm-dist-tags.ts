// ---------------------------------------------------------------------------
// `/v1/app/npm/dist-tags`: the published dist-tags for the `executor` package.
//
// The web/desktop shell's `useLatestVersion` hook fetches this un-prefixed path
// and compares the returned `latest`/`beta` against its own build version to
// decide whether to show the sidebar UpdateCard. It is intentionally NOT mounted
// under the API's `mountPrefix` (`/api`). The client hardcodes `/v1/app/...`,
// the same on every host, so it registers on the ambient router directly.
//
// The body is `resolveDistTags()` verbatim, so the CLI's notice and the web
// card resolve against identical data (see `../update-check.ts`).
// ---------------------------------------------------------------------------

import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { resolveDistTags } from "../update-check";

export const NPM_DIST_TAGS_PATH = "/v1/app/npm/dist-tags" as const;

export const makeNpmDistTagsRoute = (): Layer.Layer<never, never, HttpRouter.HttpRouter> => {
  const handler = Effect.gen(function* () {
    const tags = yield* Effect.promise(() => resolveDistTags());
    return HttpServerResponse.jsonUnsafe(tags, {
      headers: {
        // Short cache: the registry rarely moves, but a stale 5-minute window
        // is fine for an upgrade nudge and spares the origin a fetch per load.
        "cache-control": "public, max-age=300",
      },
    });
  });

  return HttpRouter.add("GET", NPM_DIST_TAGS_PATH, handler);
};
