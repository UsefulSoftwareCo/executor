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

/** The fields of v1 WorkOS listings that seeding reads back. */
const V1Users = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });

/** An Autumn customer as `customers.get` returns it with `subscriptions.plan` expanded. */
const AutumnCustomer = Schema.Struct({
  id: Schema.String,
  subscriptions: Schema.Array(
    Schema.Struct({
      plan_id: Schema.String,
      status: Schema.String,
      current_period_end: Schema.NullOr(Schema.Number),
      trial_ends_at: Schema.NullOr(Schema.Number),
      canceled_at: Schema.NullOr(Schema.Number),
      expires_at: Schema.NullOr(Schema.Number),
      plan: Schema.optionalKey(
        Schema.Struct({
          id: Schema.String,
          version: Schema.Number,
          price: Schema.NullOr(Schema.Struct({ amount: Schema.Number, interval: Schema.String })),
          items: Schema.Array(
            Schema.Struct({ feature_id: Schema.String, unlimited: Schema.Boolean }),
          ),
        }),
      ),
    }),
  ),
  balances: Schema.Record(
    Schema.String,
    Schema.Struct({ usage: Schema.Number, unlimited: Schema.Boolean }),
  ),
});
export type AutumnCustomer = typeof AutumnCustomer.Type;

const DAY_MS = 86_400_000;
const V1Organization = Schema.Struct({ metadata: Schema.Record(Schema.String, Schema.String) });
const V1Memberships = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ organization_id: Schema.String, organization_name: Schema.String }),
  ),
});
const V1OrganizationMemberships = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, user_id: Schema.String })),
});

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
  /** How far a call that got no usable response went: see `request-failure.ts`. */
  failure: Schema.optional(RequestFailure),
  /** The answer came from a fault the harness armed itself (`armedFaultHeader`). */
  armed: Schema.optional(Schema.Boolean),
  /**
   * When the call was sent more than once: each earlier attempt's failure, in order. The other
   * fields describe the last attempt.
   */
  earlier: Schema.optional(Schema.Array(Schema.String)),
  /** When the call was sent more than once: the time from the first attempt to the last failure. */
  elapsedMs: Schema.optional(Schema.Number),
}) {
  /** This attempt's failure on its own, as a retry record and the attempt list name it. */
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

  /** emulators.dev's own report of the last attempt, reduced to its diagnostic fields. */
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

/** How long one emulator call may take. Only a spec of the harness itself sets another. */
export const EmulatorDeadline = Context.Reference<Duration.Input>("e2e/EmulatorDeadline", {
  defaultValue: () => "30 seconds",
});

/**
 * A response header on every fault the harness arms. A failure answered by one is the scenario's
 * own deliberate outage, never retried: a retry would consume another of its faults.
 */
export const armedFaultHeader = "x-executor-e2e-armed-fault";

/**
 * Where a call that needed a retry is recorded. Inside a scenario the record goes to its run's
 * evidence (`Target`); a run's own set-up, which has no `Target`, names its directory here.
 */
export const EmulatorRetryRecords = Context.Reference<{ readonly directory?: string }>(
  "e2e/EmulatorRetryRecords",
  { defaultValue: () => ({}) },
);

/**
 * The retry policy, from the emulator failures CI saw on 10-13 November 2026: every one was a
 * single call, and the same service answered the job's next call to it 0-6 s later. A hosted call
 * normally answers in well under 2 s (Worker p99 about 1.4 s). So: at most three attempts, each
 * within 10 s, 1 s and then 3 s apart, all within the call's deadline (`EmulatorDeadline`, 30 s),
 * which therefore still bounds the call as it did with one attempt.
 */
export const EmulatorRetryPolicy = Context.Reference<{
  readonly attempts: number;
  readonly attemptDeadlineMs: number;
  readonly spacingMs: ReadonlyArray<number>;
}>("e2e/EmulatorRetryPolicy", {
  // Only a spec of the harness itself sets another, to keep its cases short.
  defaultValue: () => ({ attempts: 3, attemptDeadlineMs: 10_000, spacingMs: [1_000, 3_000] }),
});

/**
 * Whether a harness call may be sent again, judged by what a second copy would do to the state a
 * scenario observes (emulate's own handlers, `packages/@emulators/*`):
 *
 * - `repeat`: sending it twice leaves what the first would have. Control-plane reads (ledger,
 *   faults list, manifest), resets, a new instance (the unused first one has a random name and is
 *   never addressed), a credential (the harness uses the one it receives; an api-key with the
 *   harness's own token is the same key again), and the seeds that match existing records by
 *   email, login, domain or customer id (Google, GitHub, Context, Autumn; WorkOS users). Reads of
 *   what an emulator recorded: any GET, and Autumn's reads that are POSTs.
 * - `read back`: a WorkOS seed with organizations inserts a new organization each time, so a
 *   second copy would make the member belong to two. It is sent again only when the caller's read
 *   back shows the first copy did not apply.
 * - `once`: everything else. Arming a fault (a second copy fails one more call), clearing one or
 *   the ledger, the seeds of services not checked here, and every provider write the harness makes
 *   to set a scenario up (WorkOS Vault, invitations, organization and membership changes, Autumn
 *   balances).
 *
 * Product calls never pass through here: the product calls its providers itself, and how it
 * behaves when one fails is what scenarios test.
 */
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

/**
 * Retried only when the service failed to answer: a 5xx that is not a fault the harness armed, a
 * refused, reset or closed connection with no response, or no answer within the attempt's deadline.
 * Never a 4xx, a body that is not JSON, or a failed name lookup or TLS handshake.
 */
const retryable = (error: EmulatorFailed) => {
  if (error.armed === true) return false;
  if (error.status !== undefined) return error.status >= 500;
  const failure = error.failure;
  if (failure === undefined) return false;
  if (failure.stage === "timeout") return true;
  return (
    failure.stage === "before response" &&
    (failure.connection === "connect" ||
      failure.connection === "reset" ||
      failure.connection === "closed")
  );
};

/** The last attempt's failure, listing every earlier one. */
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

/**
 * Save a retried call to the run's evidence and say so in the job log. A call outside any
 * scenario or run (a spec of the harness itself) is only logged.
 */
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
  }).pipe(
    // Recording never decides a call's outcome.
    Effect.catchCause(() => Console.error("Could not record a retried emulator call.")),
  );

