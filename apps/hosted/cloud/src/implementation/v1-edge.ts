/**
 * What the edge (`executor.sh`) answers in v1's place once v1 shuts down (`notes/v1-shutdown.md`,
 * "URL table after the switch"), apart from the MCP URLs (`v1-legacy-mcp.ts`): v1's OAuth client
 * ID metadata documents, its dashboard and sign-in paths, the redirects v1's edge
 * made, a page for a connected-account sign-in v1 started, and 410 for the rest of v1's API.
 * v1's edge forwards none of these to v2 before the switch.
 */
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { accountOAuthStatePrefix } from "../contracts/edge-paths.ts";
import { v1ClientIdMetadataDocument } from "../contracts/v1-documents.ts";
import type { WithSql } from "./v1-legacy-mcp.ts";

const noStore = { "cache-control": "no-store" };

const requestUrl = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => new URL(request.originalUrl),
);

/** v1's OAuth client ID metadata document at this URL, as v1 generated it. */
export const v1ClientIdMetadata = Effect.map(requestUrl, (url) =>
  HttpServerResponse.jsonUnsafe(v1ClientIdMetadataDocument(url), {
    headers: { "cache-control": "public, max-age=300" },
  }),
);

/** v1's sign-in, its WorkOS callback, its sign-out and its session check: v2 sign-in now. */
export const v1SignIn = (browser: string) =>
  Effect.succeed(
    HttpServerResponse.redirect(new URL("/login", browser).href, { status: 302, headers: noStore }),
  );

/** Sign-up, as v1's edge redirected it. */
export const v1SignUp = (browser: string) =>
  Effect.succeed(
    HttpServerResponse.redirect(new URL("/login?mode=signup", browser).href, {
      status: 302,
      headers: noStore,
    }),
  );

const callbackGone = (browser: string) =>
  HttpServerResponse.text(
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in expired · Executor</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">
<h1 style="font-size: 1.25rem">This sign-in started in Executor v1</h1>
<p>Executor v1 has shut down, so the sign-in it started cannot finish. Open Executor and connect the account again.</p>
<p><a href="${browser}">Open Executor</a></p>
</body>
</html>
`,
    { status: 410, contentType: "text/html; charset=utf-8", headers: noStore },
  );

/**
 * `GET /api/oauth/callback`: a connected-account sign-in v2 started (its state starts with
 * `x2.`) finishes with `callback`, as before; any other was v1's, whose sessions are gone.
 */
export const accountCallback = <E, R>(
  browser: string,
  callback: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.flatMap(requestUrl, (url) =>
    (url.searchParams.get("state") ?? "").startsWith(accountOAuthStatePrefix)
      ? callback
      : Effect.succeed(callbackGone(browser)),
  );

/** Any other path of v1's REST API. */
export const v1ApiGone = (api: string) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      {
        error: "gone",
        message: `Executor v1's API has shut down. Use Executor's API at ${api}.`,
        api,
      },
      { status: 410, headers: noStore },
    ),
  );

/**
 * Every 404 or 405 under `/api/` on the edge is v1's API, gone: paths v2 owns there (its callbacks, client
 * ID documents and telemetry) answer before this, and a telemetry path of another deployment is
 * no API either.
 */
export const apiGoneOnEdge =
  (api: string) =>
  <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const response = yield* handler;
      if (response.status !== 404 && response.status !== 405) return response;
      const url = yield* requestUrl;
      return url.pathname === "/api" || url.pathname.startsWith("/api/")
        ? yield* v1ApiGone(api)
        : response;
    });

const Slugs = Schema.Array(Schema.Struct({ slug: Schema.String }));

/**
 * Everything the edge's other routes do not match. A v1 organization's dashboard
 * (`/<v1 slug>`, `/<v1 slug>/...`) redirects to its v2 organization, found only through the
 * legacy table (`private_v1_legacy_org`); a path under `/api/` is v1's API, gone; anything else is
 * the site's 404.
 */
export const edgeFallback = <E, R>(input: {
  readonly withSql: WithSql;
  readonly browser: string;
  readonly api: string;
  readonly notFound: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>;
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.originalUrl);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/"))
      return yield* v1ApiGone(input.api);
    const read = request.method === "GET" || request.method === "HEAD";
    const slug = url.pathname.split("/")[1] ?? "";
    if (read && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
      const found = yield* input
        .withSql(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql`
              select o.slug from private_v1_legacy_org l
              join organization o on o.id = l.v2_org_id
              where l.v1_slug = ${slug}`,
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Slugs))),
        )
        .pipe(Effect.option);
      const target = Option.flatMap(found, (rows) => Option.fromNullishOr(rows[0]?.slug));
      if (Option.isSome(target))
        return HttpServerResponse.redirect(
          new URL(`/org/${encodeURIComponent(target.value)}`, input.browser).href,
          { status: 302, headers: noStore },
        );
      if (Option.isNone(found))
        return HttpServerResponse.empty({ status: 503, headers: { "retry-after": "5" } });
    }
    return yield* input.notFound;
  });
