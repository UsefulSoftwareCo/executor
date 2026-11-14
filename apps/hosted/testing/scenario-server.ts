/** Local fixture control process. Database credentials stay in memory and never enter the Worker. */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Clock,
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Redacted,
  Schema,
  Semaphore,
  Option,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { provisionTestAccount, testAccountAuth, TestAccountFailed } from "./accounts.ts";
import { cloudSessionCookiePrefix } from "../cloud/src/contracts/browser.ts";

const Setup = Schema.Struct({
  origin: Schema.String,
  stage: Schema.String,
  database: Schema.RedactedFromValue(Schema.NonEmptyString),
  secret: Schema.RedactedFromValue(Schema.NonEmptyString),
  databaseName: Schema.NonEmptyString,
  databaseUsername: Schema.NonEmptyString,
});
const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));
const TransportCause = Schema.Struct({
  code: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u))),
  cause: Schema.optional(Schema.Unknown),
});
/** A socket, TLS or DNS failure's code, such as `ECONNRESET`; never its message, which can name the request. */
const transportCode = (cause: unknown, depth = 0): string | undefined => {
  if (depth > 3) return undefined;
  const parsed = Schema.decodeUnknownOption(TransportCause)(cause);
  return Option.isNone(parsed)
    ? undefined
    : (parsed.value.code ?? transportCode(parsed.value.cause, depth + 1));
};
// Preserve all 128 bits in at most 27 characters, including the prefix.
const organizationSlug = (id: string) => `s-${BigInt(`0x${id}`).toString(36)}`;
const Request = Schema.Struct({ id: Id, label: Schema.NonEmptyString });
const SessionRequest = Schema.Struct({
  id: Id,
  role: Schema.Literals(["owner", "admin", "member"]),
});
const Role = ["owner", "admin", "member"] as const;
const Removal = Schema.Array(
  Schema.Struct({
    instance_id: Schema.String,
    status: Schema.Literals(["running", "done"]),
    started_at: Schema.String,
    finished_at: Schema.NullOr(Schema.String),
  }),
);
/** Where `/remove` was when it failed: finding the organization, or getting its removal accepted. */
type RemovePhase =
  | "find-organization"
  | "start-removal"
  | "confirm-accepted"
  | "confirm-unreachable";
/** Where an accepted removal is while `/settle` waits for it. */
type SettlePhase = "wait-for-organization" | "wait-for-removal" | "remove-users";
/**
 * A clean-up step that did not complete. Its fields reach the runner in the 400's body, so they are
 * built only from this file's own phrases, error class names and error codes (`safeCause`), never
 * from an error's message, a request or a response: those can name the stage's database, its
 * connection string or the bearer token.
 */
class CleanupFailed extends Schema.TaggedError<CleanupFailed>()("CleanupFailed", {
  phase: Schema.String,
  cause: Schema.String,
}) {}
const SqlState = Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^[0-9A-Z]{5}$/u)) });
/** An unexpected error named by its class and its socket or SQLSTATE code only. */
const safeCause = (cause: unknown): string => {
  const name =
    cause instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(cause.name)
      ? cause.name
      : typeof cause === "object" && cause !== null && "_tag" in cause
        ? String((cause as { _tag: unknown })._tag).replace(/[^A-Za-z0-9]/gu, "")
        : typeof cause;
  const code =
    transportCode(cause) ??
    Option.getOrUndefined(Schema.decodeUnknownOption(SqlState)(cause))?.code;
  return code === undefined ? name : `${name} ${code}`;
};
const Settle = Schema.Struct({ ids: Schema.optional(Schema.Array(Id)) });
/**
 * Removal checks running at once. Each holds one of the pool's 6 connections (`max: 6` below) while
 * it reads the organization and the removal and deletes the scenario's users, so 6 is all the
 * parallelism the pool can serve; more would only queue inside it. The pool is the only database
 * load this process adds, and its size is unchanged: the stage's origin allows 20 connections, and
 * the API Worker's Hyperdrive pool needs the rest.
 */
const settleConcurrency = 6;
/**
 * How long one `/settle` look waits for its checks before it answers. After the wait, the status of
 * every removal still unfinished is read in one statement bounded by `statusBudgetMs`, so a look
 * answers within 10 s + 2 s = 12 s however many are unfinished, well inside the 30 s the runner
 * allows each request (`settleRequestTimeout` in e2e/sdk/removal-settlement.ts).
 */
