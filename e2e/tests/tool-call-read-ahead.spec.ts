/**
 * An MCP tool call sends its checks and the reads they and the call need together, in one batch,
 * once its per-call recheck of the bearer token can run: the recheck first, then the access
 * check with the caller's links and the call's reads of the app and accounts, with the caller's
 * app recheck, in one snapshot taken after the token recheck. Calls never choose accounts: a call
 * runs with the accounts the caller's links give it when its access check reads them. The accounts
 * read ahead are those the session's last call ran with; a call whose links give it accounts the
 * session has not called with reads them in a second round. Each batch is one database round trip
 * from Cloud's session object.
 *
 * Batching changes no outcome. Nothing read is used until the token recheck passes: a call whose
 * token is revoked while that recheck waits is refused for its token, as before, even when its
 * app was deleted first, so the reads made beside the recheck were refused too. A change saved
 * while any of the call's checks waits takes effect on the call: the only account unlinked
 * refuses it, as no account is linked; an account linked in place of another runs it with the
 * account now linked; an account reconnected runs it with the new credentials. The access check held is the call's own, not
 * discovery's. A batch with a read that fails for storage is discarded: the call reads again on
 * its own, in order, and runs.
 * The self-host test entry point holds those two statements, so the scenario runs its own
 * development server, with its own trace collector.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Layer, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, SessionClients } from "../support/api.ts";
import {
  linkAccount,
  linkedAccountIds,
  unlinkAccount,
  connectionsPath,
} from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { startDevelopmentServer } from "../support/managed-server.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { throttlingCollector } from "../support/throttling-collector.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Read ahead fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service } } }, async ctx => ({
  tools: router({
    token: query({ input: object({}), output: string() }, async () => ctx.user.accounts.service.fields.token),
  }),
}));`;
/** An app without accounts, which needs no link. */
const freeSource = `import { defineApp, object, string, query, router } from "apps";
export default defineApp({}, { tools: router({
  ping: query({ input: object({}), output: string() }, async () => "pong"),
}) });`;

/** The self-host test host's statement hold; see `apps/hosted/testing/statement-hold-fixture.ts`. */
const statementHold = "/api/devtools/statement-hold";
const Held = Schema.Struct({ held: Schema.Boolean });
const Users = Schema.Struct({
  users: Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.String })),
});
const Organizations = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String }));
const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
});

/** One statement of the tool call, with the spans it ran under. */
interface Statement {
  readonly text: string;
  readonly under: ReadonlyArray<string>;
  readonly start: number;
  readonly end: number;
}
/** A `sql.pipeline` span, recorded among the statements: one batch the call sent. */
const batchMarker = "sql.pipeline";
const isBatch = (statement: Statement) => statement.text === batchMarker;
const isPatCheck = (statement: Statement) => statement.text.includes("from apikey where key");
const isAccessCheck = (statement: Statement) =>
  statement.text.includes("left join hosted_app_access p on p.id =");
/** The app read made ahead for the call, outside the SDK's tool call. */
const isSelectionRead = (statement: Statement) =>
  statement.under.includes("FumaDB.SqlQuery.findFirst") &&
  !statement.under.includes("sdk.tools.call");
/** The call's own reads of the app and accounts, made when nothing read ahead answered them. */
const isCallRead = (statement: Statement) => statement.under.includes("sdk.invocation.snapshot");

