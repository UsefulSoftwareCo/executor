import {
  Clock,
  Config,
  Console,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { createHash, randomUUID } from "node:crypto";
import { Target } from "./platform.ts";
import { emulatorRetryDirectory, type EmulatorRetry } from "../emulator-retries.ts";
import { roleHost } from "./role-hosts.ts";
import { heldValue, reveal, secret } from "./failure-text.ts";
import {
  CallFailed,
  parseJson,
  readResponse,
  RequestFailure,
  requestFailureText,
} from "./request-failure.ts";

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

const V1Users = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });

const V1Memberships = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ organization_id: Schema.String, organization_name: Schema.String }),
  ),
});

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

const SERVICES = new Set(["autumn", "context", "github", "google", "mcp", "planetscale", "resend"]);
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
  emulator: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.Literals(["timeout", "request", "invalid response"])),
  ray: Schema.optional(Schema.String),
  report: Schema.optional(FailureReport),
  failure: Schema.optional(RequestFailure),
  armed: Schema.optional(Schema.Boolean),
  earlier: Schema.optional(Schema.Array(Schema.String)),
  elapsedMs: Schema.optional(Schema.Number),
}) {
  get attemptText() {
    return this.detail ?? "failed";
  }

  private get detail() {
    const parts = [
      this.failure !== undefined
        ? this.failure.stage === "timeout"
          ? requestFailureText(this.failure)
          : `${this.reason ?? "request"}: ${requestFailureText(this.failure)}`
        : this.status === undefined
          ? this.reason
          : `HTTP ${this.status}`,
      this.ray === undefined ? undefined : `cf-ray ${this.ray}`,
    ].filter((part) => part !== undefined);
    return parts.length === 0 ? undefined : parts.join(", ");
  }

  get message() {
    const target = this.emulator === undefined ? "" : ` on ${this.emulator}`;
    if (this.earlier !== undefined && this.earlier.length > 0) {
      const attempts = [...this.earlier, this.attemptText];
      return `External emulator failed: ${this.operation}${target} after ${attempts.length} attempts in ${Math.round((this.elapsedMs ?? 0) / 100) / 10} s (${attempts
        .map((text, index) => `attempt ${index + 1}: ${text}`)
        .join("; ")})${this.reportText}`;
    }
    return `External emulator failed: ${this.operation}${target}${this.detail === undefined ? "" : ` (${this.detail})`}${this.reportText}`;
  }

  private get reportText() {
    if (this.report === undefined) return "";
    const words = (parts: ReadonlyArray<string | undefined>) =>
      parts.filter((part) => part !== undefined).join(" ");
    return `: ${[
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
  }
}
class MailPending extends Schema.TaggedError<MailPending>()("MailPending", {}) {}

interface EmulatorTarget {
  readonly label: string;
  readonly service: string;
  readonly instanceId: string | undefined;
}

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

export const withoutEmulatorTracing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true));

export const EmulatorDeadline = Context.Reference<Duration.Input>("e2e/EmulatorDeadline", {
  defaultValue: () => "30 seconds",
});

export const armedFaultHeader = "x-executor-e2e-armed-fault";

export const EmulatorRetryRecords = Context.Reference<{ readonly directory?: string }>(
  "e2e/EmulatorRetryRecords",
  { defaultValue: () => ({}) },
);

export const EmulatorRetryPolicy = Context.Reference<{
  readonly attempts: number;
  readonly attemptDeadlineMs: number;
  readonly spacingMs: ReadonlyArray<number>;
}>("e2e/EmulatorRetryPolicy", {
  defaultValue: () => ({ attempts: 3, attemptDeadlineMs: 10_000, spacingMs: [1_000, 3_000] }),
});

export const repeatability = (
  service: string | undefined,
  method: string,
  path: string,
  payload: unknown,
): "repeat" | "read back" | "once" => {
  const route = path.split("?")[0] ?? "";
  if (route.startsWith("/_emulate/")) {
    if (method === "GET")
      return ["/_emulate/ledger", "/_emulate/faults", "/_emulate/manifest"].includes(route)
        ? "repeat"
        : "once";
    if (method === "DELETE" && clearsOneFault(route)) return "repeat";
    if (method !== "POST") return "once";
    if (["/_emulate/instances", "/_emulate/credentials", "/_emulate/reset"].includes(route))
      return "repeat";
    if (route !== "/_emulate/seed") return "once";
    if (["google", "github", "context", "autumn"].includes(service ?? "")) return "repeat";
    if (service !== "workos") return "once";
    const organizations =
      typeof payload === "object" && payload !== null && "organizations" in payload;
    return organizations ? "read back" : "repeat";
  }
  if (method === "GET") return "repeat";
  if (
    method === "POST" &&
    service === "autumn" &&
    ["/v1/customers.get", "/v1/billing.verify", "/v1/plans.list"].includes(route)
  )
    return "repeat";
  return "once";
};

const retryable = (error: EmulatorFailed, method: string) => {
  if (error.armed === true) return false;
  if (error.status !== undefined) return error.status >= 500;
  const failure = error.failure;
  if (failure === undefined) return false;
  if (failure.stage === "timeout") return true;
  const lost = failure.connection === "reset" || failure.connection === "closed";
  if (failure.stage === "reading body") return method === "GET" && lost;
  return failure.stage === "before response" && (failure.connection === "connect" || lost);
};

const afterAttempts = (failures: ReadonlyArray<EmulatorFailed>, elapsedMs: number) => {
  const last = failures.at(-1)!;
  return new EmulatorFailed({
    operation: last.operation,
    ...(last.emulator !== undefined && { emulator: last.emulator }),
    ...(last.status !== undefined && { status: last.status }),
    ...(last.reason !== undefined && { reason: last.reason }),
    ...(last.ray !== undefined && { ray: last.ray }),
    ...(last.report !== undefined && { report: last.report }),
    ...(last.failure !== undefined && { failure: last.failure }),
    earlier: failures.slice(0, -1).map((failure) => failure.attemptText),
    elapsedMs,
  });
};

const recordRetry = (record: EmulatorRetry) =>
  Effect.gen(function* () {
    const configured = yield* EmulatorRetryRecords;
    const target = Option.getOrUndefined(yield* Effect.serviceOption(Target));
    const directory =
      configured.directory ?? target?.evidenceDirectory ?? target?.directory ?? undefined;
    const scenario = configured.directory === undefined ? target?.scenarioLabel : undefined;
    const saved: EmulatorRetry = { ...(scenario === undefined ? {} : { scenario }), ...record };
    yield* Console.error(
      `Hosted emulator call needed ${record.attempts} attempts (${record.outcome}): ${record.operation}${record.emulator === undefined ? "" : ` on ${record.emulator}`}; ${record.failures.join("; ")}`,
    );
    const fs = Option.getOrUndefined(yield* Effect.serviceOption(FileSystem.FileSystem));
    if (directory === undefined || fs === undefined) return;
    const folder = `${directory}/${emulatorRetryDirectory}`;
    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.writeFileString(
      `${folder}/${yield* Clock.currentTimeMillis}-${randomUUID().slice(0, 8)}.json`,
      JSON.stringify(saved, null, 2),
      { mode: 0o600 },
    );
  }).pipe(Effect.catchCause(() => Console.error("Could not record a retried emulator call.")));

const armedFaults = new Set<string>();
const clearsOneFault = (route: string) => /^\/_emulate\/faults\/fault_\d+$/u.test(route);
const armedSafe = (method: string, route: string) =>
  route.startsWith("/_emulate/") &&
  (method === "GET" || (method === "DELETE" && clearsOneFault(route)));

export const emulatorRequest = (
  origin: string,
  path: string,
  payload?: unknown,
  token?: string,
  verb?: "PUT" | "DELETE",
  options?: { readonly applied?: Effect.Effect<boolean, EmulatorFailed> },
) => {
  const method = verb ?? (payload === undefined ? "GET" : "POST");
  const operation = `${method} ${path.split("?")[0]}`;
  const target = emulatorTarget(origin);
  const emulator = target?.label;
  const attempt = (deadline: Duration.Input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        let request = HttpClientRequest.make(method)(`${origin}${path}`);
        if (token !== undefined)
          request = HttpClientRequest.setHeader(request, "authorization", `Bearer ${token}`);
        if (payload !== undefined) request = yield* HttpClientRequest.bodyJson(request, payload);
        const { response, text, started } = yield* readResponse(
          withoutEmulatorTracing(http.execute(request)),
          deadline,
        );
        if (response.status < 200 || response.status >= 300)
          return yield* new EmulatorFailed({
            operation,
            emulator,
            status: response.status,
            ray: Option.getOrUndefined(decodeRay(response.headers["cf-ray"])),
            report: reportOf(text, { target, method, path }),
            ...(response.headers[armedFaultHeader] !== undefined && { armed: true }),
          });
        return yield* parseJson(text, response.status, started, response.headers);
      }),
    ).pipe(
      Effect.mapError((error) =>
        error instanceof EmulatorFailed
          ? error
          : error instanceof CallFailed
            ? new EmulatorFailed({
                operation,
                emulator,
                ...(error.failure.status !== undefined &&
                  (error.failure.status < 200 || error.failure.status >= 300) && {
                    status: error.failure.status,
                  }),
                reason: error.failure.stage === "timeout" ? "timeout" : "request",
                failure: error.failure,
              })
            : new EmulatorFailed({ operation, emulator, reason: "request" }),
      ),
    );
  const repeat = repeatability(target?.service, method, path, payload);
  const applied = options?.applied;
  const route = path.split("?")[0];
  const track = <A>(value: A) => {
    if (method === "POST" && route === "/_emulate/faults") armedFaults.add(origin);
    if (
      (method === "POST" && route === "/_emulate/reset") ||
      (method === "DELETE" && route === "/_emulate/faults")
    )
      armedFaults.delete(origin);
    return value;
  };
  return Effect.gen(function* () {
    const deadline = Duration.toMillis(Duration.fromInputUnsafe(yield* EmulatorDeadline));
    const policy = yield* EmulatorRetryPolicy;
    if (
      repeat === "once" ||
      (repeat === "read back" && applied === undefined) ||
      (armedFaults.has(origin) && !armedSafe(method, route ?? ""))
    )
      return track(yield* attempt(deadline));
    const started = yield* Clock.currentTimeMillis;
    const elapsed = Clock.currentTimeMillis.pipe(Effect.map((now) => now - started));
    const failures: Array<EmulatorFailed> = [];
    const record = (outcome: EmulatorRetry["outcome"], attempts: number) =>
      elapsed.pipe(
        Effect.flatMap((elapsedMs) =>
          recordRetry({
            operation,
            ...(emulator === undefined ? {} : { emulator }),
            failures: failures.map((failure) => failure.attemptText),
            outcome,
            attempts,
            elapsedMs,
          }),
        ),
      );
    const giveUp = Effect.gen(function* () {
      if (failures.length === 1) return yield* failures[0]!;
      yield* record("failed", failures.length);
      return yield* afterAttempts(failures, yield* elapsed);
    });
    while (true) {
      const remaining = deadline - (yield* elapsed);
      if (failures.length > 0 && remaining <= 0) return yield* giveUp;
      const exit = yield* Effect.exit(attempt(Math.min(policy.attemptDeadlineMs, remaining)));
      if (Exit.isSuccess(exit)) {
        if (failures.length > 0) yield* record("answered", failures.length + 1);
        return exit.value;
      }
      const error = Option.getOrUndefined(Exit.findErrorOption(exit));
      if (error === undefined) return yield* exit;
      failures.push(error);
      const spacing = policy.spacingMs[failures.length - 1];
      if (
        !retryable(error, method) ||
        spacing === undefined ||
        failures.length >= policy.attempts ||
        (yield* elapsed) + spacing >= deadline
      )
        return yield* giveUp;
      yield* Effect.sleep(spacing);
      if (repeat === "read back" && applied !== undefined) {
        const left = deadline - (yield* elapsed);
        if (left <= 0) return yield* giveUp;
        const found = yield* Effect.exit(
          applied.pipe(Effect.provideService(EmulatorDeadline, left), Effect.timeoutOption(left)),
        );
        if (Exit.isSuccess(found) && Option.getOrUndefined(found.value) === true) {
          yield* record("found applied", failures.length);
          return null;
        }
        if (Exit.isFailure(found) || Option.isNone(found.value)) return yield* giveUp;
      }
    }
  });
};

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
              Schema.Struct({
                credential: Schema.Struct({ token: heldValue(Schema.NonEmptyString) }),
              }),
            ),
          ),
        );
        return { baseUrl: instance.providerBaseUrl, token: issued.credential.token };
      });
    return secret(
      EmulatorFixture.make({
        version: 4,
        origin,
        services: {
          google,
          github,
          mail: yield* keyed("resend"),
          company: yield* keyed("context"),
          billing: yield* keyed("autumn", `am_sk_test_${randomUUID().replaceAll("-", "")}`),
          workos: yield* keyed("workos"),
        },
      }),
    );
  }).pipe(
    Effect.mapError((error) =>
      error instanceof EmulatorFailed
        ? error
        : new EmulatorFailed({ operation: "Create emulator fixture", reason: "invalid response" }),
    ),
  );

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* Target;
  const http = yield* HttpClient.HttpClient;
  const request = (...args: Parameters<typeof emulatorRequest>) =>
    emulatorRequest(...args).pipe(Effect.provideService(HttpClient.HttpClient, http));
  const file = yield* Config.String("E2E_EMULATORS");
  const fixture = yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(EmulatorFixture))),
    Effect.map(secret),
    Effect.mapError(() => new EmulatorFailed({ operation: "Read E2E_EMULATORS fixture" })),
  );
  const value = reveal(fixture);
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
  const v1Workspace = (emails: readonly [string, ...string[]]) =>
    Effect.gen(function* () {
      const name = `V1 ${randomUUID().slice(0, 8)}`;
      const workos = value.services.workos;
      const seeded = Effect.gen(function* () {
        const users = yield* request(
          workos.baseUrl,
          `/user_management/users?email=${encodeURIComponent(emails[0])}`,
          undefined,
          workos.token,
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(V1Users)));
        const user = users.data[0];
        if (user === undefined) return undefined;
        const memberships = yield* request(
          workos.baseUrl,
          `/user_management/organization_memberships?user_id=${encodeURIComponent(user.id)}&limit=100`,
          undefined,
          workos.token,
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(V1Memberships)));
        const membership = memberships.data.find((item) => item.organization_name === name);
        return membership === undefined ? undefined : { user, membership };
      }).pipe(
        Effect.mapError((error) =>
          error instanceof EmulatorFailed
            ? error
            : new EmulatorFailed({
                operation: "Read the seeded v1 member",
                reason: "invalid response",
              }),
        ),
      );
      yield* request(
        workos.baseUrl,
        "/_emulate/seed",
        {
          users: emails.map((email) => ({ email, first_name: "Synthetic", last_name: "Member" })),
          organizations: [{ name, members: emails }],
        },
        undefined,
        undefined,
        { applied: seeded.pipe(Effect.map((found) => found !== undefined)) },
      );
      const found = yield* seeded;
      if (found === undefined)
        return yield* new EmulatorFailed({ operation: "Read the seeded v1 organization" });
      return { organization: found.membership.organization_id, user: found.user.id, name };
    }).pipe(
      Effect.mapError((error) =>
        error instanceof EmulatorFailed
          ? error
          : new EmulatorFailed({ operation: "Seed a v1 member", reason: "invalid response" }),
      ),
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
    googleUser: (user: {
      readonly email: string;
      readonly name: string;
      readonly picture: string;
    }) =>
      request(value.services.google.baseUrl, "/_emulate/seed", {
        users: [{ ...user, email_verified: true }],
      }).pipe(Effect.asVoid),
    v1Workspace,
    failAutumnReads: (
      route: "customers.get" | "plans.list" | "billing.attach",
      fault: { status: number; times: number; delayMs?: number },
    ) =>
      request(
        value.services.billing.baseUrl,
        "/_emulate/faults",
        {
          match: { method: "POST", pathPattern: `/v1/${route}` },
          response: {
            status: fault.status,
            body: { code: "synthetic_outage" },
            headers: { [armedFaultHeader]: "1" },
          },
          times: fault.times,
          ...(fault.delayMs === undefined ? {} : { delayMs: fault.delayMs }),
        },
        value.services.billing.token,
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ fault: Schema.Struct({ id: Schema.String }) }),
          ),
        ),
        Effect.map((armed) => armed.fault.id),
      ),
    autumnFaults: request(
      value.services.billing.baseUrl,
      "/_emulate/faults",
      undefined,
      value.services.billing.token,
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            faults: Schema.Array(Schema.Struct({ id: Schema.String, remaining: Schema.Number })),
          }),
        ),
      ),
      Effect.map(({ faults }) => new Map(faults.map((fault) => [fault.id, fault.remaining]))),
    ),
    v1ApiKey: (user: string, organization: string) =>
      request(
        value.services.workos.baseUrl,
        `/user_management/users/${encodeURIComponent(user)}/api_keys`,
        { organization_id: organization, name: `Synthetic key ${randomUUID().slice(0, 6)}` },
        value.services.workos.token,
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ id: Schema.String, value: heldValue(Schema.NonEmptyString) }),
          ),
        ),
        Effect.mapError((error) =>
          error instanceof EmulatorFailed
            ? error
            : new EmulatorFailed({ operation: "Create a v1 API key", reason: "invalid response" }),
        ),
      ),
    failV1KeyValidations: (fault: { status: number; times: number }) =>
      request(
        value.services.workos.baseUrl,
        "/_emulate/faults",
        {
          match: { method: "POST", pathPattern: "/api_keys/validations" },
          response: {
            status: fault.status,
            body: { code: "synthetic_outage" },
            headers: { [armedFaultHeader]: "1" },
          },
          times: fault.times,
        },
        value.services.workos.token,
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ fault: Schema.Struct({ id: Schema.String }) }),
          ),
        ),
        Effect.map((armed) => armed.fault.id),
      ),
    workosFaults: request(
      value.services.workos.baseUrl,
      "/_emulate/faults",
      undefined,
      value.services.workos.token,
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            faults: Schema.Array(Schema.Struct({ id: Schema.String, remaining: Schema.Number })),
          }),
        ),
      ),
      Effect.map(({ faults }) => new Map(faults.map((fault) => [fault.id, fault.remaining]))),
    ),
    clearWorkosFault: (id: string) =>
      request(
        value.services.workos.baseUrl,
        `/_emulate/faults/${encodeURIComponent(id)}`,
        undefined,
        value.services.workos.token,
        "DELETE",
      ).pipe(Effect.asVoid),
    clearAutumnFault: (id: string) =>
      request(
        value.services.billing.baseUrl,
        `/_emulate/faults/${encodeURIComponent(id)}`,
        undefined,
        value.services.billing.token,
        "DELETE",
      ).pipe(Effect.asVoid),
    received: (email: string) =>
      messages(email).pipe(Effect.map((rows) => rows.map((row) => row.id))),
    mail: (email: string, previouslyReceived: ReadonlyArray<string>) =>
      messages(email).pipe(
        Effect.flatMap((data) => {
          const coded = data.flatMap((item) => {
            const code = previouslyReceived.includes(item.id)
              ? undefined
              : item.text?.match(/\b\d{6}\b/)?.[0];
            return code === undefined ? [] : [{ code, subject: item.subject }];
          });
          const message = coded.at(-1);
          return message !== undefined
            ? Effect.succeed({ code: secret(message.code), subject: message.subject })
            : Effect.fail(new MailPending());
        }),
        Effect.retry({
          while: (error) => error instanceof MailPending,
          schedule: Schedule.spaced("250 millis"),
          times: 80,
        }),
        Effect.catchTag("MailPending", () =>
          Effect.fail(
            new EmulatorFailed({ operation: "Read delivered email code (none within 20 s)" }),
          ),
        ),
      ),
  };
});

export class Emulators extends Context.Service<Emulators, Effect.Success<typeof make>>()(
  "e2e/Emulators",
) {
  static readonly layer = Layer.effect(Emulators, make);
}
