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

export const v1ClientIdMetadata = Effect.map(requestUrl, (url) =>
  HttpServerResponse.jsonUnsafe(v1ClientIdMetadataDocument(url), {
    headers: { "cache-control": "public, max-age=300" },
  }),
);

export const v1SignIn = (browser: string) =>
  Effect.succeed(
    HttpServerResponse.redirect(new URL("/login", browser).href, { status: 302, headers: noStore }),
  );

export const v1SignUp = (browser: string) =>
  Effect.succeed(
    HttpServerResponse.redirect(new URL("/login?mode=signup", browser).href, {
      status: 302,
      headers: noStore,
    }),
  );

export const v1GonePage = (page: {
  readonly title: string;
  readonly heading: string;
  readonly paragraphs: ReadonlyArray<string>;
  readonly browser: string;
}) =>
  HttpServerResponse.text(
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${page.title} · Executor</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">
<h1 style="font-size: 1.25rem">${page.heading}</h1>
${page.paragraphs.map((paragraph) => `<p>${paragraph}</p>\n`).join("")}<p><a href="${page.browser}">Open Executor</a></p>
</body>
</html>
`,
    { status: 410, contentType: "text/html; charset=utf-8", headers: noStore },
  );

const callbackGone = (browser: string) =>
  v1GonePage({
    title: "Sign-in expired",
    heading: "This sign-in started in Executor v1",
    paragraphs: [
      "Executor v1 has shut down, so the sign-in it started cannot finish. Open Executor and connect the account again.",
    ],
    browser,
  });

export const accountCallback = <E, R>(
  browser: string,
  callback: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.flatMap(requestUrl, (url) =>
    (url.searchParams.get("state") ?? "").startsWith(accountOAuthStatePrefix)
      ? callback
      : Effect.succeed(callbackGone(browser)),
  );

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
