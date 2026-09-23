import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Context, Effect, FileSystem, Layer, Ref, Schedule, Schema } from "effect";
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

class WelcomeTestFailed extends Schema.TaggedError<WelcomeTestFailed>()("WelcomeTestFailed", {
  operation: Schema.String,
}) {}

const make = Effect.gen(function* () {
  const origin = yield* Config.String("WELCOME_TEST_ORIGIN");
  const worker = yield* Config.String("WELCOME_TEST_WORKER_ORIGIN");
  const log = yield* Config.String("WELCOME_TEST_MAIL_LOG");
  if (!/^https:\/\/127\.0\.0\.1:\d+$/.test(origin) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(worker))
    return yield* new WelcomeTestFailed({ operation: "Require an isolated loopback cloud host" });
  const fs = yield* FileSystem.FileSystem;
  const base = yield* HttpClient.HttpClient;
  const jar = yield* Ref.make(Cookies.empty);
  const client = base.pipe(HttpClient.withCookiesRef(jar));
  const request = (path: string, body: unknown) =>
    Effect.scoped(
      Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(`${origin}${path}`, {
          headers: { origin },
        }).pipe(HttpClientRequest.bodyJson(body));
        const response = yield* client.execute(request);
        yield* response.text;
        return response.status;
      }),
    );
  // The native Alchemy binding captures MessageBuilder bodies on disk and records
  // envelope metadata plus the paths in its dev log. Nothing is sent externally.
  const messages = (recipient: string, subject: string) =>
    Effect.gen(function* () {
      const contents = yield* fs.readFileString(log);
      const matches = contents
        .split("send_email binding called with MessageBuilder:")
        .filter(
          (entry) =>
            entry.includes(`To: ${recipient}\n`) && entry.includes(`Subject: ${subject}\n`),
        );
      return yield* Effect.forEach(matches, (entry) =>
        Effect.gen(function* () {
          const textPath = entry.match(/Text: ([^\r\n]+)/)?.[1];
          const htmlPath = entry.match(/HTML: ([^\r\n]+)/)?.[1];
          const from = entry.match(/From: ([^\r\n]+)/)?.[1];
          if (!textPath || !htmlPath || !from)
            return yield* new WelcomeTestFailed({ operation: "Incomplete captured email" });
          return {
            from,
            text: yield* fs.readFileString(textPath),
            html: yield* fs.readFileString(htmlPath),
          };
        }),
      );
    });
  const code = (recipient: string, count = 1) =>
    messages(recipient, "Your Executor sign-in code").pipe(
      Effect.flatMap((mail) => {
        const otp =
          mail.length >= count ? mail.at(-1)?.text.match(/\n\n(\d{6})\n\n/)?.[1] : undefined;
        return otp
          ? Effect.succeed(otp)
          : Effect.fail(new WelcomeTestFailed({ operation: "Wait for captured sign-in code" }));
      }),
      Effect.retry({ times: 20, schedule: Schedule.spaced("100 millis") }),
    );
  const welcome = (recipient: string) =>
    messages(recipient, "welcome to executor").pipe(
      Effect.flatMap((mail) =>
        mail.length > 0
          ? Effect.succeed(mail)
          : Effect.fail(new WelcomeTestFailed({ operation: "Wait for provider capture log" })),
      ),
      Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
    );
  const tick = () =>
    Effect.scoped(
      base
        .get(`${worker}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`)
        .pipe(Effect.flatMap((response) => response.text.pipe(Effect.as(response.status)))),
    );
  const preference = (
    method: "GET" | "POST",
    token: string,
    mode: "one-click" | "browser" | "multipart" = "one-click",
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const url = new URL("/api/email/unsubscribe", origin);
        if (mode !== "browser") url.searchParams.set("token", token);
        let input = HttpClientRequest.make(method)(url);
        if (method === "POST") {
          if (mode === "multipart") {
            const form = new FormData();
            form.set("List-Unsubscribe", "One-Click");
            input = HttpClientRequest.bodyFormData(input, form);
          } else {
            const body = new URLSearchParams({
              "List-Unsubscribe": "One-Click",
              ...(mode === "browser" ? { token } : {}),
            });
            input = HttpClientRequest.bodyText(
              input,
              body.toString(),
              "application/x-www-form-urlencoded",
            );
          }
        }
        // Use the bare client: one-click unsubscribe must not depend on login cookies.
        const response = yield* base.execute(input);
        yield* response.text;
        return { status: response.status, location: response.headers.location };
      }),
    ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  return { request, messages, code, welcome, tick, preference, origin };
});

/** Read only this dev host's captured messages and exercise its real auth and cron endpoints. */
export class WelcomeEmailTarget extends Context.Service<
  WelcomeEmailTarget,
  Effect.Success<typeof make>
>()("e2e/WelcomeEmailTarget") {
  static readonly layer = Layer.effect(WelcomeEmailTarget, make).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
}
