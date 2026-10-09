import { expect, layer } from "@effect/vitest";
import { Config, Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

class EmailIsolationFailed extends Schema.TaggedError<EmailIsolationFailed>()(
  "EmailIsolationFailed",
  { operation: Schema.optionalKey(Schema.String), status: Schema.optionalKey(Schema.Number) },
) {}

const Capture = Schema.Struct({ baseUrl: Schema.String, token: Schema.String });
const Messages = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      to: Schema.Array(Schema.String),
      subject: Schema.String,
      text: Schema.NullOr(Schema.String),
    }),
  ),
});
const Settings = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    tags: Schema.Array(Schema.String),
    bindings: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String })),
  }),
});

/** Exercise an owned disposable preview, with control-plane reads before any signup request. */
layer(Layer.mergeAll(FetchHttpClient.layer), { excludeTestServices: true })(
  "Test-stage email isolation",
  (it) => {
    it.effect("captures login and welcome mail without a native sending binding", () =>
      Effect.gen(function* () {
        const slug = yield* Config.String("EMAIL_ISOLATION_SLUG");
        expect(slug).toMatch(/^[a-z0-9-]+$/u);
        const origin = `https://${slug}.executor.engineering`;
        const account = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
        const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
        const workers = (yield* Config.String("EMAIL_ISOLATION_WORKERS")).split(",");
        expect(workers.length).toBeGreaterThan(0);
        const http = yield* HttpClient.HttpClient;
        const json = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.scoped(
            Effect.gen(function* () {
              const response = yield* http.execute(request);
              if (response.status < 200 || response.status >= 300)
                return yield* new EmailIsolationFailed({
                  operation: request.url.includes("/workers/scripts/")
                    ? "Inspect worker"
                    : request.url.includes("/resend/")
                      ? "Read capture"
                      : "Auth request",
                  status: response.status,
                });
              return yield* response.json;
            }),
          ).pipe(
            Effect.mapError((error) =>
              error instanceof EmailIsolationFailed ? error : new EmailIsolationFailed({}),
            ),
          );
        for (const worker of workers) {
          const settings = yield* json(
            HttpClientRequest.get(
              `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(worker)}/settings`,
            ).pipe(HttpClientRequest.bearerToken(token)),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Settings)));
          expect(settings.result.tags).toContain(`alchemy:stage:test-${slug}`);
          expect(
            settings.result.bindings.some((binding) => binding.name === "EXECUTOR_EMULATORS"),
          ).toBe(false);
          expect(
            settings.result.bindings.filter((binding) => binding.type === "send_email"),
          ).toEqual([]);
        }
        // Deliberately resolved only after the binding assertion: the negative control must
        // fail before attempting to send any message through an unfixed preview.
        const capture = yield* Config.Redacted("EMAIL_ISOLATION_CAPTURE").pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(Capture))(Redacted.value(value)),
          ),
        );
        expect(
          /^https:\/\/emulators\.dev\/resend\/executor-next-[a-f0-9]{24}$/u.test(capture.baseUrl),
        ).toBe(true);
        const email = `email-isolation-${crypto.randomUUID()}@example.test`;
        const messages = json(
          HttpClientRequest.get(`${capture.baseUrl}/emails`).pipe(
            HttpClientRequest.bearerToken(Redacted.make(capture.token)),
          ),
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Messages)),
          Effect.map(({ data }) => data.filter((message) => message.to.includes(email))),
        );
        const post = (path: string, body: unknown) =>
          HttpClientRequest.post(`${origin}${path}`, { headers: { origin } }).pipe(
            HttpClientRequest.bodyJson(body),
            Effect.flatMap(json),
          );
        yield* post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
        const code = yield* messages.pipe(
          Effect.flatMap((mail) => {
            const code = mail
              .find((message) => message.subject === "Your Executor sign-up code")
              ?.text?.match(/\b(\d{6})\b/u)?.[1];
            return code === undefined
              ? Effect.fail(new EmailIsolationFailed({}))
              : Effect.succeed(code);
          }),
          Effect.retry({ times: 20, schedule: Schedule.spaced("250 millis") }),
        );
        expect(
          (yield* messages).filter((mail) => mail.subject === "welcome to executor"),
        ).toHaveLength(0);
        yield* post("/api/auth/sign-in/email-otp", {
          email,
          otp: code,
          name: "Synthetic Reviewer",
        });
        const welcomed = yield* messages.pipe(
          Effect.filterOrFail(
            (mail) => mail.some((message) => message.subject === "welcome to executor"),
            () => new EmailIsolationFailed(),
          ),
          Effect.retry({ times: 40, schedule: Schedule.spaced("500 millis") }),
        );
        expect(welcomed.filter((mail) => mail.subject === "welcome to executor")).toHaveLength(1);
      }),
    );
  },
);
