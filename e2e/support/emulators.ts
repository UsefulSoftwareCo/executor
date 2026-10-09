import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { createHash, randomUUID } from "node:crypto";
import { Target } from "./platform.ts";
import { roleHost } from "./role-hosts.ts";

export const BaseUrl = Schema.String.check(
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
const GoogleDiscovery = Schema.Struct({
  issuer: BaseUrl,
  authorization_endpoint: BaseUrl,
  token_endpoint: BaseUrl,
  userinfo_endpoint: BaseUrl,
  jwks_uri: BaseUrl,
  id_token_signing_alg_values_supported: Schema.Array(Schema.Literal("RS256")).check(
    Schema.isMinLength(1),
  ),
});
const GoogleProvider = Schema.Struct({ ...Provider.fields, discovery: GoogleDiscovery }).check(
  Schema.makeFilter(
    ({ baseUrl, discovery }) =>
      discovery.issuer === baseUrl &&
      [
        discovery.authorization_endpoint,
        discovery.token_endpoint,
        discovery.userinfo_endpoint,
        discovery.jwks_uri,
      ].every((endpoint) => endpoint.startsWith(`${baseUrl}/`)),
  ),
);

/** Private control-plane output consumed by both deployment configuration and black-box tests. */
export const EmulatorFixture = Schema.Struct({
  version: Schema.Literal(4),
  origin: Schema.String,
  services: Schema.Struct({
    google: GoogleProvider,
    github: Provider,
    mail: Schema.Struct({ baseUrl: BaseUrl, token: Schema.NonEmptyString }),
    company: Schema.Struct({ baseUrl: BaseUrl, token: Schema.NonEmptyString }),
    billing: Schema.Struct({ baseUrl: BaseUrl, token: Schema.NonEmptyString }),
    workos: Schema.Struct({ baseUrl: BaseUrl, token: Schema.NonEmptyString }),
  }),
});
/**
 * The diagnostic fields of an emulators.dev failure report (emulate#36). A field is kept only
 * when it holds a value the harness already knows or a name from a fixed list, so a report can
 * add no text of its own: the service and instance hash must be the ones the harness addressed,
 * the method the one it sent, the route a template of the path it requested (dynamic segments
 * shown as `:param`), and the error class one of emulate's allowlisted names. Anything else in a
 * response body, a raw `message` included, is dropped, and a body without a known `error` is not
 * reported at all.
 */
const FailureReport = Schema.Struct({
  error: Schema.Literals(["emulator_unavailable", "emulator_error", "worker_error"]),
  service: Schema.optional(Schema.String),
  instanceId: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  route: Schema.optional(Schema.String),
  errorClass: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  overloaded: Schema.optional(Schema.Boolean),
  remote: Schema.optional(Schema.Boolean),
});
type FailureReport = typeof FailureReport.Type;
const decodeReportError = Schema.decodeUnknownOption(FailureReport.fields.error);
const decodeBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeRay = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}(?:-[A-Z]{3})?$/u)),
);

/** The emulators the harness provisions; a report naming any other service is not believed. */
const SERVICES = new Set(["autumn", "context", "github", "google", "mcp", "planetscale", "resend"]);
/** emulate#36's error class allowlist; it reports every other name as `other`. */
const ERROR_CLASSES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DataCloneError",
  "QuotaExceededError",
  "InvalidStateError",
  "NetworkError",
  "OperationError",
  "other",
]);

/** The route as a template of the requested path: literal segments equal, the rest `:param`. */
const routeOf = (route: unknown, path: string): string | undefined => {
  if (route === "unmatched" || route === "unknown") return route;
  if (typeof route !== "string") return undefined;
  const requested = (path.split("?")[0] ?? "").split("/");
  const segments = route.split("/");
  if (segments.length !== requested.length) return undefined;
  const template = segments.map((segment, index) =>
    segment === requested[index]
      ? segment
      : /^:[A-Za-z_][A-Za-z0-9_]*$/u.test(segment)
        ? ":param"
        : undefined,
  );
  return template.includes(undefined) ? undefined : template.join("/");
};

