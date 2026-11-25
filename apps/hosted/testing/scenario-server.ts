import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient } from "pg";
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
const transportCode = (cause: unknown, depth = 0): string | undefined => {
  if (depth > 3) return undefined;
  const parsed = Schema.decodeUnknownOption(TransportCause)(cause);
  return Option.isNone(parsed)
    ? undefined
    : (parsed.value.code ?? transportCode(parsed.value.cause, depth + 1));
};
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
type RemovePhase =
  | "find-organization"
  | "start-removal"
  | "confirm-accepted"
  | "confirm-unreachable";
type SettlePhase = "wait-for-organization" | "wait-for-removal" | "remove-users";
class CleanupFailed extends Schema.TaggedError<CleanupFailed>()("CleanupFailed", {
  phase: Schema.String,
  cause: Schema.String,
}) {}
const SqlState = Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^[0-9A-Z]{5}$/u)) });
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
const settleConcurrency = 6;
const lookBudgetMs = 10_000;
const statusBudgetMs = 2_000;
interface AcceptedRemoval {
  readonly label: string;
  readonly users: Set<string>;
  readonly organization: string | undefined;
  readonly acceptedAt: number;
  phase: SettlePhase;
  since: number;
  cause: string | undefined;
  inFlight?: Promise<boolean> | undefined;
}
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
  const webhookQueue = Effect.gen(function* () {
    const database = pool;
    if (auth === undefined || database === undefined)
      return yield* new TestAccountFailed({ stage: "configuration" });
    const result = yield* Effect.tryPromise({
      try: () =>
        database.query(
          `select (select count(*)::int from executor_webhook_sources
                where status = 'pending' and lease is null) as pending,
              (select count(*)::int from hosted_provisioning
                where kind in ('team', 'member') and status in ('queued', 'running')) as provisioning,
              (extract(epoch from now()) * 1000)::bigint::text as at`,
        ),
      catch: () => new TestAccountFailed({ stage: "database" }),
    });
    const [row] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([
        Schema.Struct({
          pending: Schema.Int,
          provisioning: Schema.Int,
          at: Schema.NumberFromString,
        }),
      ]),
    )(result.rows);
    return row;
  });
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
    const since = row?.status_since == null ? Number.NaN : Date.parse(row.status_since);
    return {
      status: row?.status ?? ("absent" as const),
      ...(row?.certificate == null ? {} : { certificate: row.certificate }),
      ...(Number.isNaN(since) ? {} : { since: new Date(since).toISOString() }),
    };
  });
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
        const tombstoned =
          found === undefined
            ? true
            : (yield* step("find-organization", () => removalRecord(database, found))) !==
              undefined;
        if (found !== undefined && !tombstoned) {
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
  const KeyUse = Schema.Struct({
    id: Id,
    key: Schema.NonEmptyString,
    action: Schema.Literals(["age", "hold", "release", "blocked"]),
    seconds: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 3600 }))),
  });
  const holds = new Map<string, { readonly client: PoolClient; readonly pid: number }>();
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      for (const { client } of holds.values()) {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }
      holds.clear();
    }),
  );
  const keyUse = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const input = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(KeyUse)));
    const scenario = owned.get(input.id);
    const database = pool;
    if (scenario === undefined || database === undefined)
      return yield* new TestAccountFailed({ stage: "fixture" });
    const users = [...scenario.users];
    const run = (text: string, params: ReadonlyArray<unknown>) =>
      Effect.tryPromise({
        try: () => database.query(text, [...params]),
        catch: () => new TestAccountFailed({ stage: "database" }),
      });
    const mine = `id = $1 and "referenceId" = any($2::text[])`;
    switch (input.action) {
      case "age": {
        const updated = yield* run(
          `update apikey set "lastRequest" = now() - make_interval(secs => $3) where ${mine}`,
          [input.key, users, input.seconds ?? 0],
        );
        return { updated: updated.rowCount ?? 0 };
      }
      case "hold": {
        if (holds.has(input.id)) return yield* new TestAccountFailed({ stage: "fixture" });
        const client = yield* Effect.tryPromise({
          try: () => database.connect(),
          catch: () => new TestAccountFailed({ stage: "database" }),
        });
        const held = yield* Effect.tryPromise({
          try: async () => {
            await client.query("begin");
            const updated = await client.query(
              `update apikey set "lastRequest" = now() where ${mine}`,
              [input.key, users],
            );
            const backend = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
            return { rowCount: updated.rowCount, pid: Number(backend.rows[0]?.pid) };
          },
          catch: () => new TestAccountFailed({ stage: "database" }),
        }).pipe(
          Effect.tapError(() =>
            Effect.promise(async () => {
              await client.query("rollback").catch(() => undefined);
              client.release();
            }),
          ),
        );
        holds.set(input.id, { client, pid: held.pid });
        return { updated: held.rowCount ?? 0 };
      }
      case "release": {
        const hold = holds.get(input.id);
        if (hold === undefined) return { released: false };
        const client = hold.client;
        holds.delete(input.id);
        yield* Effect.tryPromise({
          try: () => client.query("commit"),
          catch: () => new TestAccountFailed({ stage: "database" }),
        }).pipe(Effect.ensuring(Effect.sync(() => client.release())));
        return { released: true };
      }
      case "blocked": {
        const hold = holds.get(input.id);
        if (hold === undefined) return { keyChecks: 0, others: [] };
        const rows = yield* run(
          `with recursive waiting(pid) as (
              select pid from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))
              union
              select a.pid from pg_stat_activity a join waiting w on w.pid = any(pg_blocking_pids(a.pid))
            )
            select a.query like '%from apikey where key =%' as key_check,
              left(regexp_replace(a.query, '\\s+', ' ', 'g'), 40) as statement
              from waiting w join pg_stat_activity a on a.pid = w.pid`,
          [hold.pid],
        );
        return {
          keyChecks: rows.rows.filter((row) => row.key_check === true).length,
          others: rows.rows
            .filter((row) => row.key_check !== true)
            .map((row) => String(row.statement ?? "")),
        };
      }
    }
  });
  const routes = Layer.mergeAll(
    HttpRouter.add("POST", "/configure", endpoint(configure)),
    HttpRouter.add("POST", "/actors", endpoint(provision)),
    HttpRouter.add("POST", "/session", endpoint(session)),
    HttpRouter.add("POST", "/operator", endpoint(operator)),
    HttpRouter.add("POST", "/remove", endpoint(remove)),
    HttpRouter.add("POST", "/settle", endpoint(settle)),
    HttpRouter.add("POST", "/domain", endpoint(domain)),
    HttpRouter.add("POST", "/webhook-queue", endpoint(webhookQueue)),
    HttpRouter.add("POST", "/api-key-use", endpoint(keyUse)),
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
