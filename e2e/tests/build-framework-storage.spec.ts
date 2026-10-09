/**
 * A retained build stores the app's own modules and names the `apps` framework it links; each
 * framework release is stored once and linked on load. Self-host keeps builds as files in its data
 * directory, so the scenarios read them there. Cloud keeps them in R2, so they read the deploy's and
 * the cold load's delivered traces instead.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest, appsVersion } from "../support/apps-release.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";

/** A build record is the app's code; the framework it links is about 1.8 MB on its own. */
const recordLimit = 64 * 1024;
/** The published release the side-by-side app pins, which hosts resolve from npm. */
const olderRelease = "0.0.1-beta.5";

const current = (marker: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, query, object, string, router } from "apps";
export const ping = query({ input: object({}), output: string() }, async () => ${JSON.stringify(marker)});
export default defineApp({ accounts: {} }, { tools: router({ ping }) });`,
  },
  appsManifest,
];
/** Source written for the protocol-3 framework, before routers. */
const older = (marker: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, query, object } from "apps";
const ping = query({ input: object({}) }, async () => ${JSON.stringify(marker)});
export default defineApp({ accounts: {} }, { queries: { ping } });`,
  },
  {
    path: "package.json",
    content: JSON.stringify({ dependencies: { apps: olderRelease } }),
  },
];

const Identity = Schema.Struct({ version: Schema.String, sha256: Schema.String });
const BuildRecord = Schema.Struct({
  format: Schema.Literal(2),
  modules: Schema.Record(Schema.String, Schema.Unknown),
  framework: Identity,
});
const StoredFramework = Schema.Struct({
  version: Schema.String,
  sha256: Schema.String,
  modules: Schema.Record(Schema.String, Schema.String),
});
const Deployment = Schema.Struct({ build: Schema.String });
type Span = { readonly operationName: string; readonly tags: Readonly<Record<string, unknown>> };

const hosted = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    target = yield* Target,
    telemetry = yield* Telemetry,
    evidence = yield* Evidence;
  const prefix = `/api/organizations/${actors.organization.id}`;
  /** The trace of the request just made; the case's HTTP client gives each request its own. */
  const lastTrace = Effect.gen(function* () {
    const request = (yield* evidence.requests).at(-1);
    if (request === undefined) return yield* Effect.die("Request evidence is missing");
    return request.traceId;
  });
  /** The spans of one request's trace, once `operation` has been delivered. */
  const trace = (traceId: string, operation: string, label: string) =>
    telemetry.query(traceId).pipe(
      Effect.flatMap((result) =>
        result.data.some(({ span }) => span.operationName === operation)
          ? Effect.succeed(result)
          : Effect.fail(new Error(`${operation} has not been delivered`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
      Effect.tap((result) => evidence.json(`${label}.json`, result)),
      Effect.map((result): readonly Span[] => result.data.map(({ span }) => span)),
    );
  const deploy = (name: string, files: ReturnType<typeof current>) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: `${name} ${randomUUID().slice(0, 8)}`,
        files,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const traceId = yield* lastTrace;
      const app = yield* body(App, response);
      const path = `${prefix}/apps/${app.id}`;
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
      );
      const { build } = yield* body(
        Deployment,
        yield* api.request(actors.owner, "GET", `${path}/source`),
      );
      return { app, path, build, traceId };
    });
  /** Call the app's one query, with a trace of its own. */
  const ping = (path: string, tool: string) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
        tool,
        input: {},
        kind: "query",
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return { value: response.body, traceId: yield* lastTrace };
    });
  /** The retain span of a deploy, which names the framework the build links. */
  const retained = (traceId: string, label: string) =>
    trace(traceId, "runtime.cloud.retain", label).pipe(
      Effect.map((spans) => spans.find((span) => span.operationName === "runtime.cloud.retain")!),
    );

  /** Self-host keeps each build's record and every framework under its data directory. */
  const builds = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const directory = path.join(target.directory, "data", "builds");
    const decode = <A>(schema: Schema.Codec<A, string>, file: string) =>
      fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));
    const record = (build: string) =>
      Effect.gen(function* () {
        const file = path.join(directory, build, "worker.json");
        const size = (yield* fs.stat(file)).size;
        return { size: Number(size), ...(yield* decode(Schema.fromJsonString(BuildRecord), file)) };
      });
    const frameworkFile = (identity: typeof Identity.Type) =>
      path.join(directory, "frameworks", `${identity.version}-${identity.sha256}.json`);
    const frameworks = fs
      .readDirectory(path.join(directory, "frameworks"))
      .pipe(Effect.map((names) => names.toSorted()));
    return {
      record,
      frameworks,
      framework: (identity: typeof Identity.Type) =>
        decode(Schema.fromJsonString(StoredFramework), frameworkFile(identity)),
      written: (identity: typeof Identity.Type) =>
        fs.stat(frameworkFile(identity)).pipe(Effect.map((info) => info.mtime)),
      inlined: (build: string) => fs.exists(path.join(directory, `${build}.json`)),
    };
  });
  return { target, deploy, ping, trace, retained, builds, evidence };
});

