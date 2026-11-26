import { Effect, Redacted, Schema } from "effect";
import { Browser } from "./browser.ts";
import { DriverFailed, driver, withCause } from "./platform.ts";

export interface ReceivedResponse {
  readonly url: string;
  readonly method: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestBody: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: () => Promise<string>;
}

export interface Replacement {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
  readonly headers?: Readonly<Record<string, string>>;
}

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

const bodyHeaders = new Set(["content-length", "content-encoding", "content-type"]);

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
