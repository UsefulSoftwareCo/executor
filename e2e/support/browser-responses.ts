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
import { DriverFailed, driver, withCause } from "./platform.ts";

/** What the browser sent and the server answered, before the page reads the answer. */
export interface ReceivedResponse {
  readonly url: string;
  readonly method: string;
  /** Request headers keyed by lower-case name. */
  readonly requestHeaders: Readonly<Record<string, string>>;
  /** The request body the browser sent, empty when it sent none. */
  readonly requestBody: string;
  readonly status: number;
  /** Response headers keyed by lower-case name. */
  readonly headers: Readonly<Record<string, string>>;
  /** The server's whole response body, read only when asked for. */
  readonly body: () => Promise<string>;
}

/** The response the page reads instead. */
export interface Replacement {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
  /** Headers to set in place of the server's headers of the same names. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * What the page reads: a replacement, the server's own response, or a lost connection after the
 * server answered (`"failed"`, the browser's `net::ERR_FAILED`). A promise holds the response from
 * the page until it settles, while the server has already answered.
 */
export type Answer = Replacement | "unchanged" | "failed";

const Paused = Schema.Struct({
  requestId: Schema.String,
  request: Schema.Struct({
    url: Schema.String,
    method: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
    postDataEntries: Schema.optional(Schema.Array(Schema.Struct({ bytes: Schema.String }))),
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

const ResponseBody = Schema.Struct({ body: Schema.String, base64Encoded: Schema.Boolean });

/** Headers that describe the original body's bytes, which the replacement does not keep. */
const bodyHeaders = new Set(["content-length", "content-encoding", "content-type"]);

/**
 * Until the scope closes, give the page `answer`'s response for each request whose URL matches
 * `urlPattern` (a DevTools Fetch pattern: `*` matches any run of characters). The server still
 * receives and answers the browser's real request, and the server's other headers, such as its
 * trace timing, reach the page unchanged. A failure inside `answer` loses that response and fails
 * the scope.
 *
 * This replaces `route.fetch()`, which resends the request from the test process. Other routes on
 * the same URL still see the request first: this one only falls back to them.
 */
export const replaceResponses = (
  urlPattern: string,
  answer: (response: ReceivedResponse) => Answer | Promise<Answer>,
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
        page.route(matcher, (route) => route.fallback()),
      ),
      () =>
        browser
          .use("Stop routing the matching requests", (page) => page.unroute(matcher))
          .pipe(Effect.orDie),
    );
    const failures: Array<unknown> = [];
    const lowerCase = (headers: Iterable<readonly [string, string]>) =>
      Object.fromEntries([...headers].map(([name, value]) => [name.toLowerCase(), value]));
    const lose = (requestId: string) =>
      session.send("Fetch.failRequest", { requestId, errorReason: "Failed" });
    const respond = (event: unknown) => {
      const paused = Schema.decodeUnknownSync(Paused)(event);
      const { requestId } = paused;
      if (paused.responseStatusCode === undefined)
        return session.send("Fetch.continueRequest", { requestId });
      const serverHeaders = paused.responseHeaders ?? [];
      return Promise.resolve(
        answer({
          url: paused.request.url,
          method: paused.request.method,
          requestHeaders: lowerCase(Object.entries(paused.request.headers)),
          requestBody: Buffer.concat(
            (paused.request.postDataEntries ?? []).map(({ bytes }) => Buffer.from(bytes, "base64")),
          ).toString(),
          status: paused.responseStatusCode,
          headers: lowerCase(serverHeaders.map(({ name, value }) => [name, value] as const)),
          body: () =>
            session
              .send("Fetch.getResponseBody", { requestId })
              .then((result) => Schema.decodeUnknownSync(ResponseBody)(result))
              .then(({ body, base64Encoded }) =>
                Buffer.from(body, base64Encoded ? "base64" : "utf8").toString(),
              ),
        }),
      ).then((replacement) => {
        if (replacement === "unchanged")
          return session.send("Fetch.continueRequest", { requestId });
        if (replacement === "failed") return lose(requestId);
        const replaced = new Set([
          ...bodyHeaders,
          ...Object.keys(replacement.headers ?? {}).map((name) => name.toLowerCase()),
        ]);
        return session.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: replacement.status,
          responseHeaders: [
            ...serverHeaders.filter(({ name }) => !replaced.has(name.toLowerCase())),
            ...Object.entries(replacement.headers ?? {}).map(([name, value]) => ({ name, value })),
            { name: "content-type", value: replacement.contentType },
          ],
          body: Buffer.from(replacement.body).toString("base64"),
        });
      });
    };
    session.on("Fetch.requestPaused", (event) => {
      void Promise.resolve()
        .then(() => respond(event))
        .catch((cause: unknown) => {
          failures.push(cause);
          // The page sees a lost connection instead of waiting forever; the scope still fails.
          return lose(Schema.decodeUnknownSync(Paused)(event).requestId).catch(() => {});
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
            withCause(
              new DriverFailed({
                operation: "Replace a response the browser received",
                cause: Redacted.make(failures),
              }),
            ),
          ),
    );
  });
