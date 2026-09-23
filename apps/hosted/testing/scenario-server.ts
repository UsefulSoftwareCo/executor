/** Local fixture control process. Database credentials stay in memory and never enter the Worker. */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Config, Effect, FileSystem, Layer, Redacted, Schema, Semaphore, Schedule } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
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
const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
// Preserve all 128 bits in at most 27 characters, including the prefix.
const organizationSlug = (id: string) => `s-${BigInt(`0x${id}`).toString(36)}`;
const Request = Schema.Struct({ id: Id, label: Schema.NonEmptyString });
const SessionRequest = Schema.Struct({
  id: Id,
  role: Schema.Literals(["owner", "admin", "member"]),
});
const Role = ["owner", "admin", "member"] as const;

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const origin = yield* Config.NonEmptyString("TEST_FIXTURE_ORIGIN");
  const token = yield* Config.Redacted("TEST_FIXTURE_TOKEN");
  const output = yield* Config.NonEmptyString("TEST_FIXTURE_OUTPUT");
  const configured = yield* Semaphore.make(1);
  let auth: ReturnType<typeof testAccountAuth> | undefined;
  let pool: Pool | undefined;
  const owned = new Map<string, { label: string; gate: Semaphore.Semaphore; users: Set<string> }>();
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
      Effect.catch(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: "Fixture operation failed" }, { status: 400 }),
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
        /^test-e2e-[a-z0-9-]+$/.test(input.stage) &&
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
      return value;
    });
  const provision = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const input = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Request)));
    let scenario = owned.get(input.id);
    if (scenario === undefined) {
      scenario = { label: input.label, gate: yield* Semaphore.make(1), users: new Set<string>() };
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
  const remove = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { id } = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Id }))),
    );
    const scenario = owned.get(id),
      current = auth;
    if (scenario === undefined) return { removed: true };
    if (current === undefined) return yield* new TestAccountFailed({ stage: "configuration" });
    yield* scenario.gate.withPermits(1)(
      Effect.gen(function* () {
        const cleanup = yield* Effect.tryPromise({
          try: async () => {
            const ctx = await current.$context;
            const row = await ctx.adapter.findOne({
              model: "organization",
              where: [{ field: "slug", value: organizationSlug(id) }],
            });
            if (row === null) return undefined;
            const organization = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
              row,
            );
            // Restore cleanup authority only for an organization reserved by this process.
            const found = await ctx.internalAdapter.findUserByEmail(
              `agent-${id}-owner@example.test`,
            );
            if (found !== null) {
              await ctx.adapter.updateMany({
                model: "member",
                where: [
                  { field: "organizationId", value: organization.id },
                  { field: "userId", value: found.user.id },
                ],
                update: { role: "owner" },
              });
            }
            return organization;
          },
          catch: () => new TestAccountFailed({ stage: "fixture" }),
        });
        if (cleanup !== undefined) {
          const owner = yield* actor(id, "owner");
          const http = yield* HttpClient.HttpClient;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const response = yield* http.execute(
                HttpClientRequest.make("DELETE")(`${origin}/api/organizations/${cleanup.id}`, {
                  headers: { cookie: owner.headers.cookie, origin },
                }),
              );
              yield* response.text;
              if (response.status !== 200 && response.status !== 404)
                return yield* new TestAccountFailed({ stage: "fixture" });
            }),
          );
        }
        yield* Effect.tryPromise({
          try: async () => {
            const ctx = await current.$context;
            const organization = await ctx.adapter.findOne({
              model: "organization",
              where: [{ field: "slug", value: organizationSlug(id) }],
            });
            if (organization !== null) throw new Error("Product cleanup is still running");
            // Also discover identities created before a partially failed provisioning operation returned.
            for (const role of Role) {
              const found = await ctx.internalAdapter.findUserByEmail(
                `agent-${id}-${role}@example.test`,
              );
              if (found !== null) scenario.users.add(found.user.id);
            }
            for (const user of scenario.users) await ctx.internalAdapter.deleteUser(user);
          },
          catch: () => new TestAccountFailed({ stage: "fixture" }),
        }).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }));
        owned.delete(id);
      }),
    );
    return { removed: true };
  });
  const routes = Layer.mergeAll(
    HttpRouter.add("POST", "/configure", endpoint(configure)),
    HttpRouter.add("POST", "/actors", endpoint(provision)),
    HttpRouter.add("POST", "/session", endpoint(session)),
    HttpRouter.add("POST", "/remove", endpoint(remove)),
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
  yield* Effect.never;
});
NodeRuntime.runMain(
  Effect.scoped(main).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
