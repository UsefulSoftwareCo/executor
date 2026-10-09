/**
 * Concurrent load windows: discovery-heavy MCP executes and tool calls run alongside dashboard
 * reads, so database pool contention and first-response waits show up in foreground routes.
 * Schedule loops start runs through the schedule coordinator, whose statements run from wherever
 * that Durable Object lives rather than from the placed Worker.
 *
 * `runLoad` drives one target for a fixed window. `compareLoad` alternates whole windows between
 * two targets (A B B A ...), because the load itself is the condition being compared and two
 * simultaneous windows would share this machine's network and CPU.
 */
import { Clock, Console, Effect, Ref, Schedule, Schema } from "effect";
import { appsManifest } from "../../support/apps-release.ts";
import {
  mcpSession,
  PerfRequestFailed,
  type McpSession,
  type ProductClient,
  type Timed,
} from "./client.ts";
import { summarize, type Summary } from "./runner.ts";
import {
  dashboardOrg,
  executeCode,
  primaryAccount,
  primaryApp,
  type PerfTarget,
} from "./scenarios.ts";
import type { OrgReceipt } from "./seed.ts";

export interface LoadConfig {
  readonly seconds: number;
  /** Concurrent MCP execute loops over the discovery-heavy organizations. */
  readonly executeWorkers: number;
  /** Concurrent dashboard read loops as the dashboard organization owner. */
  readonly readWorkers: number;
  /** Concurrent REST tool-call loops against the zero-latency MCP upstream. */
  readonly callWorkers: number;
  /**
   * Loops that each start a run of their own schedule and wait for it to finish. The run is
   * dispatched by the schedule coordinator, so its time includes that object's database trips.
   */
  readonly scheduleWorkers: number;
  /**
   * Loops requesting `/health`, which does no database or upstream I/O. If its client time rises
   * with load, requests are waiting for the Worker itself rather than for the database.
   */
  readonly probeWorkers: number;
}

export interface LoadSample {
  readonly id: string;
  readonly kind: "read" | "execute" | "toolcall" | "schedule" | "probe";
  readonly at: string;
  readonly ok: boolean;
  readonly status: number;
  readonly clientMs: number;
  readonly serverMs?: number | undefined;
  readonly traceId?: string | undefined;
  readonly error?: string;
}

export interface LoadWindow {
  readonly label: string;
  readonly slug: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly config: LoadConfig;
  readonly samples: readonly LoadSample[];
  readonly summary: Record<
    string,
    { client: Summary | null; server: Summary | null; errors: number; n: number }
  >;
}

/** Organizations whose executes fan out discovery across many apps and tools. */
export const heavyOrgs = ["a24f", "a8f", "a24s", "a8s"] as const;

const org = (o: OrgReceipt) => `/api/organizations/${o.organization.id}`;
const app = (o: OrgReceipt) => `${org(o)}/apps/${primaryApp(o).id}`;
/** Reads a dashboard page issues on navigation; auth routes exercise the Better Auth driver. */
export const loadReads: readonly (readonly [string, (o: OrgReceipt) => string])[] = [
  ["api.inventory", (o) => `${org(o)}/inventory`],
  ["api.apps", (o) => `${org(o)}/apps`],
  ["api.access", (o) => `${org(o)}/access`],
  ["api.app", (o) => app(o)],
  ["api.app.profiles", (o) => `${app(o)}/profiles`],
  ["api.app.access", (o) => `${app(o)}/access`],
  ["api.account", (o) => `${org(o)}/accounts/${primaryAccount(o)}`],
  ["api.scheduled-runs", (o) => `${org(o)}/scheduled-runs`],
  ["auth.get-session", () => `/api/auth/get-session`],
  ["auth.organization.list", () => `/api/auth/organization/list`],
  [
    "auth.list-members",
    (o) => `/api/auth/organization/list-members?organizationId=${o.organization.id}`,
  ],
];

/** The `call` organization's app whose schedules the schedule loops start on demand. */
const scheduledAppName = "Perf scheduled runs";
/** Enough schedules for one per loop; their hourly interval keeps them from running on their own. */
const scheduleNames = Array.from({ length: 16 }, (_, index) => `s${index + 1}`);
const scheduledSource = `import { defineApp, mutation, interval, object, router } from "apps";
const tick = mutation({ input: object({}) }, async () => ({ done: true }));
export default defineApp({ accounts: {} }, async () => ({ tools: router({ tick }), schedules: { ${scheduleNames
  .map((name) => `${name}: interval({ minutes: 60 }, tick, {})`)
  .join(", ")} } }));`;
const ScheduledInventory = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
const Identified = Schema.Struct({ id: Schema.String });
const ScheduledRuns = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    status: Schema.String,
    startedAt: Schema.optional(Schema.NullOr(Schema.String)),
    finishedAt: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const finishedRun = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

