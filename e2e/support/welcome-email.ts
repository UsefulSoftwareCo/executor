import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Redacted,
  Ref,
  Schedule,
  Schema,
} from "effect";
import { Base64Url } from "effect/encoding";
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

class WelcomeTestFailed extends Schema.TaggedError<WelcomeTestFailed>()("WelcomeTestFailed", {
  operation: Schema.String,
}) {}

const make = Effect.gen(function* () {
  const origin = yield* Config.String("WELCOME_TEST_ORIGIN");
  const worker = yield* Config.String("WELCOME_TEST_WORKER_ORIGIN");
  const log = yield* Config.String("WELCOME_TEST_MAIL_LOG");
  // The local mail capture records no headers, so the test signs the List-Unsubscribe
  // token itself, in the same versioned format the Worker verifies, with the stage's secret.
  const authSecret = yield* Config.Redacted("WELCOME_TEST_AUTH_SECRET");
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
  /** The browser link and token a welcome's List-Unsubscribe header carries for the signed-in user. */
  const links = (recipient: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* client.get(`${origin}/api/auth/get-session`, {
          headers: { origin },
        });
        const session = yield* response.json.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
            ),
          ),
        );
        const key = yield* Effect.promise(() =>
          crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(Redacted.value(authSecret)),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          ),
        );
        const signed = JSON.stringify([
          "executor.optional-email.unsubscribe.v1",
          session.user.id,
          recipient.trim().toLowerCase(),
        ]);
        const signature = yield* Effect.promise(() =>
          crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)),
        );
        const token = `${Base64Url.encode(session.user.id)}.${Base64Url.encode(new Uint8Array(signature))}`;
        return { browser: `${origin}/email/unsubscribe#${token}`, token };
      }),
    ).pipe(Effect.mapError(() => new WelcomeTestFailed({ operation: "Sign unsubscribe token" })));
  /** The latest code of a flow: a new email's first code is a sign-up code. */
  const code = (recipient: string, flow: "sign-in" | "sign-up", count = 1) =>
    messages(recipient, `Your Executor ${flow} code`).pipe(
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
    messages(recipient, "Welcome to Executor").pipe(
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
  return { request, messages, code, welcome, links, tick, preference, origin };
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
