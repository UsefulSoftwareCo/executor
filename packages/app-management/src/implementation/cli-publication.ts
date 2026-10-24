/** Copy a source commit between hosts, then publish with the destination's own sign-in. */
import { Console, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import {
  AppId,
  AppName,
  PackageName,
  Publication,
  SourceCommit,
  SourceError,
  packageLabel,
} from "@executor-js/sdk/core";
import { readCommitFiles } from "@executor-js/app-source/git-client";
import { SourceRejected } from "../client-error.ts";
import { connect, hostFailure, isTransportFailure } from "./cli-host.ts";
import { codeOnly, fitsRequest, pushSource, readSource, requestFiles } from "./cli-source.ts";
import { RegistryOrigin } from "./node-auth.ts";

export const RegistryPublication = Schema.Struct({
  registry: RegistryOrigin,
  app: AppId,
  publication: Publication,
});
const Manifest = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

export const publishToRegistry = (input: {
  readonly host: string;
  readonly organization: Option.Option<string>;
  readonly app: AppId;
  readonly commit: typeof SourceCommit.Type;
  readonly registry: string;
  readonly package: PackageName;
  readonly registryApp: Option.Option<AppId>;
}) =>
  Effect.gen(function* () {
    if (input.host === input.registry)
      return yield* new SourceRejected({
        reason: "invalid",
        detail: "Use publish without --registry to publish on the source host.",
        paths: [],
      });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Never resolve the destination from EXECUTOR_ACCESS_TOKEN or EXECUTOR_API_KEY: those
    // configure the source host. Its own saved sign-in also selects its organization.
    const destination = yield* connect(input.registry, Option.none(), "session");
    const source = yield* connect(input.host, input.organization);
    const remote = yield* source.management.git({
      params: { ...source.tenant, app: input.app },
    });
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-publish-" });
    yield* readCommitFiles({
      url: remote.url,
      authorization: `Bearer ${Redacted.value(source.token)}`,
      commit: input.commit,
      write: (file, bytes) =>
        Effect.gen(function* () {
          const target = path.join(directory, ...file.split("/"));
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.writeFile(target, bytes);
        }).pipe(Effect.mapError(() => new SourceError({ reason: "storage" }))),
    });
    const manifestPath = path.join(directory, "package.json");
    const manifest = yield* fs.readFileString(manifestPath).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Manifest)),
      Effect.mapError(
        () =>
          new SourceRejected({
            reason: "invalid",
            detail: "The selected source commit must contain a valid package.json object.",
            paths: ["package.json"],
          }),
      ),
    );
    yield* fs.writeFileString(
      manifestPath,
      `${JSON.stringify({ ...manifest, name: input.package }, null, 2)}\n`,
    );
    const files = yield* readSource(directory);
    const name = yield* Schema.decodeUnknownEffect(AppName)(packageLabel(input.package));
    const app = Option.isSome(input.registryApp)
      ? input.registryApp.value
      : (yield* destination.management.create({
          params: destination.tenant,
          payload: {
            name,
            files: yield* requestFiles(fitsRequest(files) ? files : codeOnly(files)),
          },
        })).id;
    return yield* Effect.gen(function* () {
      const working = yield* destination.management.source({
        params: { ...destination.tenant, app },
      });
      const commit =
        Option.isNone(input.registryApp) && fitsRequest(files)
          ? working.revision.commit
          : fitsRequest(files)
            ? (yield* destination.management.commit({
                params: { ...destination.tenant, app },
                payload: {
                  expected: working.revision.commit,
                  files: yield* requestFiles(files),
                  message: "Import source for publication",
                },
              })).revision.commit
            : (yield* pushSource({
                url: working.gitUrl,
                authorization: `Bearer ${Redacted.value(destination.token)}`,
                expected: working.revision.commit,
                remote: working.files,
                files,
                message: "Import source for publication",
              })).commit;
      const publication = yield* destination.management.publish({
        params: { ...destination.tenant, app },
        payload: { commit },
      });
      return { registry: input.registry, app, publication };
    }).pipe(
      Effect.onError(() =>
        Console.error(
          `The destination copy is ${app}. Retry with --registry-app ${app} to reuse it; its active version, accounts, and data were not changed.`,
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.catchIf(isTransportFailure, hostFailure));