const lookBudgetMs = 10_000;
/** The bound on a look's one read of the unfinished removals' status; past it they read as unknown. */
const statusBudgetMs = 2_000;
/** A removal `/remove` accepted, until a `/settle` look sees it finished. */
interface AcceptedRemoval {
  readonly label: string;
  readonly users: Set<string>;
  readonly organization: string | undefined;
  readonly acceptedAt: number;
  phase: SettlePhase;
  since: number;
  cause: string | undefined;
  /** The check a look started and has not seen end. */
  inFlight?: Promise<boolean> | undefined;
}
/** A finished removal: the product's own times, and when this process saw it and deleted its users. */
interface SettledRemoval {
  readonly scenario: string;
  readonly label: string;
  readonly organization: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly readyAt: string;
  readonly usersDeletedAt: string;
  readonly deletionMs: number;
}
const RemovalFailure = Schema.Struct({
  _tag: Schema.Literals([
    "AppWorkflowsActive",
    "AccountWorkflowsActive",
    "OrganizationForbidden",
    "OrganizationRemovalUnavailable",
    "StorageError",
  ]),
});

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const origin = yield* Config.NonEmptyString("TEST_FIXTURE_ORIGIN");
  // Where the dashboard and its cookie-authenticated API are served: Cloud's `app.` host.
  const browserOrigin = yield* Config.NonEmptyString("TEST_FIXTURE_BROWSER_ORIGIN");
  const token = yield* Config.Redacted("TEST_FIXTURE_TOKEN");
  const output = yield* Config.NonEmptyString("TEST_FIXTURE_OUTPUT");
  const configured = yield* Semaphore.make(1);
  let auth: ReturnType<typeof testAccountAuth> | undefined;
  let pool: Pool | undefined;
  const owned = new Map<
    string,
    {
      label: string;
      gate: Semaphore.Semaphore;
      users: Set<string>;
      organization: string | undefined;
    }
  >();
  const accepted = new Map<string, AcceptedRemoval>();
  yield* Effect.addFinalizer(() => {
    const database = pool;
    return database === undefined ? Effect.void : Effect.promise(() => database.end());
  });
  const authorize = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const actual = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${Redacted.value(token)}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return yield* new TestAccountFailed({ stage: "configuration" });
    return request;
  });
  const endpoint = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    authorize.pipe(
      Effect.andThen(operation),
      Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
      Effect.catch((error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            Schema.is(CleanupFailed)(error)
              ? { error: `${error.cause} (${error.phase})`, phase: error.phase, cause: error.cause }
              : { error: "Fixture operation failed" },
            { status: 400 },
          ),
        ),
      ),
    );
  const configure = configured.withPermits(1)(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const input = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Setup)));
      if (pool !== undefined || input.origin !== origin)
        return yield* new TestAccountFailed({ stage: "configuration" });
      const url = new URL(Redacted.value(input.database));
      const local =
        input.stage === "local" &&
        ["localhost", "127.0.0.1"].includes(new URL(origin).hostname) &&
        ["localhost", "127.0.0.1"].includes(url.hostname);
      const deployed =
        /^test-(?:e2e|perf)-[a-z0-9-]+$/.test(input.stage) &&
        origin === `https://${input.stage.slice(5)}.executor.engineering` &&
        url.searchParams.get("sslmode") === "verify-full";
      if (
        (!local && !deployed) ||
        decodeURIComponent(url.pathname.slice(1)) !== input.databaseName ||
        decodeURIComponent(url.username) !== input.databaseUsername
      )
        return yield* new TestAccountFailed({ stage: "configuration" });
      const database = new Pool({ connectionString: Redacted.value(input.database), max: 6 });
      pool = database;
      const current = yield* Effect.tryPromise({
        try: () => database.query("select current_database() as name"),
        catch: () => new TestAccountFailed({ stage: "database" }),
      });
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ name: Schema.String })),
      )(current.rows);
      if (rows[0]?.name !== input.databaseName)
        return yield* new TestAccountFailed({ stage: "database" });
      auth = testAccountAuth({
        origin,
        secret: input.secret,
        database,
        cookiePrefix: cloudSessionCookiePrefix(origin),
      });
      return { ready: true };
    }),
  );
  const actor = (id: string, role: (typeof Role)[number]) =>
    Effect.gen(function* () {
      const current = auth;
      const scenario = owned.get(id);
      if (current === undefined || scenario === undefined)
        return yield* new TestAccountFailed({ stage: "configuration" });
      const session = yield* provisionTestAccount(current, {
        host: "cloud",
        origin,
        organization: organizationSlug(id),
        name: `${id}-${role}`,
        role,
        displayName: `${scenario.label} ${role}`,
      });
      const value = Redacted.value(session);
      scenario.users.add(value.userId);
      scenario.organization = value.organizationId;
      return value;
    });
  const provision = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const input = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Request)));
    let scenario = owned.get(input.id);
    if (scenario === undefined) {
      scenario = {
        label: input.label,
        gate: yield* Semaphore.make(1),
        users: new Set<string>(),
        organization: undefined,
      };
      owned.set(input.id, scenario);
    }
    if (scenario.label !== input.label) return yield* new TestAccountFailed({ stage: "fixture" });
    return yield* scenario.gate.withPermits(1)(
      Effect.gen(function* () {
        const owner = yield* actor(input.id, "owner");
        const [admin, member] = yield* Effect.all(
          [actor(input.id, "admin"), actor(input.id, "member")],
          { concurrency: 2 },
        );
        return {
          id: input.id,
          origin,
          organization: { id: owner.organizationId, slug: owner.organizationSlug },
          actors: { owner, admin, member },
        };
      }),
    );
  });
  const session = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const input = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SessionRequest)),
    );
    const scenario = owned.get(input.id);
    if (scenario === undefined) return yield* new TestAccountFailed({ stage: "fixture" });
    return yield* scenario.gate.withPermits(1)(actor(input.id, input.role));
  });
  // Only this process's synthetic owner can receive platform authority.
  const operator = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { id } = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Id }))),
    );
    const scenario = owned.get(id),
      current = auth;
    if (scenario === undefined || current === undefined)
      return yield* new TestAccountFailed({ stage: "fixture" });
    return yield* scenario.gate.withPermits(1)(
      Effect.gen(function* () {
        const value = yield* actor(id, "owner");
        yield* Effect.tryPromise({
          try: async () => {
            const ctx = await current.$context;
            await ctx.adapter.update({
              model: "user",
              where: [{ field: "id", value: value.userId }],
              update: { role: "admin" },
            });
          },
          catch: () => new TestAccountFailed({ stage: "fixture" }),
        });
        return { ready: true };
      }),
    );
  });
  /**
   * The app domain status the product's location read reports for this scenario's team: the row
   * the coordinator wrote for its current slug, or `absent` before a pass has written one.
   */
  const domain = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { id } = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Id }))),
    );
    const database = pool;
    if (!owned.has(id) || database === undefined)
      return yield* new TestAccountFailed({ stage: "fixture" });
    const result = yield* Effect.tryPromise({
      try: () =>
        database.query(
          // Read through the row's JSON so a stage whose schema predates the coordinator's
          // certificate columns answers with its status alone instead of failing.
          `select domain.status, to_jsonb(domain) ->> 'certificate' as certificate,
              to_jsonb(domain) ->> 'status_since' as status_since
            from cloud_app_domain domain
            join organization on organization.id = domain.organization_id
            where organization.slug = $1 and domain.slug = organization.slug`,
          [organizationSlug(id)],
        ),
      catch: () => new TestAccountFailed({ stage: "database" }),
    });
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          status: Schema.Literals(["pending", "ready", "failed"]),
          certificate: Schema.NullOr(Schema.String),
          status_since: Schema.NullOr(Schema.String),
        }),
      ),
    )(result.rows);
    const row = rows[0];
    // The certificate's label and when the coordinator's status last changed, for a failure
    // to say what the origin was waiting on; a test stage's own records, never exported. Both are
    // absent where the stage does not record them.
    const since = row?.status_since == null ? Number.NaN : Date.parse(row.status_since);
    return {
      status: row?.status ?? ("absent" as const),
      ...(row?.certificate == null ? {} : { certificate: row.certificate }),
      ...(Number.isNaN(since) ? {} : { since: new Date(since).toISOString() }),
    };
  });
  /** The removal this process accepted for a scenario, until the end-of-run check confirms it. */
  const removalRecord = async (database: Pool, organization: string) =>
    Schema.decodeUnknownSync(Removal)(
      (
        await database.query(
          `select instance_id, status, to_json(started_at) #>> '{}' as started_at,
              to_json(finished_at) #>> '{}' as finished_at
            from hosted_organization_removal where organization_id = $1`,
          [organization],
        )
      ).rows,
    )[0];
  /**
   * End a scenario's organization the way its owner would, and return once the product has done
   * what it promises at that moment: the removal is accepted (its tombstone is written) and the
   * organization refuses its owner. The erasure itself runs afterwards in the removal Workflow;
   * `/settle`, looked at again and again once per run, waits for it and deletes the scenario's users.
   */
  const remove = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { id } = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Id }))),
    );
    const scenario = owned.get(id),
      current = auth,
      database = pool;
    if (scenario === undefined) return { accepted: true };
    if (current === undefined || database === undefined)
      return yield* new TestAccountFailed({ stage: "configuration" });
    let phase: RemovePhase = "find-organization";
    // The name and message of the failed step, for the log only; the response carries `safeCause`.
    let logged: string | undefined;
    const failed = (cause: unknown) => {
      logged = cause instanceof Error ? `${cause.name}: ${cause.message}` : typeof cause;
      return new CleanupFailed({ phase, cause: safeCause(cause) });
    };
    const step = <A>(next: RemovePhase, work: () => Promise<A>) =>
      Effect.suspend(() => {
        phase = next;
        return Effect.tryPromise({ try: work, catch: failed });
      });
    // The owner's read of the organization this clean-up removed, once its removal is accepted.
    let ownerAccess:
      | Effect.Effect<
          { response: HttpClientResponse.HttpClientResponse; text: string },
          CleanupFailed
        >
      | undefined;
    yield* scenario.gate.withPermits(1)(
      Effect.gen(function* () {
        const found = yield* step("find-organization", async () => {
          const ctx = await current.$context;
          const row = await ctx.adapter.findOne({
            model: "organization",
            where: [{ field: "slug", value: organizationSlug(id) }],
          });
          return row === null
            ? undefined
            : Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(row).id;
        });
        if (found !== undefined) scenario.organization = found;
        // A scenario may already have removed its organization: the same removal is checked at
        // the end of the run. With no organization there is nothing to accept.
        const tombstoned =
          found === undefined
            ? true
            : (yield* step("find-organization", () => removalRecord(database, found))) !==
              undefined;
        if (found !== undefined && !tombstoned) {
          // Restore cleanup authority only for an organization reserved by this process.
          yield* step("start-removal", async () => {
            const ctx = await current.$context;
            const user = await ctx.internalAdapter.findUserByEmail(
              `agent-${id}-owner@example.test`,
            );
            if (user !== null)
              await ctx.adapter.updateMany({
                model: "member",
                where: [
                  { field: "organizationId", value: found },
                  { field: "userId", value: user.user.id },
                ],
                update: { role: "owner" },
              });
          });
          const owner = yield* actor(id, "owner").pipe(Effect.mapError(failed));
          const http = yield* HttpClient.HttpClient;
          const ownerRequest = (method: "GET" | "DELETE", path: string) =>
            Effect.scoped(
              Effect.gen(function* () {
                const response = yield* http.execute(
                  HttpClientRequest.make(method)(`${browserOrigin}${path}`, {
                    headers: { cookie: owner.headers.cookie, origin: browserOrigin },
                  }),
                );
                return { response, text: yield* response.text };
              }),
            ).pipe(Effect.mapError(failed));
          const deleted = yield* ownerRequest("DELETE", `/api/organizations/${found}`);
          if (deleted.response.status !== 200 && deleted.response.status !== 404) {
            const refusal = Schema.decodeUnknownOption(Schema.fromJsonString(RemovalFailure))(
              deleted.text,
            );
            yield* Console.error({
              message: "Fixture organization removal failed",
              scenario: id,
              status: deleted.response.status,
              reason: Option.isSome(refusal) ? refusal.value._tag : "unexpected-response",
              ray: deleted.response.headers["cf-ray"],
            });
            return yield* new CleanupFailed({
              phase,
              cause: Option.isSome(refusal)
                ? `Organization removal refused with ${refusal.value._tag}`
                : `Organization removal answered HTTP ${deleted.response.status}`,
            });
          }
          const record = yield* step("confirm-accepted", () => removalRecord(database, found));
          if (record === undefined)
            return yield* new CleanupFailed({
              phase,
              cause: "Organization removal was not accepted",
            });
          ownerAccess = ownerRequest("GET", `/api/organizations/${found}/access`);
        }
        // The product holds a tombstone for it now (or the organization is gone): the end-of-run
        // check waits for this removal whatever the owner's answer below.
        const now = yield* Clock.currentTimeMillis;
        accepted.set(id, {
          label: scenario.label,
          users: scenario.users,
          organization: scenario.organization,
          acceptedAt: now,
          phase: "wait-for-organization",
          since: now,
          cause: undefined,
        });
        owned.delete(id);
        if (ownerAccess !== undefined) {
          // The product refuses the organization from the moment its tombstone commits
          // (organization-removal.spec.ts checks the same answer from the owner's side).
          phase = "confirm-unreachable";
          const access = yield* ownerAccess;
          if (access.response.status !== 403)
            return yield* new CleanupFailed({
              phase,
              cause: `Removed organization answered its owner with HTTP ${access.response.status}`,
            });
        }
      }).pipe(
        Effect.tapError((error) =>
          Console.error({
            message: "Fixture cleanup did not complete",
            scenario: id,
            phase: error.phase,
            cause: logged ?? error.cause,
          }),
        ),
      ),
    );
    return { accepted: true };
  });
  /**
   * Run at most `settleConcurrency` removal checks at once, however many looks started them, so a
   * check a look stopped waiting for still holds its place until it ends.
   */
  let checksRunning = 0;
  const checkQueue: Array<() => void> = [];
  const limited = async <A>(work: () => Promise<A>): Promise<A> => {
    while (checksRunning >= settleConcurrency)
      await new Promise<void>((resolve) => checkQueue.push(resolve));
    checksRunning += 1;
    try {
      return await work();
    } finally {
      checksRunning -= 1;
      checkQueue.shift()?.();
    }
  };
  const settled = new Map<string, SettledRemoval>();
  let deletionMs = 0;
  let deletions = 0;
  /**
   * One look at the removals this process accepted, as the end-of-run check
   * (e2e/sdk/removal-settlement.ts) asks for it again and again: start a check of each one not
   * finished (no organization row, the removal `done`, then delete the scenario's users), wait up
   * to `lookBudgetMs` for them, and answer with every removal's state. A check still running when
   * the look answers carries on and is read by a later look; it is never started twice. `ids`
   * narrows the look to some scenarios, for the scenario that proves the check.
   */
  const settle = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const input = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Settle)));
    const current = auth,
      database = pool;
    if (current === undefined || database === undefined)
      return yield* new TestAccountFailed({ stage: "configuration" });
    const started = yield* Clock.currentTimeMillis;
    const ids = input.ids ?? [...settled.keys(), ...accepted.keys(), ...owned.keys()];
    const enter = (entry: AcceptedRemoval, phase: SettlePhase) => {
      if (entry.phase === phase) return;
      entry.phase = phase;
      entry.since = Date.now();
    };
    const check = (id: string, entry: AcceptedRemoval) => async () => {
      const ctx = await current.$context;
      const organization = await ctx.adapter.findOne({
        model: "organization",
        where: [{ field: "slug", value: organizationSlug(id) }],
      });
      if (organization !== null) {
        enter(entry, "wait-for-organization");
        return false;
      }
      const record =
        entry.organization === undefined
          ? undefined
          : await removalRecord(database, entry.organization);
      if (entry.organization !== undefined && record?.status !== "done") {
        enter(entry, "wait-for-removal");
        return false;
      }
      enter(entry, "remove-users");
      const ready = Date.now();
      // Also discover identities created before a partially failed provisioning returned.
      for (const role of Role) {
        const found = await ctx.internalAdapter.findUserByEmail(`agent-${id}-${role}@example.test`);
        if (found !== null) entry.users.add(found.user.id);
      }
      for (const user of entry.users) await ctx.internalAdapter.deleteUser(user);
      const done = Date.now();
      deletionMs += done - ready;
      deletions += 1;
      accepted.delete(id);
      settled.set(id, {
        scenario: id,
        label: entry.label,
        organization: entry.organization ?? null,
        startedAt: record?.started_at ?? null,
        finishedAt: record?.finished_at ?? null,
        readyAt: new Date(ready).toISOString(),
        usersDeletedAt: new Date(done).toISOString(),
        deletionMs: done - ready,
      });
      return true;
    };
    const running = ids.flatMap((id) => {
      const entry = accepted.get(id);
      if (entry === undefined) return [];
      entry.inFlight ??= limited(check(id, entry)).then(
        (done) => {
          entry.inFlight = undefined;
          entry.cause = undefined;
          return done;
        },
        // A failed check counts as not finished yet; the next look checks again.
        (cause: unknown) => {
          entry.inFlight = undefined;
          entry.cause = safeCause(cause);
          return false;
        },
      );
      return [entry.inFlight];
    });
    yield* Effect.promise(() =>
      Promise.race([
        Promise.all(running),
        new Promise((resolve) => setTimeout(resolve, lookBudgetMs)),
      ]),
    );
    const finished = ids.flatMap((id) => {
      const removal = settled.get(id);
      return removal === undefined ? [] : [removal];
    });
    const pending = ids.flatMap((id) => {
      const entry = accepted.get(id);
      return entry === undefined ? [] : [[id, entry] as const];
    });
    const organizations = pending.flatMap(([, entry]) =>
      entry.organization === undefined ? [] : [entry.organization],
    );
    // One statement for all of them, under one bound: its connection may wait behind checks a lock
    // holds, and the look must still answer. Past the bound every status reads as unknown.
    const statuses = yield* Effect.promise(() =>
      organizations.length === 0
        ? Promise.resolve(new Map<string, (typeof Removal.Type)[number]>())
        : Promise.race([
            database
              .query(
                `select organization_id, instance_id, status, to_json(started_at) #>> '{}' as started_at,
                    to_json(finished_at) #>> '{}' as finished_at
                  from hosted_organization_removal where organization_id = any($1)`,
                [organizations],
              )
              .then(
                (result) =>
                  new Map(
                    (result.rows as Array<{ organization_id: string }>).map((row) => [
                      row.organization_id,
                      Schema.decodeUnknownSync(Removal)([row])[0]!,
                    ]),
                  ),
              )
              .catch(() => new Map<string, (typeof Removal.Type)[number]>()),
            new Promise<Map<string, (typeof Removal.Type)[number]>>((resolve) =>
              setTimeout(() => resolve(new Map()), statusBudgetMs),
            ),
          ]),
    );
    const unfinished = pending.map(([id, entry]) => {
      const organization = entry.organization;
      const record = organization === undefined ? undefined : statuses.get(organization);
      return {
        scenario: id,
        label: entry.label,
        organization: organization ?? null,
        phase: entry.phase,
        since: new Date(entry.since).toISOString(),
        acceptedAt: new Date(entry.acceptedAt).toISOString(),
        status: record?.status ?? null,
        instance: record?.instance_id ?? null,
        checking: entry.inFlight !== undefined,
        ...(entry.cause === undefined ? {} : { cause: entry.cause }),
      };
    });
    const neverAccepted = ids.flatMap((id) => {
      const entry = owned.get(id);
      return entry === undefined || accepted.has(id) || settled.has(id)
        ? []
        : [{ scenario: id, label: entry.label }];
    });
    return {
      finished,
      unfinished,
      neverAccepted,
      lookMs: (yield* Clock.currentTimeMillis) - started,
      checksRunning,
      deletions,
      deletionMs,
    };
  });
  const routes = Layer.mergeAll(
    HttpRouter.add("POST", "/configure", endpoint(configure)),
    HttpRouter.add("POST", "/actors", endpoint(provision)),
    HttpRouter.add("POST", "/session", endpoint(session)),
    HttpRouter.add("POST", "/operator", endpoint(operator)),
    HttpRouter.add("POST", "/remove", endpoint(remove)),
    HttpRouter.add("POST", "/settle", endpoint(settle)),
    HttpRouter.add("POST", "/domain", endpoint(domain)),
    HttpRouter.add(
      "GET",
      "/health",
      endpoint(Effect.sync(() => ({ configured: auth !== undefined }))),
    ),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* new TestAccountFailed({ stage: "configuration" });
  yield* fs.writeFileString(
    output,
    JSON.stringify({ origin: `http://127.0.0.1:${server.address.port}` }),
    { flag: "wx", mode: 0o600 },
  );
  yield* Effect.addFinalizer(() => fs.remove(output).pipe(Effect.orDie));
  return yield* Effect.never;
});
NodeRuntime.runMain(
  Effect.scoped(main).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
