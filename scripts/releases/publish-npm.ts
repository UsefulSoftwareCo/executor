/**
 * Publish one complete version once. An accepted upload is polled, never uploaded again;
 * a retried job skips archives whose registry integrity matches byte for byte.
 */
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
import { FetchHttpClient, HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
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
      const integrityOf = (file: string) =>
        Effect.gen(function* () {
          const hash = createHash("sha512");
          yield* fs.stream(file).pipe(
            Stream.runForEach((bytes) =>
              Effect.sync(() => {
                hash.update(bytes);
              }),
            ),
          );
          return `sha512-${hash.digest("base64")}`;
        });
      // A retried job resumes only over archives npm already holds byte for byte.
      const pending: Array<(typeof packages)[number] & { integrity: string }> = [];
      for (const pkg of packages) {
        if (!(yield* fs.exists(pkg.file)))
          return yield* Effect.die(new Error(`Missing ${pkg.file}`));
        if (Number((yield* fs.stat(pkg.file)).size) > npmArchiveBudgetBytes)
          return yield* Effect.die(
            new Error(`npm archive exceeds the 180 MiB release budget: ${pkg.file}`),
          );
        const integrity = yield* integrityOf(pkg.file);
        const response = yield* http.get(`${registry}/executor/${pkg.version}`);
        if (response.status === 404) {
          yield* response.text;
          pending.push({ ...pkg, integrity });
          continue;
        }
        const published =
          response.status === 200
            ? yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(RegistryVersion)))
            : undefined;
        if (published?.dist.integrity !== integrity)
          return yield* Effect.die(
            new Error(
              `Cannot publish ${pkg.version}: the registry holds a different archive (status ${response.status}). Inspect existing publication before retrying.`,
            ),
          );
        yield* Console.log(`Already published ${pkg.version} with matching integrity`);
      }
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "executor-npm-" });
      const npmrc = path.join(temporary, "npmrc");
      // npm substitutes the explicitly supplied environment variable. The file contains no secret.
      yield* fs.writeFileString(npmrc, "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n", {
        mode: 0o600,
      });
      const upload = (pkg: (typeof pending)[number]) =>
        Effect.gen(function* () {
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
        });
      const verify = (pkg: (typeof pending)[number]) =>
        http.get(`${registry}/executor/${pkg.version}`).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(RegistryVersion)),
          Effect.flatMap((published) =>
            published.version === pkg.version && published.dist.integrity === pkg.integrity
              ? Effect.void
              : Effect.fail(new Error(`Registry integrity does not match ${pkg.version}`)),
          ),
          Effect.timeout(15_000),
          // npm can take over 15 minutes to expose a large accepted archive.
          Effect.retry({ schedule: Schedule.spaced(15_000), times: 160 }),
          Effect.andThen(Console.log(`Verified public npm archive ${pkg.version}`)),
        );
      // npm exposes each accepted runtime after minutes, so all runtimes upload before any is
      // awaited. The launcher names them as optional dependencies, so it uploads only once
      // every runtime is public.
      const runtimes = pending.filter((pkg) => pkg.version !== release.version);
      const launcher = pending.filter((pkg) => pkg.version === release.version);
      yield* Effect.forEach(runtimes, upload, { discard: true });
      yield* Effect.forEach(runtimes, verify, { concurrency: "unbounded", discard: true });
      yield* Effect.forEach(launcher, (pkg) => Effect.andThen(upload(pkg), verify(pkg)), {
        discard: true,
      });
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
