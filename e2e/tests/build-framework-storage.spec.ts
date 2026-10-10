/**
 * A retained build stores the app's own modules and names the `apps` framework it links; each
 * framework release is stored once and linked on load. Self-host keeps builds as files in its data
 * directory, so the scenarios read them there. Cloud keeps them in R2, which the scenarios cannot
 * read, so there they check only that each build loads and answers.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest, appsVersion } from "../support/apps-release.ts";
import { Evidence } from "../support/evidence.ts";
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

const hosted = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    target = yield* Target,
    evidence = yield* Evidence;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deploy = (name: string, files: ReturnType<typeof current>) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: `${name} ${randomUUID().slice(0, 8)}`,
        files,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const app = yield* body(App, response);
      const path = `${prefix}/apps/${app.id}`;
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
      );
      const { build } = yield* body(
        Deployment,
        yield* api.request(actors.owner, "GET", `${path}/source`),
      );
      return { app, path, build };
    });
  /** Call the app's one query. */
  const ping = (path: string, tool: string) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
        tool,
        input: {},
        kind: "query",
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body;
    });
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
  return { target, deploy, ping, builds, evidence };
});

layer(HostedLive, { excludeTestServices: true })("Build framework storage", (it) => {
  it.effect(scenarios.buildFrameworkColdLoad.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { target, deploy, ping, builds, evidence } = yield* hosted;
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
        }
        expect(yield* ping(deployed.path, "ping")).toBe(marker);
      }),
    ),
  );

  it.effect(scenarios.buildFrameworkShared.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { target, deploy, ping, builds } = yield* hosted;
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
          expect(yield* ping(first.path, "ping")).toBe("first");
          expect(yield* ping(second.path, "ping")).toBe("second");
          return;
        }

        const second = yield* deploy("Shared framework second", current("second"));
        expect(yield* ping(first.path, "ping")).toBe("first");
        expect(yield* ping(second.path, "ping")).toBe("second");
      }),
    ),
  );

  it.effect(scenarios.buildFrameworkVersions.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { target, deploy, ping, builds } = yield* hosted;
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
        }

        expect(yield* ping(newer.path, "ping")).toBe("current release");
        expect(yield* ping(old.path, "queries.ping")).toBe("older release");
      }),
    ),
  );
});