/**
 * The emulator origins on which this process's harness armed a fault that may still be live:
 * added when arming succeeds, removed when a reset or clearing every fault does. Calls to them
 * are sent once (see `emulatorRequest`).
 */
const armedFaults = new Set<string>();

/**
 * Calls only an external emulator. Failures never carry a provider URL, credential, response
 * body or underlying error: the instance URL is the only access control for its emulator, and a
 * body can quote tokens, sign-in codes and addresses. Client tracing is off for these requests,
 * because its span records the full URL as `url.full` and `server.address`.
 *
 * A call `repeatability` allows is sent again when the service failed to answer, under
 * `EmulatorRetryPolicy`; each such call is recorded (`e2e/emulator-retries.ts`). When the attempts
 * run out it fails as one call did, with every attempt listed. A `read back` call needs `applied`,
 * which says whether an earlier copy took effect; without it the call is sent once. Attempts and
 * the read back share the call's one deadline. While the harness has a fault armed on an emulator,
 * every call to it is sent once.
 */
export const emulatorRequest = (
  origin: string,
  path: string,
  payload?: unknown,
  token?: string,
  /** Defaults to GET without a payload and POST with one. */
  verb?: "PUT" | "DELETE",
  options?: { readonly applied?: Effect.Effect<boolean, EmulatorFailed> },
) => {
  const method = verb ?? (payload === undefined ? "GET" : "POST");
  // The query can name addresses and IDs; the operation keeps the path only.
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
                // A refusal whose body could not be read still answers callers that match on it.
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
  /** Keeps `armedFaults` in step with what this call armed or cleared, once it succeeded. */
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
      // A fault the harness armed here may still be waiting, delayed, for the product's call: a
      // retried harness call could meet it before its marked answer arrives and consume it.
      armedFaults.has(origin)
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
    /** Give up with every attempt listed: the attempts ran out, or the deadline did. */
    const giveUp = Effect.gen(function* () {
      if (failures.length === 1) return yield* failures[0]!;
      yield* record("failed", failures.length);
      return yield* afterAttempts(failures, yield* elapsed);
    });
    while (true) {
      const remaining = deadline - (yield* elapsed);
      // Never send an attempt with no time left: it would report a time-out it never had.
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
        !retryable(error) ||
        spacing === undefined ||
        failures.length >= policy.attempts ||
        (yield* elapsed) + spacing >= deadline
      )
        return yield* giveUp;
      yield* Effect.sleep(spacing);
      // A copy that may have applied is sent again only when reading back shows it did not. The
      // read back gets only what is left of this call's deadline.
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
        // Unknown whether the first copy applied, so it is not sent again.
        if (Exit.isFailure(found) || Option.isNone(found.value)) return yield* giveUp;
      }
    }
  });
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
  const v1Workspace = (emails: readonly [string, ...string[]]) =>
    Effect.gen(function* () {
      const name = `V1 ${randomUUID().slice(0, 8)}`;
      const workos = value.services.workos;
      /** The first member and the new organization's membership, once the seed has applied. */
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
      // Each copy of this seed inserts another organization of the same name, so it is sent
      // again only when the new organization is not there.
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
    /** Seed a Google profile for an address that may already have an Executor account. */
    googleUser: (user: {
      readonly email: string;
      readonly name: string;
      readonly picture: string;
    }) =>
      request(value.services.google.baseUrl, "/_emulate/seed", {
        users: [{ ...user, email_verified: true }],
      }).pipe(Effect.asVoid),
    /**
     * Make an email an active member of a new organization in the emulated v1 WorkOS, and return
     * that organization's WorkOS id. The organization starts empty and unbilled.
     */
    v1Member: (email: string) =>
      v1Workspace([email]).pipe(Effect.map((created) => created.organization)),
    /**
     * A new organization in the emulated v1 WorkOS whose active members are these emails, and the
     * first member's WorkOS user id, which v1 rows use as `subject`.
     */
    v1Workspace,
    /** A v1 organization's WorkOS metadata, as the emulated v1 WorkOS returns it. */
    v1OrganizationMetadata: (organization: string) =>
      request(
        value.services.workos.baseUrl,
        `/organizations/${encodeURIComponent(organization)}`,
        undefined,
        value.services.workos.token,
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(V1Organization)),
        Effect.map((found) => found.metadata),
        Effect.mapError((error) =>
          error instanceof EmulatorFailed
            ? error
            : new EmulatorFailed({
                operation: "Read v1 organization metadata",
                reason: "invalid response",
              }),
        ),
      ),
    /** Set keys of a v1 organization's WorkOS metadata, as v1 might have before an import. */
    setV1OrganizationMetadata: (organization: string, metadata: Record<string, string>) =>
      request(
        value.services.workos.baseUrl,
        `/organizations/${encodeURIComponent(organization)}`,
        { metadata },
        value.services.workos.token,
        "PUT",
      ).pipe(Effect.asVoid),
    /** Store a value in the emulated v1 WorkOS Vault under v1's object name. */
    v1VaultObject: (name: string, secret: string) =>
      request(
        value.services.workos.baseUrl,
        "/vault/v1/kv",
        { name, value: secret, key_context: { app: "executor" } },
        value.services.workos.token,
      ).pipe(Effect.asVoid),
    /** A v1 user's WorkOS id, which v1 rows use as `subject`. */
    v1User: (email: string) =>
      request(
        value.services.workos.baseUrl,
        `/user_management/users?email=${encodeURIComponent(email)}`,
        undefined,
        value.services.workos.token,
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(V1Users)),
        Effect.flatMap((users) =>
          users.data[0] === undefined
            ? Effect.fail(new EmulatorFailed({ operation: "Read a v1 user" }))
            : Effect.succeed(users.data[0].id),
        ),
        Effect.mapError((error) =>
          error instanceof EmulatorFailed
            ? error
            : new EmulatorFailed({ operation: "Read a v1 user", reason: "invalid response" }),
        ),
      ),
    /**
     * Invite an existing v1 user to a v1 organization, as a v1 admin does. Until they accept,
     * WorkOS lists their membership as pending.
     */
    inviteV1Member: (organization: string, email: string) =>
      request(
        value.services.workos.baseUrl,
        "/user_management/invitations",
        { email, organization_id: organization },
        value.services.workos.token,
      ).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          error instanceof EmulatorFailed
            ? error
            : new EmulatorFailed({ operation: "Invite a v1 member", reason: "invalid response" }),
        ),
      ),
    /** Give a v1 member a WorkOS role, as a v1 admin does. Seeded members start as admins. */
    setV1MemberRole: (organization: string, user: string, role: "admin" | "member") =>
      Effect.gen(function* () {
        const memberships = yield* request(
          value.services.workos.baseUrl,
          `/user_management/organization_memberships?organization_id=${encodeURIComponent(organization)}&limit=100`,
          undefined,
          value.services.workos.token,
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(V1OrganizationMemberships)));
        const membership = memberships.data.find((item) => item.user_id === user);
        if (membership === undefined)
          return yield* new EmulatorFailed({ operation: "Find a v1 membership" });
        yield* request(
          value.services.workos.baseUrl,
          `/user_management/organization_memberships/${encodeURIComponent(membership.id)}`,
          { role_slug: role },
          value.services.workos.token,
          "PUT",
        );
      }).pipe(
        Effect.mapError((error) =>
          error instanceof EmulatorFailed
            ? error
            : new EmulatorFailed({ operation: "Set a v1 role", reason: "invalid response" }),
        ),
      ),
    /** Bill a v1 organization on a v1 plan, as v1 does: the Autumn customer id is its WorkOS id. */
    v1Plan: (organizationId: string, planId: "free" | "team" | "enterprise" | "hobby") =>
      request(
        value.services.billing.baseUrl,
        "/_emulate/seed",
        {
          customers: [
            { id: organizationId, subscriptions: [{ plan_id: planId, status: "active" }] },
          ],
        },
        value.services.billing.token,
      ).pipe(Effect.asVoid),
    /**
     * Bill a v1 organization on v1's Team plan, as v1 does, on its own Stripe subscription.
     * Version 3 bills USD 15 per member, with `seats` set as v1 sets them; version 1 bills a flat
     * USD 49 a month with executions metered on top. The period ends `periodDays` from now; a
     * trial ends with it; a cancelled subscription expires with it, v1's free plan scheduled after.
     * Returns the Stripe subscription id and the period end.
     */
    v1TeamSubscription: (
      organizationId: string,
      subscription: {
        readonly version: 1 | 3;
        readonly seats?: number;
        readonly trialing?: boolean;
        readonly cancelled?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const billing = value.services.billing;
        // Stripe keeps whole seconds.
        const periodEnd = Math.floor((Date.now() + 20 * DAY_MS) / 1000) * 1000;
        const stripeSubscription = `sub_v1_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const seat = {
          feature_id: "members",
          included: 0,
          price: { amount: 15, interval: "month", billing_units: 1, billing_method: "usage_based" },
        };
        const executions = {
          feature_id: "executions",
          included: 250000,
          reset: { interval: "month" },
          price: {
            amount: 0.2,
            interval: "month",
            billing_units: 1000,
            billing_method: "usage_based",
          },
        };
        yield* request(
          billing.baseUrl,
          "/_emulate/seed",
          {
            features: [
              { id: "members", name: "Members", type: "metered", consumable: false },
              { id: "executions", name: "Executions", type: "metered", consumable: true },
            ],
            plans: [
              {
                id: "team",
                name: "Team",
                version: 3,
                items: [seat],
                versions: [
                  { version: 1, price: { amount: 49, interval: "month" }, items: [executions] },
                ],
              },
            ],
            customers: [
              {
                id: organizationId,
                subscriptions: [
                  {
                    plan_id: "team",
                    status: subscription.trialing === true ? "trialing" : "active",
                    version: subscription.version,
                    current_period_start: periodEnd - 30 * DAY_MS,
                    current_period_end: periodEnd,
                    trial_ends_at: subscription.trialing === true ? periodEnd : null,
                    canceled_at: subscription.cancelled === true ? Date.now() : null,
                    expires_at: subscription.cancelled === true ? periodEnd : null,
                    stripe_subscription_id: stripeSubscription,
                  },
                  ...(subscription.cancelled === true
                    ? [{ plan_id: "free", status: "scheduled" }]
                    : []),
                ],
              },
            ],
          },
          billing.token,
        );
        if (subscription.seats !== undefined)
          yield* request(
            billing.baseUrl,
            "/v1/balances.update",
            { customer_id: organizationId, feature_id: "members", usage: subscription.seats },
            billing.token,
          );
        return { stripeSubscription, periodEnd };
      }),
    /** An Autumn customer with each subscription's plan version, or null when there is none. */
    autumnCustomer: (customerId: string) =>
      request(
        value.services.billing.baseUrl,
        "/v1/customers.get",
        { customer_id: customerId, expand: ["subscriptions.plan"] },
        value.services.billing.token,
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AutumnCustomer)),
        Effect.map((customer): AutumnCustomer | null => customer),
        Effect.catchTag("EmulatorFailed", (error) =>
          error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
        ),
      ),
    /** The Stripe subscriptions Autumn bills a customer on (`billing.verify`). */
    autumnStripeSubscriptions: (customerId: string) =>
      request(
        value.services.billing.baseUrl,
        "/v1/billing.verify",
        { customer_id: customerId },
        value.services.billing.token,
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              subscriptions: Schema.Array(Schema.Struct({ stripe_subscription_id: Schema.String })),
            }),
          ),
        ),
        Effect.map(({ subscriptions }) => subscriptions.map((sub) => sub.stripe_subscription_id)),
      ),
    /**
     * A v2 organization's Autumn customer id: `<catalog namespace>:organization:<id>`, with this
     * Cloud's catalog namespace read from the plans it seeded.
     */
    v2BillingCustomer: (organizationId: string) =>
      request(
        value.services.billing.baseUrl,
        "/v1/plans.list",
        {},
        value.services.billing.token,
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              list: Schema.Array(
                Schema.Struct({ id: Schema.String, group: Schema.NullOr(Schema.String) }),
              ),
            }),
          ),
        ),
        Effect.flatMap(({ list }) => {
          const namespace = list.find((plan) => plan.id === `${plan.group}-team`)?.group;
          return namespace === undefined || namespace === null
            ? Effect.fail(new EmulatorFailed({ operation: "Find the billing catalog" }))
            : Effect.succeed(`${namespace}:organization:${organizationId}`);
        }),
      ),
    /**
     * Make a v1 Autumn customer as v1 does when it meters an execution for a customer Autumn does
     * not have: on v1's free plan, billing nothing.
     */
    v1MeteredCustomer: (organizationId: string) =>
      request(
        value.services.billing.baseUrl,
        "/_emulate/seed",
        {
          customers: [
            { id: organizationId, subscriptions: [{ plan_id: "free", status: "active" }] },
          ],
        },
        value.services.billing.token,
      ).pipe(Effect.asVoid),
    /**
     * Answer the next `times` requests to one Autumn route with `status`, after `delayMs`: v1's
     * plan reads (`customers.get`), billing's plan catalog (`plans.list`) or an attach
     * (`billing.attach`). Faults match every caller of the route on this Cloud's Autumn emulator,
     * so only scenarios that run in order on their own local Cloud arm them. Returns the fault's
     * id.
     */
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
    /** How many reads each armed Autumn fault still answers, by id; spent faults are absent. */
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
    /** Disarm an Autumn fault, spent or not. */
    clearAutumnFault: (id: string) =>
      request(
        value.services.billing.baseUrl,
        `/_emulate/faults/${encodeURIComponent(id)}`,
        undefined,
        value.services.billing.token,
        "DELETE",
      ).pipe(Effect.asVoid),
    /**
     * Fail the next membership read once. Only accounts seeded with `v1Member` reach that read,
     * so other scenarios sharing this emulator never consume the fault. The v1 import reads
     * memberships on every request, so its scenarios run on another local Cloud.
     */
    failNextV1MembershipRead: request(value.services.workos.baseUrl, "/_emulate/faults", {
      match: { method: "GET", pathPattern: "/user_management/organization_memberships" },
      response: {
        status: 503,
        body: { error: "temporarily_unavailable" },
        headers: { [armedFaultHeader]: "1" },
      },
    }).pipe(Effect.asVoid),
    received: (email: string) =>
      messages(email).pipe(Effect.map((rows) => rows.map((row) => row.id))),
    /**
     * The newest new code and its email subject. Mail without a code to the same address, such as
     * the welcome a new account's background provisioning sends, can arrive after it.
     */
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
