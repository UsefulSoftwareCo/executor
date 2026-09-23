import { Config, Context, Effect, FileSystem, Layer, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { randomUUID } from "node:crypto";
import { Target } from "./platform.ts";

const BaseUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !value.endsWith("/") &&
      url.protocol === "https:" &&
      (url.hostname === "emulators.dev" || url.hostname.endsWith(".emulators.dev"))
    );
  }),
);
const Provider = Schema.Struct({
  baseUrl: BaseUrl,
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.NonEmptyString,
});
/** Private control-plane output consumed by both deployment configuration and black-box tests. */
export const EmulatorFixture = Schema.Struct({
  version: Schema.Literal(2),
  origin: Schema.String,
  services: Schema.Struct({
    google: Provider,
    github: Provider,
    mail: Schema.Struct({ baseUrl: BaseUrl, token: Schema.NonEmptyString }),
    company: Schema.Struct({ baseUrl: BaseUrl, token: Schema.NonEmptyString }),
    billing: Schema.Struct({ baseUrl: BaseUrl, token: Schema.NonEmptyString }),
  }),
});
class EmulatorFailed extends Schema.TaggedError<EmulatorFailed>()("EmulatorFailed", {
  operation: Schema.String,
}) {
  get message() {
    return `External emulator failed: ${this.operation}`;
  }
}
class MailPending extends Schema.TaggedError<MailPending>()("MailPending", {}) {}

/** Calls only an external emulator; failures never serialize provider URLs or credentials. */
export const emulatorRequest = (origin: string, path: string, payload?: unknown, token?: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      let request = HttpClientRequest.make(payload === undefined ? "GET" : "POST")(
        `${origin}${path}`,
      );
      if (token !== undefined)
        request = HttpClientRequest.setHeader(request, "authorization", `Bearer ${token}`);
      if (payload !== undefined) request = yield* HttpClientRequest.bodyJson(request, payload);
      const response = yield* http.execute(request);
      if (response.status < 200 || response.status >= 300)
        return yield* new EmulatorFailed({ operation: path });
      return yield* response.json;
    }),
  ).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError(() => new EmulatorFailed({ operation: path })),
  );

