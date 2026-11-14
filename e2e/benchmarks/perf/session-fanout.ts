/**
 * Many MCP session objects active at once. A session object is chosen by the caller's grant, so
 * each API key here addresses its own object, and each object holds its own PgBouncer client
 * connections while it is active (notes/database-pool.md). The run keeps `objects` sessions busy
 * for `seconds`: every `interval` seconds each makes `parallel` concurrent `execute` calls. It
 * reports every call that failed, by the text the product returned, so a run that exhausts the
 * database's client connections shows the `StorageError` agents saw in production.
 *
 * The keys belong to one fixture organization and are kept in the private `keys` file (mode
 * 0600), so later runs reuse them instead of creating more.
 */
import { Clock, Console, Effect, FileSystem, Schedule, Schema } from "effect";
import { cookieHeader, mcpSession, PerfRequestFailed, productClient } from "./client.ts";
import { fixtureId } from "./seed.ts";
import { fixtureActors } from "./sessions.ts";
import type { StageControl } from "./stage.ts";

const Keys = Schema.Struct({
  origin: Schema.String,
  organization: Schema.String,
  keys: Schema.Array(Schema.String),
});
const Created = Schema.Struct({ key: Schema.String });

export interface FanoutCall {
  readonly object: number;
  readonly at: string;
  readonly ok: boolean;
  /** The product's text for a failed call, or the client error; empty for a success. */
  readonly failure: string;
  readonly clientMs: number;
  readonly traceId: string | undefined;
}

/** Collapse ids and numbers so failures with the same cause count together. */
const failureKind = (text: string) =>
  text
    .replace(/[0-9a-f]{8,}/g, "<id>")
    .replace(/\d+/g, "<n>")
    .slice(0, 160);

const resultText = (result: unknown) => {
  const content = (result as { content?: ReadonlyArray<{ type: string; text?: string }> }).content;
  return (content ?? []).map((block) => block.text ?? "").join(" ");
};

const ensureKeys = (control: StageControl, file: string, count: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const actors = yield* fixtureActors(control, fixtureId(0, "session-fanout"), "perf fanout");
    const stored = (yield* fs.exists(file))
      ? yield* fs
          .readFileString(file)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Keys))))
      : undefined;
    if (stored !== undefined && stored.origin !== control.origin)
      return yield* new PerfRequestFailed({
        operation: "fanout keys",
        detail: "The keys file was made for another stage",
      });
    const keys = [...(stored?.keys ?? [])];
    const client = yield* productClient(control.origin, cookieHeader(actors.actors.owner.cookies));
    const save = Effect.suspend(() =>
      fs.writeFileString(
        file,
        JSON.stringify({ origin: control.origin, organization: actors.organization.id, keys }),
        { mode: 0o600 },
      ),
    );
    while (keys.length < count) {
      // Sign-in rate limits apply to key creation; wait them out instead of failing the run.
      const response = yield* client
        .request("POST", "/api/auth/api-key/create", { name: `Perf fanout ${keys.length}` })
        .pipe(
          Effect.flatMap((answer) =>
            answer.status === 429
              ? Effect.fail(
                  new PerfRequestFailed({ operation: "api key", status: 429, detail: "" }),
                )
              : Effect.succeed(answer),
          ),
          Effect.retry({
            while: (error) => error.status === 429,
            schedule: Schedule.spaced("15 seconds"),
            times: 40,
          }),
        );
      if (response.status !== 200)
        return yield* new PerfRequestFailed({
          operation: "api key",
          status: response.status,
          detail: JSON.stringify(response.body).slice(0, 300),
        });
      keys.push((yield* Schema.decodeUnknownEffect(Created)(response.body)).key);
      yield* save;
    }
    return { organization: actors.organization.id, keys: keys.slice(0, count) };
  });

export const runSessionFanout = (input: {
  readonly control: StageControl;
  readonly keysFile: string;
  readonly objects: number;
  readonly seconds: number;
  readonly interval: number;
  readonly parallel: number;
}) =>
  Effect.gen(function* () {
    const { organization, keys } = yield* ensureKeys(input.control, input.keysFile, input.objects);
    yield* Console.log(`${keys.length} keys ready; opening sessions.`);
    const calls: FanoutCall[] = [];
    const started = yield* Clock.currentTimeMillis;
    const deadline = started + input.seconds * 1000;
    const call = (object: number, session: Effect.Success<ReturnType<typeof mcpSession>>) =>
      Effect.gen(function* () {
        const at = new Date(yield* Clock.currentTimeMillis).toISOString();
        const begun = performance.now();
        return yield* session.callTool("execute", { code: "return 1" }).pipe(
          Effect.map(({ result, exchanges }) => {
            const failed = (result as { isError?: boolean }).isError === true;
            return {
              object,
              at,
              ok: !failed,
              failure: failed ? failureKind(resultText(result)) : "",
              clientMs: performance.now() - begun,
              traceId: exchanges.at(-1)?.traceId,
            } satisfies FanoutCall;
          }),
          Effect.catch((error) =>
            Effect.succeed({
              object,
              at,
              ok: false,
              failure: failureKind(error.detail),
              clientMs: performance.now() - begun,
              traceId: undefined,
            } satisfies FanoutCall),
          ),
        );
      });
    yield* Effect.forEach(
      keys,
      (key, object) =>
        Effect.gen(function* () {
          // Spread session starts over the first interval, as independent agents arrive.
          yield* Effect.sleep(Math.floor((object / keys.length) * input.interval * 1000));
          const opened = yield* mcpSession(input.control.origin, key, organization).pipe(
            Effect.map((session) => ({ session, failure: "" })),
            Effect.catch((error) =>
              Effect.succeed({ session: undefined, failure: failureKind(error.detail) }),
            ),
          );
          if (opened.session === undefined) {
            calls.push({
              object,
              at: new Date(yield* Clock.currentTimeMillis).toISOString(),
              ok: false,
              failure: `initialize: ${opened.failure}`,
              clientMs: 0,
              traceId: undefined,
            });
            return;
          }
          const session = opened.session;
          while ((yield* Clock.currentTimeMillis) < deadline) {
            const tick = yield* Clock.currentTimeMillis;
            calls.push(
              ...(yield* Effect.all(
                Array.from({ length: input.parallel }, () => call(object, session)),
                { concurrency: "unbounded" },
              )),
            );
            const wait = tick + input.interval * 1000 - (yield* Clock.currentTimeMillis);
            if (wait > 0) yield* Effect.sleep(wait);
          }
          yield* session.close.pipe(Effect.ignore);
        }),
      { concurrency: "unbounded", discard: true },
    );
    const failures = new Map<string, number>();
    for (const entry of calls) {
      if (entry.ok) continue;
      failures.set(entry.failure, (failures.get(entry.failure) ?? 0) + 1);
    }
    const failed = calls.filter((entry) => !entry.ok).length;
    yield* Console.log(
      `${keys.length} objects, ${calls.length} calls, ${failed} failed (${((100 * failed) / Math.max(1, calls.length)).toFixed(2)}%).`,
    );
    for (const [text, count] of [...failures].sort((a, b) => b[1] - a[1]))
      yield* Console.log(`  ${String(count).padStart(6)}  ${text}`);
    return {
      startedAt: new Date(started).toISOString(),
      endedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      calls,
    };
  });
