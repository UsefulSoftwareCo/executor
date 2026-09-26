/**
 * Concurrent load windows: discovery-heavy MCP executes and tool calls run alongside dashboard
 * reads, so database pool contention and first-response waits show up in foreground routes.
 *
 * `runLoad` drives one target for a fixed window. `compareLoad` alternates whole windows between
 * two targets (A B B A ...), because the load itself is the condition being compared and two
 * simultaneous windows would share this machine's network and CPU.
 */
import { Clock, Console, Effect, Ref } from "effect";
import { mcpSession, type McpSession, type PerfRequestFailed } from "./client.ts";
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
   * Loops requesting `/health`, which does no database or upstream I/O. If its client time rises
   * with load, requests are waiting for the Worker itself rather than for the database.
   */
  readonly probeWorkers: number;
}

export interface LoadSample {
  readonly id: string;
  readonly kind: "read" | "execute" | "toolcall" | "probe";
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

const summaries = (samples: readonly LoadSample[]) => {
  const ids = [...new Set(samples.map((sample) => sample.id))].sort();
  const groups: Record<string, readonly LoadSample[]> = {
    "all.read": samples.filter((sample) => sample.kind === "read"),
    "all.execute": samples.filter((sample) => sample.kind === "execute"),
    "all.toolcall": samples.filter((sample) => sample.kind === "toolcall"),
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
                tool: "queries.list_account_0000",
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
    yield* target.owner("call");
    yield* Effect.all(
      [
        ...Array.from({ length: config.readWorkers }, (_, index) => reader(index)),
        ...Array.from({ length: config.executeWorkers }, (_, index) => executor(index)),
        ...Array.from({ length: config.callWorkers }, () => caller()),
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
    yield* Console.log(
      `${target.label.padEnd(22)} reads n=${reads?.n ?? 0} p50=${reads?.client?.p50 ?? "-"} p95=${reads?.client?.p95 ?? "-"} server p95=${reads?.server?.p95 ?? "-"} errors=${reads?.errors ?? 0} | executes n=${executes?.n ?? 0} p50=${executes?.client?.p50 ?? "-"} errors=${executes?.errors ?? 0}`,
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
