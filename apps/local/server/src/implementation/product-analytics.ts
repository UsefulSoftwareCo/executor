/** Local and desktop analytics. Every event uses this installation's anonymous ID. */
import type { Executor, ToolCallResult, ToolResumeResult } from "@executor-js/sdk/core";
import type { ScheduleObservation } from "@executor-js/sdk/scheduling";
import {
  analyticsDestination,
  analyticsNotice,
  failureProperties,
  InstallId,
  makeAnalyticsSender,
  platformToken,
  releaseChannelOf,
  toolCompletion,
  type AnalyticsProduct,
  type AnalyticsSender,
} from "@executor-js/telemetry/product-analytics";
import { Clock, Config, Effect, Exit, FileSystem, Option, Path, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

/** The anonymous install ID, minted on the first start with analytics on and kept in the data directory. */
const installId = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, "install-id");
    if (yield* fs.exists(file)) {
      const saved = (yield* fs.readFileString(file)).trim();
      if (Schema.is(InstallId)(saved)) return saved;
    }
    const minted = crypto.randomUUID();
    yield* fs.writeFileString(file, minted, { mode: 0o600 });
    return minted;
  });

const Count = Schema.Struct({ count: Schema.Union([Schema.Number, Schema.NumberFromString]) });
const count = (rows: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
  rows.pipe(
    Effect.flatMap((result) => Schema.decodeUnknownEffect(Count)(result[0])),
    Effect.map(({ count }) => count),
    Effect.option,
    Effect.map(Option.getOrUndefined),
  );

/** This process's analytics, or none when the operator opted out or the build has no destination. */
export const localAnalytics = (options: {
  readonly directory: string;
  readonly product: Extract<AnalyticsProduct, "cli" | "desktop">;
  readonly platform: { readonly os: string; readonly arch: string };
  readonly sql: SqlClient.SqlClient;
}) =>
  Effect.gen(function* () {
    const destination = yield* analyticsDestination;
    if (destination === undefined) return undefined;
    const version = yield* Config.String("EXECUTOR_BUILD_VERSION").pipe(
      Config.withDefault("development"),
    );
    const sender = yield* makeAnalyticsSender({
      destination,
      common: {
        install_id: yield* installId(options.directory),
        product: options.product,
        version,
      },
    });
    yield* Effect.logInfo(analyticsNotice);
    const { sql } = options;
    // Counting must not delay startup; a failed count is omitted.
    yield* Effect.gen(function* () {
      const [apps, accounts] = yield* Effect.all([
        // The bundled Executor app and its account belong to the host, not the person.
        count(sql`select count(*) as count from executor_apps where owner <> 'executor-local'`),
        count(sql`select count(*) as count from executor_accounts where owner <> 'executor-local'`),
      ]);
      sender.capture("instance_started", {
        product: options.product,
        version,
        channel: releaseChannelOf(version),
        os: platformToken(options.platform.os),
        arch: platformToken(options.platform.arch),
        ...(apps === undefined ? {} : { apps }),
        ...(accounts === undefined ? {} : { accounts }),
      });
    }).pipe(Effect.forkScoped);
    return sender;
  }).pipe(
    // Analytics never prevents the product from starting.
    Effect.catch(() => Effect.succeed(undefined)),
  );

/** Terminal schedule runs; a run carries no identity beyond this installation. */
export const scheduleAnalytics = (sender: AnalyticsSender): typeof ScheduleObservation.Service => ({
  completed: (run) =>
    Effect.sync(() =>
      sender.capture("schedule_run_completed", {
        source: "schedule",
        outcome:
          run.status === "succeeded"
            ? "success"
            : run.status === "cancelled"
              ? "cancelled"
              : "failure",
        ok: run.status === "succeeded",
        duration_ms:
          run.finishedAt === null
            ? 0
            : Math.max(0, run.finishedAt.getTime() - run.startedAt.getTime()),
      }),
    ),
});

/**
 * Record use through one product surface. Only outcomes are recorded; inputs, results, names and
 * IDs stay out because each event's allowlist does not declare them.
 */
export const observeLocalExecutor = (
  executor: Executor,
  sender: AnalyticsSender | undefined,
  source: "mcp" | "api" | "dashboard" | "app_ui",
): Executor => {
  if (sender === undefined) return executor;
  const record = (event: string, properties: object = {}) =>
    Effect.sync(() => sender.capture(event, { ...properties, source }));
  const timed = <A, E, R>(event: string, work: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      return yield* work.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const duration_ms = Math.max(0, (yield* Clock.currentTimeMillis) - started);
            yield* record(event, {
              duration_ms,
              ...(Exit.isSuccess(exit)
                ? { outcome: "success", ok: true }
                : failureProperties(exit.cause)),
            });
          }),
        ),
      );
    });
  // Approval pauses are counted separately from completed tool calls.
  const tool = <A extends ToolCallResult | ToolResumeResult, E, R>(
    resumed: boolean,
    work: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      yield* record("tool_execution_started", { resumed });
      return yield* work.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const duration_ms = Math.max(0, (yield* Clock.currentTimeMillis) - started);
            if (Exit.isFailure(exit))
              return yield* record("tool_execution_completed", {
                resumed,
                duration_ms,
                ...failureProperties(exit.cause),
              });
            if (exit.value.status === "approval-required")
              return yield* record("tool_approval_requested", { resumed, duration_ms });
            yield* record("tool_execution_completed", {
              resumed,
              duration_ms,
              ...toolCompletion(exit.value),
            });
          }),
        ),
      );
    });
  return {
    ...executor,
    tools: {
      ...executor.tools,
      call: (input, options) => tool(false, executor.tools.call(input, options)),
      resume: (input, options) => tool(true, executor.tools.resume(input, options)),
    },
    appData: {
      ...executor.appData,
      query: (input) => timed("app_query_completed", executor.appData.query(input)),
      mutate: (input) => timed("app_mutation_completed", executor.appData.mutate(input)),
      subscribe: (input) => timed("app_subscription_started", executor.appData.subscribe(input)),
    },
    accountConnections: {
      ...executor.accountConnections,
      submit: (input) =>
        executor.accountConnections
          .submit(input)
          .pipe(Effect.tap(() => record("account_connected", { auth_kind: "credentials" }))),
      completeOAuth: (input) =>
        executor.accountConnections
          .completeOAuth(input)
          .pipe(Effect.tap(() => record("account_connected", { auth_kind: "oauth" }))),
    },
    apps: {
      ...executor.apps,
      deploy: (input) => executor.apps.deploy(input).pipe(Effect.tap(() => record("app_deployed"))),
    },
  };
};
