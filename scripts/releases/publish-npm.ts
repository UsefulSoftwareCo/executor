/**
 * Publish the `executor` launcher for one version once. The native runtimes are not on npm: the
 * launcher downloads them from the public GitHub release and checks each against the SHA-256 its
 * package.json records. So this refuses a launcher that does not record every platform's archive
 * in the artifact directory, or whose archives the public release does not list in its
 * SHA256SUMS. An accepted upload is polled, never uploaded again; a retried job skips a launcher
 * whose registry integrity matches byte for byte.
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
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { platformArchive, platforms, release } from "./config.ts";

const RegistryVersion = Schema.Struct({
  version: Schema.String,
  dist: Schema.Struct({ integrity: Schema.String }),
});
const Tags = Schema.Record(Schema.String, Schema.String);
const Launcher = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    runtimes: Schema.Record(Schema.String, Schema.String),
  }),
);

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
      const digest = (file: string, algorithm: "sha256" | "sha512") =>
        Effect.gen(function* () {
          const hash = createHash(algorithm);
          yield* fs.stream(file).pipe(
            Stream.runForEach((bytes) =>
              Effect.sync(() => {
                hash.update(bytes);
              }),
            ),
          );
          return hash;
        });

      const launcherDirectory = path.join(".local/releases", release.version, "wrapper");
      const file = path.join(launcherDirectory, `executor-${release.version}.tgz`);
      if (!(yield* fs.exists(file))) return yield* Effect.die(new Error(`Missing ${file}`));
      const launcher = yield* fs
        .readFileString(path.join(launcherDirectory, "package.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Launcher)));
      if (launcher.version !== release.version)
        return yield* Effect.die(
          new Error(`The launcher is ${launcher.version}, not ${release.version}.`),
        );
      const names = platforms.map((target) => `${target.platform}-${target.arch}`);
      const unknown = Object.keys(launcher.runtimes).filter((name) => !names.includes(name));
      if (unknown.length !== 0)
        return yield* Effect.die(new Error(`The launcher records unknown runtimes: ${unknown}.`));

      // The archives the public release serves, as its SHA256SUMS lists them.
      const sums = yield* http
        .get(`https://github.com/${release.repository}/releases/download/${release.tag}/SHA256SUMS`)
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
        );
      const listed = new Map<string, string>();
      for (const line of sums.split("\n")) {
        const match = /^([0-9a-f]{64}) [ *](?:\.\/)?(.+)$/u.exec(line.trim());
        if (match !== null) listed.set(match[2] ?? "", match[1] ?? "");
      }
      for (const target of platforms) {
        const name = platformArchive(target);
        const [archive, ...extra] = files.filter((candidate) => path.basename(candidate) === name);
        if (archive === undefined || extra.length !== 0)
          return yield* Effect.die(new Error(`Expected exactly one ${name}.`));
        const sha256 = (yield* digest(archive, "sha256")).digest("hex");
        if (launcher.runtimes[`${target.platform}-${target.arch}`] !== sha256)
          return yield* Effect.die(new Error(`The launcher does not record ${name} as built.`));
        if (listed.get(name) !== sha256)
          return yield* Effect.die(
            new Error(`The public release ${release.tag} does not serve ${name} as built.`),
          );
      }

      const registry = "https://registry.npmjs.org";
      const tags = http.get(`${registry}/-/package/executor/dist-tags`).pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(Tags)),
      );
      const before = yield* tags;
      const integrity = `sha512-${(yield* digest(file, "sha512")).digest("base64")}`;
      // A retried job resumes only over a launcher npm already holds byte for byte.
      const existing = yield* http.get(`${registry}/executor/${release.version}`);
      if (existing.status === 404) {
        yield* existing.text;
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "executor-npm-" });
        const npmrc = path.join(temporary, "npmrc");
        // npm substitutes the explicitly supplied environment variable. The file contains no secret.
        yield* fs.writeFileString(npmrc, "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n", {
          mode: 0o600,
        });
        const code = yield* processes.exitCode(
          ChildProcess.make(
            "npm",
            ["publish", file, "--tag", release.channel, "--access", "public", "--ignore-scripts"],
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
              `npm publish ${release.version} failed. Inspect the registry and do not blindly retry accepted uploads.`,
            ),
          );
      } else {
        const published =
          existing.status === 200
            ? yield* existing.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(RegistryVersion)))
            : undefined;
        if (published?.dist.integrity !== integrity)
          return yield* Effect.die(
            new Error(
              `Cannot publish ${release.version}: the registry holds a different archive (status ${existing.status}). Inspect existing publication before retrying.`,
            ),
          );
        yield* Console.log(`Already published ${release.version} with matching integrity`);
      }
      yield* http.get(`${registry}/executor/${release.version}`).pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(RegistryVersion)),
        Effect.flatMap((published) =>
          published.version === release.version && published.dist.integrity === integrity
            ? Effect.void
            : Effect.fail(new Error(`Registry integrity does not match ${release.version}`)),
        ),
        Effect.timeout(15_000),
        // npm can take minutes to expose an accepted version.
        Effect.retry({ schedule: Schedule.spaced(15_000), times: 160 }),
      );
      yield* Console.log(`Verified public npm archive ${release.version}`);
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
