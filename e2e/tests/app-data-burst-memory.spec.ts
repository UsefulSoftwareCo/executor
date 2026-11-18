/**
 * Apps with a database deployed and called in a burst, past the app Worker limit, leave the app
 * runtime's memory bounded by the Workers it keeps loaded. The limit unloads each app's data
 * facet, and the runtime releases that Worker only when it drops the app's data supervisor, so the
 * supervisor resets itself once it has nothing else to do. Without that, a burst of a few hundred
 * apps with a database ran the runtime out of memory: it aborted, and every app's calls in flight
 * failed.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { workerdProcess } from "../support/local-workflow-engines.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

/** Apps in the burst, deployed eight at a time, then each called once. The first eight write a row first. */
const apps = 64;
const source = (
  tag: string,
) => `import { defineApp, query, mutation, router, object, string } from "apps";
export default defineApp({}, {
  tools: router({
    probe: query({ input: object({}) }, async ({ sql }) => ({ n: sql.exec("SELECT count(*) AS n FROM notes").one().n, tag: ${JSON.stringify(tag)} })),
    note: mutation({ input: object({}), output: string() }, async ({ sql }) => { sql.exec("INSERT INTO notes (id) VALUES ('kept')"); return "ok"; }),
  }),
});`;
const Probed = Schema.Struct({
  status: Schema.Literal("completed"),
  value: Schema.Struct({ n: Schema.Number, tag: Schema.String }),
});
const migration = {
  path: "migrations/0001_init.sql",
  content: "CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL);\n",
};
const Deployed = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });

interface RuntimeMemory {
  readonly pid: number;
  readonly residentMb: number;
  readonly virtualMb: number;
}

/**
 * The resident memory and address space of this scenario's apps runtime: the workerd process
 * among its product's descendants (`workerdProcess`, which fails unless exactly one matches).
 * Read with `ps` on Linux and macOS, and with PowerShell on Windows.
 */
const runtimeMemory = (directory: string) =>
  Effect.gen(function* () {
    const pid = yield* workerdProcess(directory);
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [virtualKb, residentKb] =
      process.platform === "win32"
        ? (yield* processes.string(
            ChildProcess.make("powershell.exe", [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `$p = Get-Process -Id ${pid}; "$([math]::Round($p.VirtualMemorySize64 / 1024)) $([math]::Round($p.WorkingSet64 / 1024))"`,
            ]),
          ))
            .trim()
            .split(/\s+/u)
            .map(Number)
        : (yield* processes.string(ChildProcess.make("ps", ["-o", "vsz=,rss=", "-p", String(pid)])))
            .trim()
            .split(/\s+/u)
            .map(Number);
    expect(Number.isFinite(virtualKb) && Number.isFinite(residentKb), `memory of ${pid}`).toBe(
      true,
    );
    return {
      pid,
      residentMb: Math.round(residentKb! / 1024),
      virtualMb: Math.round(virtualKb! / 1024),
    } satisfies RuntimeMemory;
  }).pipe(Effect.provide(NodeServices.layer));

layer(TestLive, { excludeTestServices: true })("App data burst memory", (it) => {
  it.effect(
    scenarios.appDataBurstMemory.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api;
          const target = yield* Target;
          const session = yield* api.session();
          const agent: Session = {
            ...session,
            send: (method, path, data, headers = {}) => {
              const { origin: _origin, ...rest } = headers;
              return session.send(method, path, data, {
                ...rest,
                authorization: `Bearer ${Redacted.value(target.apiKey)}`,
              });
            },
          };
          const run = randomUUID().slice(0, 6);
          const deploy = (i: number) =>
            Effect.flatMap(
              api.request(agent, "POST", "/v1/apps/deploy", {
                owner: "local",
                name: `Burst ${run} ${i}`,
                files: [
                  { path: "index.ts", content: source(`${run}-${i}`) },
                  appsManifest,
                  migration,
                ],
              }),
              (response) => {
                expect(response.status, JSON.stringify(response.body).slice(0, 800)).toBe(200);
                return Effect.map(body(Deployed, response), (deployed) => deployed.app.id);
              },
            );
          const call = (app: string, tool: string, kind: "query" | "mutation") =>
            Effect.flatMap(
              api.request(agent, "POST", "/v1/tools/call", { app, tool, kind, input: {} }),
              (response) => {
                expect(response.status, JSON.stringify(response.body).slice(0, 400)).toBe(200);
                return Effect.succeed(response);
              },
            );
          const probe = (app: string) =>
            Effect.gen(function* () {
              const started = performance.now();
              const response = yield* call(app, "probe", "query");
              const ms = performance.now() - started;
              return { ms, ...(yield* body(Probed, response)).value };
            });
          const ids: string[] = [];
          let early: RuntimeMemory | undefined;
          for (let i = 0; i < apps; i += 8) {
            ids.push(
              ...(yield* Effect.forEach([0, 1, 2, 3, 4, 5, 6, 7], (k) => deploy(i + k), {
                concurrency: 8,
              })),
            );
            if (i === 0) yield* Effect.forEach(ids, (app) => call(app, "note", "mutation"));
            if (ids.length === 16) early = yield* runtimeMemory(target.directory);
          }
          for (const app of ids)
            yield* Effect.addFinalizer(() =>
              api.request(agent, "DELETE", `/v1/apps/${app}`).pipe(Effect.ignore),
            );
          // Every app answers, in a burst too.
          yield* Effect.forEach(ids, (app) => probe(app), { concurrency: 8 });
          const late = yield* runtimeMemory(target.directory);
          // The first eight apps' facets were unloaded by the burst. Their next call starts the
          // supervisor afresh, and the row each wrote before the burst, and its version, are kept.
          // The call right after it finds the facet loaded.
          const pairs = yield* Effect.forEach(ids.slice(0, 8), (app) =>
            Effect.all([probe(app), probe(app)]),
          );
          const reloaded = pairs.map(([first]) => first);
          const warm = pairs.map(([, again]) => again);
          const median = (xs: ReadonlyArray<{ readonly ms: number }>) =>
            Math.round(xs.map((x) => x.ms).toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!);
          yield* Effect.logInfo(
            `APP_DATA_BURST_MEMORY ${JSON.stringify({ early, late, reloadedMs: median(reloaded), warmMs: median(warm) })}`,
          );
          ids.slice(0, 8).forEach((app, i) => {
            expect(reloaded[i]!.n, `the row ${app} wrote before the burst`).toBe(1);
            expect(reloaded[i]!.tag, `the version ${app} deployed`).toBe(`${run}-${i}`);
          });
          expect(early, "measured once 16 apps were deployed").toBeDefined();
          const before = early!;
          expect(late.pid, "the app runtime was not restarted").toBe(before.pid);
          // Each loaded data facet reserves about 1.8 GB of address space. 48 more apps past the
          // limit of 4 would add about 86 GB if unloaded facets stayed; they must not stay.
          expect(late.virtualMb - before.virtualMb, JSON.stringify({ early, late })).toBeLessThan(
            20_000,
          );
        }),
      ),
    { timeout: 600_000 },
  );
});