const reportOf = (
  text: string,
  request: {
    readonly target: EmulatorTarget | undefined;
    readonly method: string;
    readonly path: string;
  },
): FailureReport | undefined => {
  const body = Option.getOrUndefined(decodeBody(text));
  const error =
    body === undefined ? undefined : Option.getOrUndefined(decodeReportError(body.error));
  if (body === undefined || error === undefined) return undefined;
  const known = <A>(value: unknown, accepted: (value: unknown) => value is A) =>
    accepted(value) ? value : undefined;
  const flag = (value: unknown) => (typeof value === "boolean" ? value : undefined);
  return {
    error,
    service: known(
      body.service,
      (value): value is string =>
        value === "unknown" || (SERVICES.has(String(value)) && value === request.target?.service),
    ),
    instanceId: known(
      body.instanceId,
      (value): value is string =>
        request.target?.instanceId !== undefined && value === request.target.instanceId,
    ),
    method: known(
      body.method,
      (value): value is string => value === request.method || value === "OTHER",
    ),
    route: routeOf(body.route, request.path),
    errorClass: known(body.errorClass, (value): value is string =>
      ERROR_CLASSES.has(String(value)),
    ),
    retryable: flag(body.retryable),
    overloaded: flag(body.overloaded),
    remote: flag(body.remote),
  };
};

class EmulatorFailed extends Schema.TaggedError<EmulatorFailed>()("EmulatorFailed", {
  operation: Schema.String,
  /** `service/prefix-… #id`: the instance's unguessable suffix elided, with emulate's instance hash. */
  emulator: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.Literals(["timeout", "request", "invalid response"])),
  /** Cloudflare's request id: finds the request in emulators.dev's Workers Logs. */
  ray: Schema.optional(Schema.String),
  /** emulators.dev's own failure report, reduced to its diagnostic fields. */
  report: Schema.optional(FailureReport),
}) {
  get message() {
    const target = this.emulator === undefined ? "" : ` on ${this.emulator}`;
    const detail = [
      this.status === undefined ? this.reason : `HTTP ${this.status}`,
      this.ray === undefined ? undefined : `cf-ray ${this.ray}`,
    ].filter((part) => part !== undefined);
    const words = (parts: ReadonlyArray<string | undefined>) =>
      parts.filter((part) => part !== undefined).join(" ");
    const report =
      this.report === undefined
        ? ""
        : `: ${[
            words([
              this.report.error,
              this.report.method === undefined && this.report.route === undefined
                ? undefined
                : `at ${this.report.method ?? "?"} ${this.report.route ?? "?"}`,
            ]),
            words([
              this.report.errorClass,
              this.report.retryable === true ? "retryable" : undefined,
              this.report.overloaded === true ? "overloaded" : undefined,
              this.report.remote === true ? "remote" : undefined,
            ]),
          ]
            .filter((part) => part.length > 0)
            .join(", ")}`;
    return `External emulator failed: ${this.operation}${target}${detail.length === 0 ? "" : ` (${detail.join(", ")})`}${report}`;
  }
}
class MailPending extends Schema.TaggedError<MailPending>()("MailPending", {}) {}

interface EmulatorTarget {
  /** `service/prefix-… #id`: the instance's unguessable suffix elided, with emulate's instance hash. */
  readonly label: string;
  readonly service: string;
  readonly instanceId: string | undefined;
}

/**
 * Names the emulator an origin points at without its capability: an instance name ends in a
 * random suffix that is the only access control, so it is elided. emulate's instance hash, the
 * first 12 hex digits of SHA-256(`service:instance`), finds the instance in its reports. The hash
 * hides a generated name, whose suffix has 96 random bits, but not a predictable one.
 */