layer(HostedLive, { excludeTestServices: true })("Tool call read ahead", (it) => {
  it.effect(scenarios.toolCallReadAhead.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          evidence = yield* Evidence,
          collector = yield* throttlingCollector;
        // Only the test entry point mounts the statement hold.
        const origin = yield* startDevelopmentServer(target, {
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
        });
        const development = { ...target, metadata: { ...target.metadata, origin } };
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, development),
        );
        const mcp = yield* McpClient.pipe(
          Effect.provide(Layer.fresh(McpClient.layer)),
          Effect.provideService(Target, development),
        );
        const owner = yield* api.session(),
          headers = { origin };
        const send = (
          method: "GET" | "POST" | "PATCH" | "DELETE",
          path: string,
          payload?: unknown,
        ) => api.request(owner, method, `${origin}${path}`, payload, headers);
        expect((yield* send("POST", "/api/devtools/operator", {})).status).toBe(200);
        const directory = yield* body(Users, yield* send("GET", "/api/auth/admin/list-users"));
        const developer = directory.users.find((user) => user.email === "agent-agent@example.test");
        if (!developer) return yield* Effect.die("Development owner is missing");
        expect(
          (yield* send("POST", "/api/auth/admin/impersonate-user", { userId: developer.id }))
            .status,
        ).toBe(200);
        const organization = (yield* body(
          Organizations,
          yield* send("GET", "/api/auth/organization/list"),
        ))[0];
        if (!organization) return yield* Effect.die("Development organization is missing");
        const prefix = `/api/organizations/${organization.id}`;
        // A failed assertion must not leave a statement held.
        yield* Effect.addFinalizer(() => send("DELETE", statementHold).pipe(Effect.orDie));

        const deployed = yield* send("POST", `${prefix}/apps/deploy`, {
          name: `Read ahead ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() => send("DELETE", path).pipe(Effect.orDie));
        // Connecting an account from the app links it for the caller.
        const connect = (
          account?: string,
          token = account === undefined ? "synthetic-before" : "synthetic-after",
        ) =>
          Effect.gen(function* () {
            const pending = yield* body(
              Resource,
              yield* send(
                "POST",
                connectionsPath(path, "user", "service"),
                account === undefined ? {} : { account },
              ),
            );
            return yield* body(
              Resource,
              yield* send("POST", `${prefix}/connections/${pending.id}/submit`, {
                method: "key",
                label: "Synthetic",
                fields: { token },
              }),
            );
          });
        const account = (yield* connect()).id;
        yield* Effect.addFinalizer(() =>
          send("DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
        );
        const appPath = `${origin}${path}`;
        const link = (id: string) =>
          linkAccount(owner, appPath, "service", id).pipe(Effect.provideService(Api, api));
        const unlink = (id: string) =>
          unlinkAccount(owner, appPath, "service", id).pipe(Effect.provideService(Api, api));
        /**
         * Wait until the caller's links to the app are `expected`, oldest first, before a call whose
         * batches are counted: a call that reads links its session has not seen sends a second round.
         */
        const settled = (name: string, expected: ReadonlyArray<string>) =>
          linkedAccountIds(owner, appPath).pipe(
            Effect.provideService(Api, api),
            Effect.flatMap((linked) =>
              JSON.stringify(linked) === JSON.stringify(expected)
                ? Effect.succeed(linked)
                : Effect.fail(
                    new Error(
                      `Links ${JSON.stringify(linked)} are not yet ${JSON.stringify(expected)}`,
                    ),
                  ),
            ),
            Effect.retry({ schedule: Schedule.spaced("250 millis") }),
            Effect.timeout("30 seconds"),
            Effect.flatMap((linked) => evidence.json(`read-ahead-links-${name}.json`, linked)),
          );

        const token = (name: string) =>
          Effect.gen(function* () {
            const created = yield* send("POST", "/api/auth/api-key/create", { name });
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            const key = yield* body(Token, created);
            yield* Effect.addFinalizer(() =>
              send("POST", "/api/auth/api-key/delete", { keyId: key.id }).pipe(Effect.ignore),
            );
            return key;
          });
        const tool = `tools[${JSON.stringify(app.slug)}].token`;
        const code = `return await ${tool}({})`;
        const executeWith = (client: Effect.Success<ReturnType<typeof mcp.connect>>, run = code) =>
          client
            .use("Call the app's tool through execute", (client, signal) =>
              client.callTool({ name: "execute", arguments: { code: run } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Execution)(result.structuredContent),
              ),
              Effect.map(({ execution }) => execution),
            );
        /** Arm the hold, which releases any statement held before, for the next statement `arm` names. */
        const arm = (statement: unknown) =>
          Effect.gen(function* () {
            expect((yield* send("POST", statementHold, statement)).status).toBe(200);
          });
        /** Wait until the armed statement is held. */
        const reached = send("GET", statementHold).pipe(
          Effect.flatMap((response) => body(Held, response)),
          Effect.flatMap((state) =>
            state.held ? Effect.void : Effect.fail(new Error("The statement was not held")),
          ),
          Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }),
        );
        /** Hold the statement `statement` names, change saved state meanwhile, then release it. */
        const held = <A, E, R, E2, R2>(
          statement: unknown,
          call: Effect.Effect<A, E, R>,
          meanwhile: Effect.Effect<unknown, E2, R2>,
        ) =>
          Effect.gen(function* () {
            yield* arm(statement);
            const fiber = yield* Effect.forkChild(call);
            yield* reached;
            yield* meanwhile;
            yield* send("DELETE", statementHold);
            return yield* Fiber.join(fiber);
          });
        /** The SQL statements the last MCP request's last tool call made, in start order. */
        const statements = Effect.gen(function* () {
          const request = (yield* evidence.requests)
            .filter((request) => request.path === "/mcp")
            .at(-1);
          if (request === undefined) return yield* Effect.die("MCP request evidence missing");
          return yield* collector.query(request.traceId).pipe(
            Effect.flatMap((result) => {
              const byId = new Map(result.data.map(({ span }) => [span.spanId, span]));
              // The request's server span ends after every tool call the request ran, so it
              // leaves in the same export as the last one or a later one. Until it arrives, the
              // latest tool call here may be an earlier call of the same request.
              const served = result.data.some(
                ({ span }) =>
                  span.operationName.startsWith("http.server") && span.tags["url.path"] === "/mcp",
              );
              if (!served)
                return Effect.fail(new Error("The MCP request's server span must reach Motel"));
              const root = result.data
                .filter(({ span }) => span.operationName === "mcp.tool.call")
                .toSorted((a, b) => Date.parse(a.span.startTime) - Date.parse(b.span.startTime))
                .at(-1);
              if (root === undefined)
                return Effect.fail(new Error("The tool call must reach Motel"));
              const found: Statement[] = [];
              for (const { span } of result.data) {
                if (span.operationName !== "sql.execute" && span.operationName !== "sql.pipeline")
                  continue;
                const under: string[] = [];
                let parent = span.parentSpanId;
                let inside = false;
                while (parent !== null) {
                  if (parent === root.span.spanId) {
                    inside = true;
                    break;
                  }
                  const next = byId.get(parent);
                  if (next === undefined) break;
                  under.push(next.operationName);
                  parent = next.parentSpanId;
                }
                if (!inside || under.some((name) => name.startsWith("runtime."))) continue;
                const start = Date.parse(span.startTime);
                found.push({
                  text:
                    span.operationName === "sql.pipeline"
                      ? batchMarker
                      : String(span.tags["db.query.text"] ?? "").replace(/\s+/g, " "),
                  under,
                  start,
                  end: start + span.durationMs,
                });
              }
              return found.some(isPatCheck)
                ? Effect.succeed(found.toSorted((a, b) => a.start - b.start))
                : Effect.fail(new Error("The tool call's statements must reach Motel"));
            }),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
          );
        });

        const key = yield* token("Read ahead");
        const client = yield* mcp.connect(key.key, "pat", { organization: organization.id });
        const execute = executeWith(client);
        yield* settled("connected", [account]);
        // The session's first call has not seen the links, so it reads the accounts in a second
        // round; the next call reads them in its first.
        expect(yield* execute).toEqual({ ok: true, value: "synthetic-before" });
        expect((yield* statements).filter(isBatch).length, "A cold call's two rounds").toBe(2);
        expect(yield* execute).toEqual({ ok: true, value: "synthetic-before" });
        expect((yield* statements).filter(isBatch).length, "A warm call's one batch").toBe(1);

        yield* evidence.step(
          "The call's checks and reads leave together once its token recheck can run",
          Effect.gen(function* () {
            const ran = yield* held({ authentication: "tool-call" }, execute, Effect.void);
            expect(ran).toEqual({ ok: true, value: "synthetic-before" });
            const made = yield* statements;
            yield* evidence.json("read-ahead-statements.json", made);
            const recheck = made.find(isPatCheck);
            const batches = made.filter(isBatch);
            expect(batches.length, "One batch: the session's previous call read the links").toBe(1);
            // The held recheck's statement starts only once released, after a request from here;
            // the batch waits for it, so nothing left before the recheck could.
            expect(batches[0]?.start ?? 0).toBeGreaterThanOrEqual(recheck?.start ?? Infinity);
            expect(made.filter(isSelectionRead).length, "The app read").toBe(1);
            expect(made.filter(isAccessCheck).length, "One access check").toBe(1);
            expect(
              made.filter(isCallRead).length,
              "The call used the batch's reads instead of reading again",
            ).toBe(0);
          }),
        );

        yield* evidence.step(
          "A token revoked while its recheck waits is refused for its token, though what was read beside it was refused too",
          Effect.gen(function* () {
            // A second app without accounts, which one execution discovers and then calls after a
            // first call. It is deleted while that first call's recheck is held, so the second
            // call's app read, made beside its own held recheck, is refused.
            const freeDeployed = yield* send("POST", `${prefix}/apps/deploy`, {
              name: `Read ahead free ${randomUUID().slice(0, 8)}`,
              files: [{ path: "index.ts", content: freeSource }, appsManifest],
            });
            expect(freeDeployed.status, JSON.stringify(freeDeployed.body)).toBe(200);
            const free = yield* body(App, freeDeployed);
            const freePath = `${prefix}/apps/${free.id}`;
            yield* Effect.addFinalizer(() => send("DELETE", freePath).pipe(Effect.ignore));
            const revoked = yield* token("Read ahead revoked");
            const doomed = yield* mcp.connect(revoked.key, "pat-revoked", {
              organization: organization.id,
            });
            const freeCall = `tools[${JSON.stringify(free.slug)}].ping({})`;
            expect(yield* executeWith(doomed, `return await ${freeCall}`)).toEqual({
              ok: true,
              value: "pong",
            });
            const both = `const first = await ${tool}({});
return [first, await ${freeCall}];`;
            const refused = yield* held(
              { authentication: "tool-call" },
              executeWith(doomed, both),
              Effect.gen(function* () {
                // The first call's recheck is held, after discovery: delete the second app.
                expect((yield* send("DELETE", freePath)).status).toBe(200);
                // Release the first call and hold the second call's recheck, then revoke.
                yield* arm({ authentication: "tool-call" });
                yield* reached;
                expect(
                  (yield* send("POST", "/api/auth/api-key/delete", { keyId: revoked.id })).status,
                ).toBe(200);
              }),
            );
            yield* evidence.json("read-ahead-revoked.json", refused);
            expect(refused, "Refused for its token, not for its deleted app").toEqual({
              ok: false,
              error: { kind: "ToolFailure", message: "McpUnauthorized" },
            });
            const made = yield* statements;
            yield* evidence.json("read-ahead-revoked-statements.json", made);
            expect(
              made.filter(isSelectionRead).length,
              "The deleted app's read went out beside the recheck",
            ).toBe(1);
            expect(made.filter(isBatch).length, "Nothing sent after a failed recheck").toBe(1);
            expect(made.some(isCallRead), "No state read for the call after a failed recheck").toBe(
              false,
            );
          }),
        );

        yield* evidence.step(
          "A change saved while the call's access check waits takes effect on the call",
          Effect.gen(function* () {
            const refused = yield* held({ app: app.id, toolCall: true }, execute, unlink(account));
            yield* evidence.json("read-ahead-unlinked.json", refused);
            expect(refused.ok, "The only account unlinked while the access check waits").toBe(
              false,
            );
            // The access check reads the caller's links after the change: no account is linked
            // for the plain requirement, so the call is refused for that.
            expect(refused.error).toMatchObject({
              response: { code: "AccountRequired", status: 409 },
            });
            yield* link(account);
            yield* settled("relinked", [account]);
            const reconnected = yield* held(
              { app: app.id, toolCall: true },
              execute,
              Effect.gen(function* () {
                expect((yield* connect(account)).id).toBe(account);
              }),
            );
            expect(reconnected, "An account reconnected while the access check waits").toEqual({
              ok: true,
              value: "synthetic-after",
            });
          }),
        );

        const other = yield* evidence.step(
          "Another account linked in place of the call's while its access check waits runs the call, read in a second round",
          Effect.gen(function* () {
            // The access check reads the caller's links in its own statement, so the links it
            // reads after the change decide the call: it runs with the account now linked. The
            // session has not called with that account, so it is read in a second round.
            const other = (yield* connect(undefined, "synthetic-other")).id;
            yield* Effect.addFinalizer(() =>
              send("DELETE", `${prefix}/accounts/${other}`).pipe(Effect.orDie),
            );
            // Connecting from the app linked it in place of the call's account, which stays
            // saved; linking that account again replaces it in turn.
            yield* settled("connected-other", [other]);
            yield* link(account);
            yield* settled("before-switch", [account]);
            expect(yield* execute).toEqual({ ok: true, value: "synthetic-after" });
            const switched = yield* held(
              { app: app.id, toolCall: true },
              execute,
              Effect.gen(function* () {
                // The plain requirement's provider is used by nothing else: the link replaces.
                yield* link(other);
                yield* settled("switched", [other]);
              }),
            );
            yield* evidence.json("read-ahead-switched.json", switched);
            expect(switched, "Links changed while the call's access check waits").toEqual({
              ok: true,
              value: "synthetic-other",
            });
            const made = yield* statements;
            yield* evidence.json("read-ahead-switched-statements.json", made);
            expect(made.filter(isBatch).length, "A second round for the account now linked").toBe(
              2,
            );
            expect(made.filter(isAccessCheck).length, "One access check").toBe(1);
            expect(
              made.filter(isCallRead).length,
              "The call used the second round's reads instead of reading again",
            ).toBe(0);
            // The next call's discovery lists the account now linked, and the call runs with it.
            expect(yield* execute).toEqual({ ok: true, value: "synthetic-other" });
            return other;
          }),
        );

        yield* evidence.step(
          "A read of the accounts made beside the access check that fails for storage is made again in order",
          Effect.gen(function* () {
            // As a connection dropped between two replies of one write would: the read made ahead
            // stands in for nothing, and the call reads the accounts itself.
            yield* arm({ fail: "tool-call-accounts" });
            const ran = yield* execute;
            yield* reached;
            yield* send("DELETE", statementHold);
            yield* evidence.json("read-ahead-storage-failure.json", ran);
            expect(ran, "The call reads its accounts again and runs").toEqual({
              ok: true,
              value: "synthetic-other",
            });
            const made = yield* statements;
            yield* evidence.json("read-ahead-storage-failure-statements.json", made);
            expect(
              made.filter((statement) => statement.text.includes('FROM "executor_accounts"'))
                .length,
              "The accounts read again, after the failed read ahead",
            ).toBe(1);
          }),
        );

        yield* evidence.step(
          "An account the session has not called with is read in a second round, for the account the live links give it",
          Effect.gen(function* () {
            // Connecting another account from the app replaces the linked one, which stays saved.
            const third = (yield* connect(undefined, "synthetic-third")).id;
            yield* Effect.addFinalizer(() =>
              send("DELETE", `${prefix}/accounts/${third}`).pipe(Effect.orDie),
            );
            yield* settled("replaced", [third]);
            // The session has run no call with this account, so the first round reads only the
            // app and the access check with the links; the second reads the linked account. The
            // replaced account is deleted while that check waits: the call still resolves.
            const replaced = yield* held(
              { app: app.id, toolCall: true },
              execute,
              Effect.gen(function* () {
                expect((yield* send("DELETE", `${prefix}/accounts/${other}`)).status).toBe(200);
                yield* settled("replaced-deleted", [third]);
              }),
            );
            yield* evidence.json("read-ahead-replaced.json", replaced);
            expect(replaced, "The newly linked account runs").toEqual({
              ok: true,
              value: "synthetic-third",
            });
            const made = yield* statements;
            yield* evidence.json("read-ahead-replaced-statements.json", made);
            expect(made.filter(isBatch).length, "Two rounds").toBe(2);
            expect(made.filter(isAccessCheck).length, "One access check").toBe(1);
            expect(
              made.filter(isCallRead).length,
              "The call used the second round's reads instead of reading again",
            ).toBe(0);
            // The session has now called with the account: the next call reads it in one batch.
            expect(yield* execute).toEqual({ ok: true, value: "synthetic-third" });
            expect((yield* statements).filter(isBatch).length, "A warm call's one batch").toBe(1);
          }),
        );
      }),
    ),
  );
});
