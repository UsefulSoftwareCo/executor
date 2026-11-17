/**
 * Gate self-host deployment on the exact SDK served by its builder registry.
 * --publish explicitly applies today's policy to a compiled package, including historical builds,
 * then publishes its unchanged archive. npm does not run prepublishOnly for tarball publication.
 * A listed version is never republished. HTTP reads use the builder's anonymous registry access;
 * npm publication uses the operator's existing npmrc, never credentials supplied by this script.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, FileSystem, Path, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient, Url } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import apps from "../../packages/apps/package.json" with { type: "json" };
import {
  AppsReleaseMismatch,
  differingFiles,
  integrityOf,
  listFiles,
  pack,
  staged,
  stagedVersion,
  unpack,
} from "./apps-package.ts";

const Published = Schema.Struct({
  version: Schema.String,
  dist: Schema.Struct({ tarball: Schema.String, integrity: Schema.String }),
});
const Runtime = Schema.Struct({ version: Schema.String });
const Reference = Schema.Struct({ version: Schema.String, digest: Schema.String });
const args = process.argv.slice(2);
const publish = args.includes("--publish");
const packageIndex = args.indexOf("--package");
const packageDirectory = packageIndex < 0 ? staged : args[packageIndex + 1];
const redirectLimit = 5;

/** The origin of an absolute URL, or `undefined` when the text is not one. */
const originOf = (url: string) => {
  const parsed = Url.fromString(url);
  return Result.isSuccess(parsed) ? parsed.success.origin : undefined;
};

/**
 * GET the SDK tarball without reaching an origin the builder refuses. `fetch` follows redirects
 * by default, so a same-origin URL could land anywhere; each hop is requested with manual
 * redirects and refused unless it stays on `origin`, the builder registry's own.
 */
const downloadFromRegistry = (url: string, origin: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const response = yield* http
        .get(target)
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      const location = response.headers.location;
      if (response.status < 300 || response.status >= 400 || location === undefined)
        return response;
      yield* response.text;
      const parsed = Url.fromString(location, target);
      const next = Result.isSuccess(parsed) ? parsed.success : undefined;
      if (next === undefined || next.origin !== origin)
        return yield* new AppsReleaseMismatch({
          message: `Builder SDK tarball on ${origin} redirects to ${next?.origin ?? location}, outside the builder registry's origin. The builder refuses that tarball, so deployment is refused.`,
        });
      if (hop >= redirectLimit)
        return yield* new AppsReleaseMismatch({
          message: `Builder SDK tarball redirects more than ${redirectLimit} times. Deployment refused.`,
        });
      target = next.href;
    }
  });

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const http = yield* HttpClient.HttpClient;
    if (
      !packageDirectory ||
      args.some(
        (arg, index) =>
          arg !== "--publish" &&
          arg !== "--package" &&
          !(packageIndex >= 0 && index === packageIndex + 1),
      )
    )
      return yield* new AppsReleaseMismatch({
        message: "Usage: apps-self-host.ts [--package directory] [--publish]",
      });
    const registry = (yield* Config.String("EXECUTOR_NPM_REGISTRY")).replace(/\/+$/, "");
    const version = yield* stagedVersion(packageDirectory);
    if (packageIndex < 0 && version !== apps.version)
      return yield* new AppsReleaseMismatch({
        message: "Staged apps version differs from the host; rebuild apps first.",
      });
    const runtime = yield* fs
      .readFileString(path.join(packageDirectory, "runtime.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Runtime))));
    const reference = yield* fs
      .readFileString(path.join(packageDirectory, "framework-reference.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Reference))));
    if (runtime.version !== version || reference.version !== version)
      return yield* new AppsReleaseMismatch({
        message: "The advertised framework.release and staged SDK versions differ.",
      });
    // This check is deliberate, even for tarballs built before private publication was supported.
    // Never use --ignore-scripts to evade an old package's policy.
    const policy = yield* processes.exitCode(
      ChildProcess.make(
        "node",
        ["packages/apps/scripts/check-publish.mjs", "--package", path.resolve(packageDirectory)],
        {
          env: { npm_config_registry: registry, npm_config_tag: "beta" },
          extendEnv: true,
          stdout: "inherit",
          stderr: "inherit",
        },
      ),
    );
    if (policy !== 0)
      return yield* new AppsReleaseMismatch({
        message: "SDK publication policy refused the builder registry.",
      });

    const directory = yield* fs.makeTempDirectoryScoped();
    const local = yield* pack(path.resolve(packageDirectory), path.join(directory, "local"));
    const lookup = () => http.get(`${registry}/apps/${version}`);
    let response = yield* lookup();
    if (response.status === 404 && publish) {
      yield* response.text;
      // The private mode only publishes fork versions. Public release automation is separate.
      if (!/^0\.0\.\d+-beta\.\d+\.shuv\.\d+$/.test(version))
        return yield* new AppsReleaseMismatch({
          message: "Private publication requires a .shuv.M fork version.",
        });
      const code = yield* processes.exitCode(
        ChildProcess.make(
          "npm",
          ["publish", local.archive, "--registry", registry, "--tag", "beta"],
          { extendEnv: true, stdout: "inherit", stderr: "inherit" },
        ),
      );
      if (code !== 0)
        return yield* new AppsReleaseMismatch({
          message:
            "Private publication failed or has an unknown outcome. Inspect the registry before retrying.",
        });
      response = yield* lookup();
    }
    if (response.status !== 200) {
      yield* response.text;
      return yield* new AppsReleaseMismatch({
        message: `Builder registry does not serve apps@${version} (status ${response.status}). Deployment refused.`,
      });
    }
    const published = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Published)),
    );
    if (published.version !== version)
      return yield* new AppsReleaseMismatch({
        message: "Builder registry returned another SDK version.",
      });
    const registryOrigin = originOf(registry);
    const tarballOrigin = originOf(published.dist.tarball);
    if (registryOrigin === undefined || tarballOrigin !== registryOrigin)
      return yield* new AppsReleaseMismatch({
        message: `Builder registry metadata at ${registryOrigin ?? registry} serves its SDK tarball at ${published.dist.tarball} (${tarballOrigin ?? "not an absolute URL"}), outside the builder registry's origin. The builder refuses that tarball, so deployment is refused.`,
      });
    const archive = yield* downloadFromRegistry(published.dist.tarball, registryOrigin);
    if (archive.status !== 200) {
      yield* archive.text;
      return yield* new AppsReleaseMismatch({
        message: `Builder SDK tarball is unavailable (status ${archive.status}).`,
      });
    }
    const bytes = new Uint8Array(yield* archive.arrayBuffer);
    if (integrityOf(bytes) !== published.dist.integrity)
      return yield* new AppsReleaseMismatch({
        message: "Builder SDK tarball integrity differs from registry metadata.",
      });
    const downloaded = path.join(directory, "published.tgz");
    yield* fs.writeFile(downloaded, bytes);
    const differing = yield* differingFiles(
      yield* unpack(local.archive, path.join(directory, "staged")),
      yield* unpack(downloaded, path.join(directory, "published")),
    );
    if (differing.length)
      return yield* new AppsReleaseMismatch({
        message: `Builder SDK content differs from the host build. ${listFiles(differing)}`,
      });
    yield* Effect.log(
      `Builder registry serves matching apps@${version}; framework reference digest=${reference.digest}; integrity=${published.dist.integrity}`,
    );
  }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeServices.layer])),
);