const emulatorTarget = (origin: string): EmulatorTarget | undefined => {
  const url = URL.parse(origin);
  if (url === null) return undefined;
  const labels = url.hostname.split(".").slice(0, -2);
  const [service, instance] =
    labels.length > 0 ? labels : url.pathname.split("/").filter((segment) => segment.length > 0);
  if (service === undefined) return undefined;
  if (instance === undefined) return { label: service, service, instanceId: undefined };
  const cut = instance.lastIndexOf("-");
  const instanceId = createHash("sha256")
    .update(`${service}:${instance}`)
    .digest("hex")
    .slice(0, 12);
  return {
    label: `${service}/${cut < 0 ? "" : instance.slice(0, cut + 1)}… #${instanceId}`,
    service,
    instanceId,
  };
};

/**
 * Turns off client tracing for a call to an emulator: Effect's client span records the full URL
 * as `url.full` and `server.address`, and an instance URL is the only access control for its
 * emulator. Every harness request to emulators.dev goes through `emulatorRequest` or this.
 */
export const withoutEmulatorTracing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true));

/**
 * Calls only an external emulator. Failures never carry a provider URL, credential, response
 * body or underlying error: the instance URL is the only access control for its emulator, and a
 * body can quote tokens, sign-in codes and addresses. Client tracing is off for these requests,
 * because its span records the full URL as `url.full` and `server.address`.
 */
export const emulatorRequest = (
  origin: string,
  path: string,
  payload?: unknown,
  token?: string,
) => {
  const method = payload === undefined ? "GET" : "POST";
  const operation = `${method} ${path}`;
  const target = emulatorTarget(origin);
  const emulator = target?.label;
  return Effect.scoped(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      let request = HttpClientRequest.make(method)(`${origin}${path}`);
      if (token !== undefined)
        request = HttpClientRequest.setHeader(request, "authorization", `Bearer ${token}`);
      if (payload !== undefined) request = yield* HttpClientRequest.bodyJson(request, payload);
      const response = yield* withoutEmulatorTracing(http.execute(request));
      if (response.status < 200 || response.status >= 300) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        return yield* new EmulatorFailed({
          operation,
          emulator,
          status: response.status,
          ray: Option.getOrUndefined(decodeRay(response.headers["cf-ray"])),
          report: reportOf(text, { target, method, path }),
        });
      }
      return yield* response.json;
    }),
  ).pipe(
    Effect.timeout("30 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new EmulatorFailed({ operation, emulator, reason: "timeout" })),
    ),
    Effect.mapError((error) =>
      error instanceof EmulatorFailed
        ? error
        : new EmulatorFailed({ operation, emulator, reason: "request" }),
    ),
  );
};