layer(HostedLive, { excludeTestServices: true })("Build framework storage", (it) => {
  it.effect(scenarios.buildFrameworkColdLoad.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { target, deploy, ping, trace, retained, builds, evidence } = yield* hosted;
        const marker = `cold ${randomUUID().slice(0, 8)}`;
        const deployed = yield* deploy("Cold framework load", current(marker));

        if (target.metadata.target === "self-host") {
          const store = yield* builds;
          const record = yield* store.record(deployed.build);
          yield* evidence.json("cold-load-record.json", {
            size: record.size,
            framework: record.framework,
            modules: Object.keys(record.modules),
          });
          expect(record.framework.version).toBe(appsVersion);
          expect(
            Object.keys(record.modules).filter((name) => name.startsWith("node_modules/apps/")),
            "The record holds none of the framework's modules",
          ).toEqual([]);
          expect(record.size, "The record holds only the app's own code").toBeLessThan(recordLimit);
          const framework = yield* store.framework(record.framework);
          expect(framework.sha256).toBe(record.framework.sha256);
          expect(Object.keys(framework.modules)).toContain("node_modules/apps/index.js");
          expect(yield* store.inlined(deployed.build), "No inlined copy is written").toBe(false);
          // A restarted host has no Worker or decoded build; the call cold-loads the record and
          // links the stored framework.
          yield* serverControl("restart");
          expect((yield* ping(deployed.path, "ping")).value).toBe(marker);
          return;
        }

        // The deploy retains a small record and writes it and its framework to the colo cache.
        // The runner's first call links them from there, or from its own memory, and reads
        // nothing from R2. Another app on this apps release may be reading the same framework in
        // this isolate at that moment; the call then waits for that read and takes it from memory
        // ("shared").
        const retain = yield* retained(deployed.traceId, "cold-load-deploy");
        expect(
          Number(retain.tags["executor.build.retained_bytes"]),
          "The record holds only the app's own code",
        ).toBeLessThan(recordLimit);
        expect(String(retain.tags["executor.build.framework"]).startsWith(`${appsVersion}-`)).toBe(
          true,
        );
        const called = yield* ping(deployed.path, "ping");
        expect(called.value).toBe(marker);
        const spans = yield* trace(called.traceId, "runtime.cloud.build.cached", "cold-load");
        const loads = spans.filter((span) => span.operationName === "runtime.cloud.build.cached");
        expect(loads, "One cold Worker start loads its build once").toHaveLength(1);
        const load = loads[0]!;
        expect(load.tags["executor.build.cache"], "The deploy cached the record").toBe("hit");
        expect(
          ["hit", "memory", "shared"],
          "The deploy cached the framework, or the runner holds it decoded",
        ).toContain(load.tags["executor.build.framework_cache"]);
        expect(load.tags["executor.build.framework"]).toBe(retain.tags["executor.build.framework"]);
        expect(
          spans.filter((span) => span.operationName === "storage.blob.get"),
          "Neither part is read from R2",
        ).toEqual([]);
      }),
    ),
  );

  it.effect(scenarios.buildFrameworkShared.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { target, deploy, ping, retained, builds } = yield* hosted;
        const first = yield* deploy("Shared framework first", current("first"));

        if (target.metadata.target === "self-host") {
          const store = yield* builds;
          const identity = (yield* store.record(first.build)).framework;
          const written = yield* store.written(identity);
          const second = yield* deploy("Shared framework second", current("second"));
          expect((yield* store.record(second.build)).framework).toEqual(identity);
          expect(
            (yield* store.frameworks).filter((name) => name.startsWith(`${appsVersion}-`)),
            "One stored object for the release",
          ).toEqual([`${identity.version}-${identity.sha256}.json`]);
          expect(yield* store.written(identity), "The second deploy did not rewrite it").toEqual(
            written,
          );
          expect((yield* ping(first.path, "ping")).value).toBe("first");
          expect((yield* ping(second.path, "ping")).value).toBe("second");
          return;
        }

        const firstRetain = yield* retained(first.traceId, "first-deploy");
        const second = yield* deploy("Shared framework second", current("second"));
        const secondRetain = yield* retained(second.traceId, "second-deploy");
        expect(secondRetain.tags["executor.build.framework"]).toBe(
          firstRetain.tags["executor.build.framework"],
        );
        expect(
          String(secondRetain.tags["executor.build.framework_stored"]),
          "The second deploy finds the framework stored and does not write it",
        ).toBe("true");
        expect((yield* ping(first.path, "ping")).value).toBe("first");
        expect((yield* ping(second.path, "ping")).value).toBe("second");
      }),
    ),
  );

  it.effect(scenarios.buildFrameworkVersions.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { target, deploy, ping, trace, retained, builds } = yield* hosted;
        const newer = yield* deploy("Current framework", current("current release"));
        const old = yield* deploy("Older framework", older("older release"));

        if (target.metadata.target === "self-host") {
          const store = yield* builds;
          const newerIdentity = (yield* store.record(newer.build)).framework;
          const olderIdentity = (yield* store.record(old.build)).framework;
          expect(newerIdentity.version).toBe(appsVersion);
          expect(olderIdentity.version).toBe(olderRelease);
          expect(olderIdentity.sha256).not.toBe(newerIdentity.sha256);
          const stored = yield* store.frameworks;
          for (const identity of [newerIdentity, olderIdentity])
            expect(stored).toContain(`${identity.version}-${identity.sha256}.json`);
          // Both cold-load and link their own framework after a restart.
          yield* serverControl("restart");
        } else {
          const identities = yield* Effect.forEach(
            [
              [newer, "current-deploy"],
              [old, "older-deploy"],
            ] as const,
            ([deployed, label]) =>
              retained(deployed.traceId, label).pipe(
                Effect.map((span) => String(span.tags["executor.build.framework"])),
              ),
          );
          expect(identities[0]!.startsWith(`${appsVersion}-`)).toBe(true);
          expect(identities[1]!.startsWith(`${olderRelease}-`)).toBe(true);
        }

        const calledNewer = yield* ping(newer.path, "ping");
        const calledOlder = yield* ping(old.path, "queries.ping");
        expect(calledNewer.value).toBe("current release");
        expect(calledOlder.value).toBe("older release");
        if (target.metadata.target === "cloud") {
          const linked = yield* Effect.forEach(
            [
              [calledNewer, "current-load"],
              [calledOlder, "older-load"],
            ] as const,
            ([called, label]) =>
              trace(called.traceId, "runtime.cloud.build.cached", label).pipe(
                Effect.map((spans) =>
                  String(
                    spans.find((span) => span.operationName === "runtime.cloud.build.cached")!.tags[
                      "executor.build.framework"
                    ],
                  ),
                ),
              ),
          );
          expect(linked[0]!.startsWith(`${appsVersion}-`)).toBe(true);
          expect(linked[1]!.startsWith(`${olderRelease}-`)).toBe(true);
        }
      }),
    ),
  );
});
