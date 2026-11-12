/**
 * Replace a response the browser received for its own request.
 *
 * Playwright's `route.fetch()` sends the intercepted request again from the test process, over a
 * Node keep-alive pool that never resends. Local Cloud's workerd closes an idle connection after
 * five seconds without saying so in a `Keep-Alive` header, so a request sent on a pooled socket as
 * that close arrives fails with "socket hang up" and the page never gets a response. Here the
 * browser sends the request on its own connections, as a person's browser does, and Chromium
 * resends a request whose reused connection was closed under it. Only the response the page reads
 * is replaced, at the DevTools Fetch domain's response stage.
 *
 * A Playwright route that only continues the request stays registered meanwhile: the harness
 * splits a dashboard read out of its batch request only while a test route matches it
 * (`splitRoutedReads` in `read-batches.ts`).
 */
import { Effect, Redacted, Schema } from "effect";
import { Browser } from "./browser.ts";
import { DriverFailed, driver } from "./platform.ts";

/** What the browser sent and the server answered, before the page reads the answer. */
export interface ReceivedResponse {
  readonly url: string;
  /** Request headers keyed by lower-case name. */
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly status: number;
}

/** The response the page reads instead. */
export interface Replacement {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
}

const Paused = Schema.Struct({
  requestId: Schema.String,
  request: Schema.Struct({
    url: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
  }),
  responseStatusCode: Schema.optional(Schema.Number),
  responseHeaders: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  ),
});

/** The URLs a DevTools Fetch pattern matches: `*` is any run of characters and `?` one character. */
const fetchPatternMatcher = (urlPattern: string) => {
  const pattern = new RegExp(
    `^${[...urlPattern]
      .map((char) =>
        char === "*" ? ".*" : char === "?" ? "." : char.replace(/[\\^$.|+()[\]{}/]/g, "\\$&"),
      )
      .join("")}$`,
  );
  return (url: URL) => pattern.test(url.href);
};

/** Headers that describe the original body's bytes, which the replacement does not keep. */
const bodyHeaders = new Set(["content-length", "content-encoding", "content-type"]);

/**
 * Until the scope closes, give the page `replace`'s response for each request whose URL matches
 * `urlPattern` (a DevTools Fetch pattern: `*` matches any run of characters). The server still
 * receives and answers the browser's real request, and the server's other headers, such as its
 * trace timing, reach the page unchanged. A failure inside `replace` fails the scope.
 */
export const replaceResponses = (
  urlPattern: string,
  replace: (response: ReceivedResponse) => Replacement,
) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const session = yield* Effect.acquireRelease(
      browser.use("Open the page's DevTools session", (page) => page.context().newCDPSession(page)),
      (session) =>
        driver("Close the page's DevTools session", () => session.detach()).pipe(Effect.orDie),
    );
    const matcher = fetchPatternMatcher(urlPattern);
    yield* Effect.acquireRelease(
      browser.use("Let the browser send the matching requests itself", (page) =>
        page.route(matcher, (route) => route.continue()),
      ),
      () =>
        browser
          .use("Stop routing the matching requests", (page) => page.unroute(matcher))
          .pipe(Effect.orDie),
    );
    const failures: Array<unknown> = [];
    const answer = (event: unknown) => {
      const paused = Schema.decodeUnknownSync(Paused)(event);
      if (paused.responseStatusCode === undefined)
        return session.send("Fetch.continueRequest", { requestId: paused.requestId });
      const requestHeaders = Object.fromEntries(
        Object.entries(paused.request.headers).map(([name, value]) => [name.toLowerCase(), value]),
      );
      const replacement = replace({
        url: paused.request.url,
        requestHeaders,
        status: paused.responseStatusCode,
      });
      return session.send("Fetch.fulfillRequest", {
        requestId: paused.requestId,
        responseCode: replacement.status,
        responseHeaders: [
          ...(paused.responseHeaders ?? []).filter(
            ({ name }) => !bodyHeaders.has(name.toLowerCase()),
          ),
          { name: "content-type", value: replacement.contentType },
        ],
        body: Buffer.from(replacement.body).toString("base64"),
      });
    };
    session.on("Fetch.requestPaused", (event) => {
      void Promise.resolve()
        .then(() => answer(event))
        .catch((cause: unknown) => {
          failures.push(cause);
        });
    });
    yield* Effect.acquireRelease(
      driver("Replace matching responses after the server answers", () =>
        session.send("Fetch.enable", { patterns: [{ urlPattern, requestStage: "Response" }] }),
      ),
      () =>
        driver("Stop replacing responses", () => session.send("Fetch.disable")).pipe(Effect.orDie),
    );
    yield* Effect.addFinalizer(() =>
      failures.length === 0
        ? Effect.void
        : Effect.die(
            new DriverFailed({
              operation: "Replace a response the browser received",
              cause: Redacted.make(failures),
            }),
          ),
    );
  });