class RunPending extends Schema.TaggedError<RunPending>()("RunPending", {}) {}

const decodeBody =
  <A>(schema: Schema.Codec<A, unknown>, operation: string) =>
  (response: Timed) =>
    response.status === 200
      ? Schema.decodeUnknownEffect(schema)(response.body).pipe(
          Effect.mapError(
            () => new PerfRequestFailed({ operation, status: 200, detail: "unexpected body" }),
          ),
        )
      : Effect.fail(
          new PerfRequestFailed({
            operation,
            status: response.status,
            detail: JSON.stringify(response.body).slice(0, 300),
          }),
        );

/** Find or deploy the scheduled app in `call`; returns its API path. */
const scheduledApp = (target: PerfTarget, client: ProductClient) =>
  Effect.gen(function* () {
    const root = org(target.org("call"));
    const inventory = yield* client
      .request("GET", `${root}/inventory`)
      .pipe(Effect.flatMap(decodeBody(ScheduledInventory, "inventory")));
    const existing = inventory.apps.find((entry) => entry.name === scheduledAppName);
    const app =
      existing ??
      (yield* client
        .request("POST", `${root}/apps/deploy`, {
          name: scheduledAppName,
          files: [{ path: "index.ts", content: scheduledSource }, appsManifest],
        })
        .pipe(Effect.flatMap(decodeBody(Identified, "deploy scheduled app"))));
    return { root, app: app.id, path: `${root}/apps/${app.id}` };
  });

const summaries = (samples: readonly LoadSample[]) => {
  const ids = [...new Set(samples.map((sample) => sample.id))].sort();
  const groups: Record<string, readonly LoadSample[]> = {
    "all.read": samples.filter((sample) => sample.kind === "read"),
    "all.execute": samples.filter((sample) => sample.kind === "execute"),
    "all.toolcall": samples.filter((sample) => sample.kind === "toolcall"),
    "all.schedule": samples.filter((sample) => sample.kind === "schedule"),
    "all.probe": samples.filter((sample) => sample.kind === "probe"),
    ...Object.fromEntries(ids.map((id) => [id, samples.filter((sample) => sample.id === id)])),
  };
  return Object.fromEntries(
    Object.entries(groups).map(([id, group]) => {
      const ok = group.filter((sample) => sample.ok);
      return [
        id,
        {
          n: group.length,
          errors: group.length - ok.length,
          client: summarize(ok.map((sample) => sample.clientMs)),
          server: summarize(
            ok.flatMap((sample) => (sample.serverMs === undefined ? [] : [sample.serverMs])),
          ),
        },
      ];
    }),
  );
};