/** Provision actual hosted instances and credentials through emulators.dev's control plane. */
export const createEmulatorFixture = (origin: string) =>
  Effect.gen(function* () {
    const instance = `executor-onboarding-${randomUUID()}`;
    const create = (service: string) =>
      emulatorRequest(`https://${service}.emulators.dev`, "/_emulate/instances", {
        instance,
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ providerBaseUrl: BaseUrl }))),
      );
    const oauth = (service: "google" | "github") =>
      Effect.gen(function* () {
        const instance = yield* create(service);
        const issued = yield* emulatorRequest(instance.providerBaseUrl, "/_emulate/credentials", {
          type: "oauth-authorization-code",
          name: "Executor onboarding E2E",
          redirect_uris: [`${origin}/api/auth/callback/${service}`],
        }).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                credential: Schema.Struct({
                  client_id: Schema.NonEmptyString,
                  client_secret: Schema.NonEmptyString,
                }),
              }),
            ),
          ),
        );
        return {
          baseUrl: instance.providerBaseUrl,
          clientId: issued.credential.client_id,
          clientSecret: issued.credential.client_secret,
        };
      });
    const google = yield* oauth("google");
    const github = yield* oauth("github");
    const keyed = (service: string, token?: string) =>
      Effect.gen(function* () {
        const instance = yield* create(service);
        const issued = yield* emulatorRequest(instance.providerBaseUrl, "/_emulate/credentials", {
          type: "api-key",
          ...(token === undefined ? {} : { token }),
        }).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({ credential: Schema.Struct({ token: Schema.NonEmptyString }) }),
            ),
          ),
        );
        return { baseUrl: instance.providerBaseUrl, token: issued.credential.token };
      });
    return Redacted.make(
      EmulatorFixture.make({
        version: 2,
        origin,
        services: {
          google,
          github,
          mail: yield* keyed("resend"),
          company: yield* keyed("context"),
          // Cloud accepts only Autumn-shaped keys; a private instance is keyed like the sandbox.
          billing: yield* keyed("autumn", `am_sk_test_${randomUUID().replaceAll("-", "")}`),
        },
      }),
    );
  });

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* Target;
  const file = yield* Config.String("E2E_EMULATORS");
  const fixture = yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(EmulatorFixture))),
    Effect.map(Redacted.make),
    Effect.mapError(() => new EmulatorFailed({ operation: "Read E2E_EMULATORS fixture" })),
  );
  const value = Redacted.value(fixture);
  if (value.origin !== target.metadata.origin)
    return yield* new EmulatorFailed({ operation: "Fixture belongs to another server" });
  const messages = (email: string) =>
    emulatorRequest(
      value.services.mail.baseUrl,
      "/emails",
      undefined,
      value.services.mail.token,
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                to: Schema.Array(Schema.String),
                text: Schema.NullOr(Schema.String),
              }),
            ),
          }),
        ),
      ),
      Effect.map(({ data }) => data.filter((message) => message.to.includes(email))),
    );
  return {
    billingSubscription: (input: {
      readonly organizationId: string;
      readonly planId: string;
      readonly status: "active" | "trialing" | "scheduled" | "expired";
    }) =>
      Effect.gen(function* () {
        const match =
          /^(executor-next-[a-z0-9-]+?)-(free|free-pay-as-you-go|team|enterprise)$/.exec(
            input.planId,
          );
        if (!match?.[1])
          return yield* new EmulatorFailed({ operation: "Expected a stage-scoped billing plan" });
        yield* emulatorRequest(
          value.services.billing.baseUrl,
          "/_emulate/seed",
          {
            customers: [
              {
                id: `${match[1]}:organization:${input.organizationId}`,
                subscriptions: [{ plan_id: input.planId, status: input.status }],
              },
            ],
          },
          value.services.billing.token,
        );
      }),
    identity: (provider: "google" | "github") =>
      Effect.gen(function* () {
        const login = `onboarding-${randomUUID().slice(0, 8)}`;
        const domain = provider === "google" ? `${login}.company.example` : "example.test";
        const email = `${login}@${domain}`;
        if (provider === "google")
          yield* emulatorRequest(value.services.company.baseUrl, "/_emulate/seed", {
            brands: [{ domain, title: "Example Company" }],
          });
        yield* emulatorRequest(value.services[provider].baseUrl, "/_emulate/seed", {
          users: [
            {
              ...(provider === "github" ? { login } : {}),
              email,
              name: "Onboarding Example",
              email_verified: true,
            },
          ],
        });
        return { login, email, companyName: provider === "google" ? "Example Company" : null };
      }),
    received: (email: string) =>
      messages(email).pipe(Effect.map((rows) => rows.map((row) => row.id))),
    mail: (email: string, previouslyReceived: ReadonlyArray<string>) =>
      messages(email).pipe(
        Effect.flatMap((data) => {
          const code = data
            .filter((message) => !previouslyReceived.includes(message.id))
            .at(-1)
            ?.text?.match(/\b\d{6}\b/)?.[0];
          return code ? Effect.succeed(Redacted.make(code)) : Effect.fail(new MailPending());
        }),
        Effect.retry({
          while: (error) => error instanceof MailPending,
          schedule: Schedule.spaced("250 millis"),
          times: 80,
        }),
        Effect.mapError(() => new EmulatorFailed({ operation: "Read delivered email code" })),
      ),
  };
});

/** Per-test external identities and delivered mail; never creates an Executor session. */
export class Emulators extends Context.Service<Emulators, Effect.Success<typeof make>>()(
  "e2e/Emulators",
) {
  static readonly layer = Layer.effect(Emulators, make);
}