/**
 * Provision actual hosted instances and credentials through emulators.dev's control plane, for a
 * Cloud deployment at `origin`. Cloud's providers return sign-in to its edge, which stands in
 * for `executor.sh`, so that is the one callback each sign-in client registers.
 */
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
          redirect_uris: [`${roleHost(origin, "edge")}/api/auth/callback/${service}`],
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
    const googleClient = yield* oauth("google");
    const discovery = yield* emulatorRequest(
      googleClient.baseUrl,
      "/.well-known/openid-configuration",
    );
    const google = yield* Schema.decodeUnknownEffect(GoogleProvider)({
      ...googleClient,
      discovery,
    });
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
        version: 4,
        origin,
        services: {
          google,
          github,
          mail: yield* keyed("resend"),
          company: yield* keyed("context"),
          // Cloud accepts only Autumn-shaped keys; a private instance is keyed like the sandbox.
          billing: yield* keyed("autumn", `am_sk_test_${randomUUID().replaceAll("-", "")}`),
          workos: yield* keyed("workos"),
        },
      }),
    );
  }).pipe(
    // A decode failure would print the response, which holds client secrets and tokens.
    Effect.mapError((error) =>
      error instanceof EmulatorFailed
        ? error
        : new EmulatorFailed({ operation: "Create emulator fixture", reason: "invalid response" }),
    ),
  );

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* Target;
  // Methods use the client captured when the service is built, not one from each caller.
  const http = yield* HttpClient.HttpClient;
  const request = (...args: Parameters<typeof emulatorRequest>) =>
    emulatorRequest(...args).pipe(Effect.provideService(HttpClient.HttpClient, http));
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
    request(value.services.mail.baseUrl, "/emails", undefined, value.services.mail.token).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                to: Schema.Array(Schema.String),
                subject: Schema.String,
                text: Schema.NullOr(Schema.String),
              }),
            ),
          }),
        ),
      ),
      // A decode failure would print the listing, which holds sign-in codes.
      Effect.mapError((error) =>
        error instanceof EmulatorFailed
          ? error
          : new EmulatorFailed({
              operation: "GET /emails",
              emulator: emulatorTarget(value.services.mail.baseUrl)?.label,
              reason: "invalid response",
            }),
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
        const match = /^(executor-next-[a-z0-9-]+?)-(free|team|enterprise)$/.exec(input.planId);
        if (!match?.[1])
          return yield* new EmulatorFailed({ operation: "Expected a stage-scoped billing plan" });
        yield* request(
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
          yield* request(value.services.company.baseUrl, "/_emulate/seed", {
            brands: [{ domain, title: "Example Company" }],
          });
        yield* request(value.services[provider].baseUrl, "/_emulate/seed", {
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
    /** Seed a Google profile for an address that may already have an Executor account. */
    googleUser: (user: {
      readonly email: string;
      readonly name: string;
      readonly picture: string;
    }) =>
      request(value.services.google.baseUrl, "/_emulate/seed", {
        users: [{ ...user, email_verified: true }],
      }).pipe(Effect.asVoid),
    /** Make an email an active member of a new organization in the emulated v1 WorkOS. */
    v1Member: (email: string) =>
      request(value.services.workos.baseUrl, "/_emulate/seed", {
        users: [{ email, first_name: "Synthetic", last_name: "Member" }],
        organizations: [{ name: `V1 ${randomUUID().slice(0, 8)}`, members: [email] }],
      }).pipe(Effect.asVoid),
    /**
     * Fail the next membership read once. Only accounts seeded with `v1Member` reach that read,
     * so other scenarios sharing this emulator never consume the fault.
     */
    failNextV1MembershipRead: request(value.services.workos.baseUrl, "/_emulate/faults", {
      match: { method: "GET", pathPattern: "/user_management/organization_memberships" },
      response: { status: 503, body: { error: "temporarily_unavailable" } },
    }).pipe(Effect.asVoid),
    received: (email: string) =>
      messages(email).pipe(Effect.map((rows) => rows.map((row) => row.id))),
    /** The newest new code and its email subject. */
    mail: (email: string, previouslyReceived: ReadonlyArray<string>) =>
      messages(email).pipe(
        Effect.flatMap((data) => {
          const message = data.filter((item) => !previouslyReceived.includes(item.id)).at(-1);
          const code = message?.text?.match(/\b\d{6}\b/)?.[0];
          return message !== undefined && code
            ? Effect.succeed({ code: Redacted.make(code), subject: message.subject })
            : Effect.fail(new MailPending());
        }),
        Effect.retry({
          while: (error) => error instanceof MailPending,
          schedule: Schedule.spaced("250 millis"),
          times: 80,
        }),
        // Only "no code arrived" is reported as such; a failed or malformed mail
        // listing keeps its own endpoint, status and body.
        Effect.catchTag("MailPending", () =>
          Effect.fail(
            new EmulatorFailed({ operation: "Read delivered email code (none within 20 s)" }),
          ),
        ),
      ),
  };
});

/** Per-test external identities and delivered mail; never creates an Executor session. */
export class Emulators extends Context.Service<Emulators, Effect.Success<typeof make>>()(
  "e2e/Emulators",
) {
  static readonly layer = Layer.effect(Emulators, make);
}
