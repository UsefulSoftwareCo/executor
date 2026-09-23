/** Publish one complete version once. An accepted upload is polled, never uploaded again. */
import { createHash } from "node:crypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Path,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  npmArchiveBudgetBytes,
  platformArchive,
  platformVersion,
  platforms,
  release,
} from "./config.ts";

const RegistryVersion = Schema.Struct({
  version: Schema.String,
  dist: Schema.Struct({ integrity: Schema.String }),
});
const Tags = Schema.Record(Schema.String, Schema.String);

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const http = yield* HttpClient.HttpClient;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const token = yield* Config.Redacted("NPM_TOKEN");
      const directory = process.argv[2];
      if (directory === undefined)
        return yield* Effect.die(new Error("Supply the downloaded artifact directory."));
      const files: string[] = [];
      const collect = (directory: string): Effect.Effect<void, unknown> =>
        Effect.gen(function* () {
          for (const name of yield* fs.readDirectory(directory)) {
            const file = path.join(directory, name);
            if ((yield* fs.stat(file)).type === "Directory") yield* collect(file);
            else files.push(file);
          }
        });
      yield* collect(directory);
      const packages = platforms.map((target) => {
        const matches = files.filter((file) => path.basename(file) === platformArchive(target));
        const [file, ...extra] = matches;
        if (file === undefined || extra.length !== 0)
          throw new Error(`Expected exactly one ${platformArchive(target)}.`);
        return {
          file,
          version: platformVersion(target),
          tag: `${release.channel}-${target.platform}-${target.arch}`,
        };
      });
      packages.push({
        file: `.local/releases/${release.version}/wrapper/executor-${release.version}.tgz`,
        version: release.version,
        tag: release.channel,
      });
      const registry = "https://registry.npmjs.org";
      const tags = http.get(`${registry}/-/package/executor/dist-tags`).pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(Tags)),
      );
      const before = yield* tags;
      for (const pkg of packages) {
        if (!(yield* fs.exists(pkg.file)))
          return yield* Effect.die(new Error(`Missing ${pkg.file}`));
        if (Number((yield* fs.stat(pkg.file)).size) > npmArchiveBudgetBytes)
          return yield* Effect.die(
            new Error(`npm archive exceeds the 180 MiB release budget: ${pkg.file}`),
          );
        const response = yield* http.get(`${registry}/executor/${pkg.version}`);
        yield* response.text;
        if (response.status !== 404)
          return yield* Effect.die(
            new Error(
              `Cannot publish ${pkg.version}: registry returned ${response.status}. Inspect existing publication before retrying.`,
            ),
          );
      }
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "executor-npm-" });
      const npmrc = path.join(temporary, "npmrc");
      // npm substitutes the explicitly supplied environment variable. The file contains no secret.
      yield* fs.writeFileString(npmrc, "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n", {
        mode: 0o600,
      });
      for (const pkg of packages) {
        const hash = createHash("sha512");
        yield* fs.stream(pkg.file).pipe(
          Stream.runForEach((bytes) =>
            Effect.sync(() => {
              hash.update(bytes);
            }),
          ),
        );
        const integrity = `sha512-${hash.digest("base64")}`;
        const code = yield* processes.exitCode(
          ChildProcess.make(
            "npm",
            ["publish", pkg.file, "--tag", pkg.tag, "--access", "public", "--ignore-scripts"],
            {
              env: { NPM_CONFIG_USERCONFIG: npmrc, NPM_TOKEN: Redacted.value(token) },
              extendEnv: true,
              stdout: "inherit",
              stderr: "inherit",
            },
          ),
        );
        if (code !== 0)
          return yield* Effect.die(
            new Error(
              `npm publish ${pkg.version} failed. Inspect the registry and do not blindly retry accepted uploads.`,
            ),
          );
        yield* http.get(`${registry}/executor/${pkg.version}`).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(RegistryVersion)),
          Effect.flatMap((published) =>
            published.version === pkg.version && published.dist.integrity === integrity
              ? Effect.void
              : Effect.fail(new Error(`Registry integrity does not match ${pkg.version}`)),
          ),
          Effect.timeout(15_000),
          Effect.retry({ schedule: Schedule.spaced(10_000), times: 60 }),
        );
        yield* Console.log(`Verified public npm archive ${pkg.version}`);
      }
      const after = yield* tags;
      if (
        after[release.channel] !== release.version ||
        (release.channel === "beta" && after.latest !== before.latest)
      )
        return yield* Effect.die(new Error("The npm channel check failed."));
      yield* Console.log(
        `Published executor@${release.channel}: ${release.version}; latest=${after.latest}`,
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);