/** One load window against one target. Workers stop starting requests at the deadline. */
export const runLoad = (target: PerfTarget, config: LoadConfig) =>
  Effect.gen(function* () {
    const samples = yield* Ref.make<readonly LoadSample[]>([]);
    const startedMs = yield* Clock.currentTimeMillis;
    const deadline = startedMs + config.seconds * 1000;
    const record = (sample: LoadSample) => Ref.update(samples, (all) => [...all, sample]);
    const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());
    const active = Effect.map(Clock.currentTimeMillis, (ms) => ms < deadline);
    const failed = (id: string, kind: LoadSample["kind"], at: string, error: PerfRequestFailed) =>
      record({
        id,
        kind,
        at,
        ok: false,
        status: error.status ?? 0,
        clientMs: 0,
        error: `${error.operation}: ${error.detail}`.slice(0, 300),
      });

    const reader = (index: number) =>
      Effect.gen(function* () {
        const entry = target.org(dashboardOrg);
        let step = index;
        while (yield* active) {
          const [id, path] = loadReads[step++ % loadReads.length]!;
          const at = yield* now;
          yield* target.owner(dashboardOrg).pipe(
            Effect.flatMap((client) => client.request("GET", path(entry))),
            Effect.flatMap((response) =>
              record({
                id,
                kind: "read",
                at,
                ok: response.status >= 200 && response.status < 300,
                status: response.status,
                clientMs: response.clientMs,
                serverMs: response.serverMs,
                traceId: response.traceId,
              }),
            ),
            Effect.catch((error) => failed(id, "read", at, error)),
          );
        }
      });

    const executor = (index: number) =>
      Effect.gen(function* () {
        const key = heavyOrgs[index % heavyOrgs.length]!;
        const entry = target.org(key);
        const code = executeCode(entry.apps[0]!, 1);
        let session: McpSession | undefined;
        while (yield* active) {
          const at = yield* now;
          const id = `mcp.execute.${key}`;
          if (session === undefined || session.lost()) {
            if (session !== undefined) yield* session.close.pipe(Effect.ignore);
            session = yield* mcpSession(
              target.control.origin,
              entry.pat,
              entry.organization.id,
            ).pipe(
              Effect.catch((error) => failed(id, "execute", at, error).pipe(Effect.as(undefined))),
            );
            if (session === undefined) continue;
          }
          const opened = session;
          yield* opened.callTool("execute", { code }).pipe(
            Effect.flatMap((call) => {
              const exchange = call.exchanges.find((item) => item.method === "tools/call");
              const ok =
                exchange !== undefined && exchange.status === 200 && call.result.isError !== true;
              return record({
                id,
                kind: "execute",
                at,
                ok,
                ...(ok
                  ? {}
                  : {
                      error: JSON.stringify(
                        call.result.structuredContent ?? call.result.content,
                      ).slice(0, 300),
                    }),
                status: exchange?.status ?? 0,
                clientMs: call.clientMs,
                serverMs: exchange?.serverMs,
                traceId: exchange?.traceId,
              });
            }),
            Effect.catch((error) => failed(id, "execute", at, error)),
          );
        }
        if (session !== undefined) yield* session.close.pipe(Effect.ignore);
      });

    const caller = () =>
      Effect.gen(function* () {
        const entry = target.org("call");
        const selected = entry.apps.find((item) => item.kind === "mcp" && !item.auth);
        if (selected === undefined) return;
        while (yield* active) {
          const at = yield* now;
          yield* target.owner("call").pipe(
            Effect.flatMap((client) =>
              client.request("POST", `${org(entry)}/apps/${selected.id}/tools/call`, {
                profile: selected.profile,
                tool: "list_account_0000",
                kind: "query",
                input: {},
              }),
            ),
            Effect.flatMap((response) =>
              record({
                id: "toolcall.rest.mcp",
                kind: "toolcall",
                at,
                ok: response.status >= 200 && response.status < 300,
                status: response.status,
                clientMs: response.clientMs,
                serverMs: response.serverMs,
                traceId: response.traceId,
              }),
            ),
            Effect.catch((error) => failed("toolcall.rest.mcp", "toolcall", at, error)),
          );
        }
      });

    // Each loop starts its own schedule and waits until that run finishes. Client time is the wait
    // from `run now` to the finished run, including the coordinator's one-second alarm delay; server
    // time is the run's own recorded duration, which carries the coordinator's database trips.
    const scheduler = (app: Effect.Success<ReturnType<typeof scheduledApp>>, name: string) =>
      Effect.gen(function* () {
        const client = yield* target.owner("call");
        const schedule = `${app.path}/schedules/${name}`;
        const runs = client.request("GET", `${app.root}/scheduled-runs?app=${app.app}`).pipe(
          Effect.flatMap(decodeBody(ScheduledRuns, "scheduled runs")),
          Effect.map((rows) => rows.filter((row) => row.name === name)),
        );
        yield* client.request("PATCH", schedule, { enabled: true, approvalMode: "automatic" });
        while (yield* active) {
          const at = yield* now;
          const startedMs = yield* Clock.currentTimeMillis;
          yield* Effect.gen(function* () {
            const before = new Set((yield* runs).map((row) => row.id));
            const started = yield* client.request("POST", `${schedule}/run`);
            if (started.status !== 200) return yield* decodeBody(Identified, "run now")(started);
            const run = yield* runs.pipe(
              Effect.flatMap((rows) => {
                const found = rows.find(
                  (row) => !before.has(row.id) && finishedRun.has(row.status),
                );
                return found === undefined ? Effect.fail(new RunPending()) : Effect.succeed(found);
              }),
              Effect.retry({
                while: (error) => error._tag === "RunPending",
                schedule: Schedule.spaced("100 millis"),
              }),
              Effect.timeout("30 seconds"),
              Effect.mapError(
                (cause) =>
                  new PerfRequestFailed({ operation: `schedule ${name}`, detail: String(cause) }),
              ),
            );
            const serverMs =
              run.startedAt && run.finishedAt
                ? Date.parse(run.finishedAt) - Date.parse(run.startedAt)
                : undefined;
            yield* record({
              id: "schedule.run",
              kind: "schedule",
              at,
              ok: run.status === "succeeded",
              status: started.status,
              clientMs: (yield* Clock.currentTimeMillis) - startedMs,
              serverMs,
              traceId: started.traceId,
              ...(run.status === "succeeded" ? {} : { error: run.status }),
            });
          }).pipe(Effect.catch((error) => failed("schedule.run", "schedule", at, error)));
        }
      }).pipe(
        Effect.ensuring(
          target.owner("call").pipe(
            Effect.flatMap((client) =>
              client.request("PATCH", `${app.path}/schedules/${name}`, { enabled: false }),
            ),
            Effect.ignore,
          ),
        ),
        Effect.catch((error) =>
          failed("schedule.run", "schedule", new Date().toISOString(), error),
        ),
      );

    const prober = () =>
      Effect.gen(function* () {
        while (yield* active) {
          const at = yield* now;
          yield* target.owner(dashboardOrg).pipe(
            Effect.flatMap((client) => client.request("GET", "/health")),
            Effect.flatMap((response) =>
              record({
                id: "probe.health",
                kind: "probe",
                at,
                ok: response.status >= 200 && response.status < 300,
                status: response.status,
                clientMs: response.clientMs,
                serverMs: response.serverMs,
                traceId: response.traceId,
              }),
            ),
            Effect.catch((error) => failed("probe.health", "probe", at, error)),
          );
          yield* Effect.sleep("250 millis");
        }
      });

    // Sessions are minted before the window so fixture calls are not measured.
    yield* target.owner(dashboardOrg);
    const callOwner = yield* target.owner("call");
    // Every schedule loop shares one app, found or deployed before the window.
    const scheduled =
      config.scheduleWorkers > 0 ? yield* scheduledApp(target, callOwner) : undefined;
    yield* Effect.all(
      [
        ...Array.from({ length: config.readWorkers }, (_, index) => reader(index)),
        ...Array.from({ length: config.executeWorkers }, (_, index) => executor(index)),
        ...Array.from({ length: config.callWorkers }, () => caller()),
        ...(scheduled === undefined
          ? []
          : scheduleNames
              .slice(0, config.scheduleWorkers)
              .map((name) => scheduler(scheduled, name))),
        ...Array.from({ length: config.probeWorkers }, () => prober()),
      ],
      { concurrency: "unbounded", discard: true },
    );
    const all = yield* Ref.get(samples);
    const window: LoadWindow = {
      label: target.label,
      slug: target.control.slug,
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: yield* now,
      config,
      samples: all,
      summary: summaries(all),
    };
    const reads = window.summary["all.read"];
    const executes = window.summary["all.execute"];
    const schedules = window.summary["all.schedule"];
    yield* Console.log(
      `${target.label.padEnd(22)} reads n=${reads?.n ?? 0} p50=${reads?.client?.p50 ?? "-"} p95=${reads?.client?.p95 ?? "-"} server p95=${reads?.server?.p95 ?? "-"} errors=${reads?.errors ?? 0} | executes n=${executes?.n ?? 0} p50=${executes?.client?.p50 ?? "-"} errors=${executes?.errors ?? 0} | schedules n=${schedules?.n ?? 0} p50=${schedules?.client?.p50 ?? "-"} p95=${schedules?.client?.p95 ?? "-"} errors=${schedules?.errors ?? 0}`,
    );
    return window;
  });

/** Alternate whole windows between two targets (ABBA order) with a pause for drain. */
export const compareLoad = (
  a: PerfTarget,
  b: PerfTarget,
  config: LoadConfig,
  rounds: number,
  pauseSeconds: number,
) =>
  Effect.gen(function* () {
    const windows: LoadWindow[] = [];
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 === 0 ? [a, b] : [b, a];
      for (const target of order) {
        windows.push(yield* runLoad(target, config));
        yield* Effect.sleep(`${pauseSeconds} seconds`);
      }
    }
    const pooled = (label: string) => {
      const samples = windows
        .filter((window) => window.label === label)
        .flatMap((window) => window.samples);
      return summaries(samples);
    };
    return { windows, pooled: { [a.label]: pooled(a.label), [b.label]: pooled(b.label) } };
  }).pipe(Effect.ensuring(Effect.all([a.close, b.close])));

/** Markdown rows for pooled load summaries. */
export const loadTable = (pooled: Record<string, ReturnType<typeof summaries>>) => {
  const labels = Object.keys(pooled);
  const ids = [...new Set(labels.flatMap((label) => Object.keys(pooled[label]!)))].sort();
  const cell = (summary: Summary | null | undefined, key: "p50" | "p95" | "max") =>
    summary === null || summary === undefined ? "-" : String(Math.round(summary[key]));
  return [
    `| Route | ${labels.map((label) => `${label} n | client p50 | p95 | max | server p50 | p95 | errors`).join(" | ")} |`,
    `| --- | ${labels.map(() => "--: | --: | --: | --: | --: | --: | --:").join(" | ")} |`,
    ...ids.map(
      (id) =>
        `| ${id} | ${labels
          .map((label) => {
            const row = pooled[label]![id];
            return row === undefined
              ? "- | - | - | - | - | - | -"
              : `${row.n} | ${cell(row.client, "p50")} | ${cell(row.client, "p95")} | ${cell(row.client, "max")} | ${cell(row.server, "p50")} | ${cell(row.server, "p95")} | ${row.errors}`;
          })
          .join(" | ")} |`,
    ),
  ].join("\n");
};
