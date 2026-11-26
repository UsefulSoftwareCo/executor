import {
  JsonObject,
  sourceFilesEqual,
  sourceText,
  SourceFiles,
  type App,
  type VersionId,
  type Executor,
  type StorageError,
} from "@executor-js/sdk/core";
import { Array as Arr, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";
import { pinnedBeforeDeploy } from "./framework-pin.ts";
import {
  executorAppRedeployFixedRelease,
  executorAppRedeployMessage,
  executorAppRedeployTargetRelease,
  type ExecutorAppRedeployOutcome,
} from "../contracts/executor-app-redeploy.ts";

export interface ExecutorAppRedeployHost {
  readonly executor: Executor;
  readonly executorAppRedeployed?: (
    app: App,
    replaced: VersionId,
    version: VersionId,
  ) => Effect.Effect<void, StorageError, SqlClient.SqlClient>;
}

const exactVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

const compareReleases = (left: string, right: string): number | undefined => {
  const parse = (version: string) => {
    const match = exactVersion.exec(version);
    if (match === null) return undefined;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? [] : match[4].split("."),
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (a === undefined || b === undefined) return undefined;
  for (let index = 0; index < 3; index++) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  const numeric = /^\d+$/;
  for (let index = 0; index < Math.min(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index] ?? "";
    const y = b.pre[index] ?? "";
    if (x === y) continue;
    if (numeric.test(x) && numeric.test(y)) return Number(x) - Number(y);
    if (numeric.test(x)) return -1;
    if (numeric.test(y)) return 1;
    return x < y ? -1 : 1;
  }
  return a.pre.length - b.pre.length;
};

const Manifest = Schema.fromJsonString(JsonObject);
const Dependencies = Schema.Record(Schema.String, Schema.Unknown);

const manifestOf = (files: SourceFiles) => {
  const content = sourceText(files, "package.json");
  if (content === undefined) return undefined;
  const manifest = Schema.decodeUnknownOption(Manifest)(content);
  if (Option.isNone(manifest)) return undefined;
  const dependencies = Schema.decodeUnknownOption(Dependencies)(manifest.value.dependencies);
  if (Option.isNone(dependencies)) return undefined;
  return { content, manifest: manifest.value, dependencies: dependencies.value };
};

const pinnedRelease = (files: SourceFiles) => {
  const apps = manifestOf(files)?.dependencies.apps;
  return typeof apps === "string" && exactVersion.test(apps) ? apps : undefined;
};

const repinned = (files: SourceFiles, from: string, to: string) => {
  const read = manifestOf(files);
  if (read === undefined) return files;
  const updated = { ...read.manifest, dependencies: { ...read.dependencies, apps: to } };
  const escaped = from.replaceAll(".", "\\.").replaceAll("+", "\\+");
  const declaration = new RegExp(`("apps"\\s*:\\s*)"${escaped}"`, "g");
  const replaced = read.content.replace(declaration, `$1${JSON.stringify(to)}`);
  const exact =
    (read.content.match(declaration)?.length ?? 0) === 1 &&
    Option.match(Schema.decodeUnknownOption(Manifest)(replaced), {
      onNone: () => false,
      onSome: (value) => JSON.stringify(value) === JSON.stringify(updated),
    });
  const indent = /^[ \t]+(?=")/m.exec(read.content)?.[0] ?? 2;
  const rewritten = JSON.stringify(updated, null, indent);
  const content = exact ? replaced : read.content.endsWith("\n") ? `${rewritten}\n` : rewritten;
  return SourceFiles.make(
    Arr.map(files, (file) => (file.path === "package.json" ? { ...file, content } : file)),
  );
};

const executorShaped = (app: App) => {
  const slots = Object.values(app.requirements.accounts);
  return slots.length === 1 && slots[0]?.definition.name === "Executor";
};

const redeployApp = (host: ExecutorAppRedeployHost, listed: App, mode: DataStepMode) =>
  Effect.gen(function* () {
    const target = { owner: listed.owner, app: listed.id };
    const app = yield* host.executor.apps.get(target);
    if (app.activeVersion === null) return "undeployed" as const;
    const running = yield* host.executor.apps.source(target);
    if (running.id !== app.activeVersion) return "conflict" as const;
    const pin = pinnedRelease(running.files);
    if (pin === undefined) return "other-pin" as const;
    const order = compareReleases(pin, executorAppRedeployFixedRelease);
    if (order === undefined || order >= 0) return "current" as const;
    const next = repinned(running.files, pin, executorAppRedeployTargetRelease);

    const workspace = yield* host.executor.apps.workspace(target);
    const settled =
      sourceFilesEqual(workspace.files, running.files) || sourceFilesEqual(workspace.files, next);
    const pinned = !settled && pinnedBeforeDeploy(workspace.files, running.files);
    const behind =
      settled || pinned
        ? undefined
        : yield* Effect.gen(function* () {
            const replaced = (yield* host.executor.apps.versions(target)).filter(
              (version) => version.createdAt.getTime() < running.createdAt.getTime(),
            );
            const sources = yield* Effect.forEach(replaced, (version) =>
              host.executor.apps.source({ ...target, version: version.id }),
            );
            if (sources.some((source) => sourceFilesEqual(workspace.files, source.files)))
              return "exact" as const;
            if (sources.some((source) => pinnedBeforeDeploy(workspace.files, source.files)))
              return "pinned" as const;
            return undefined;
          });
    if (!settled && !pinned && behind === undefined) return "edited" as const;
    if (mode === "report")
      return behind === "exact"
        ? ("redeploy-behind" as const)
        : behind === "pinned"
          ? ("redeploy-behind-pinned" as const)
          : pinned
            ? ("redeploy-pinned" as const)
            : ("redeploy" as const);

    const deployed = yield* host.executor.apps.deploy({ ...target, files: next }).pipe(
      Effect.map((result) => result.app),
      Effect.catchTag("VersionBuildFailed", (error) =>
        Effect.logWarning(
          "Executor app does not build on the target release",
          listed.id,
          error,
        ).pipe(Effect.as(undefined)),
      ),
    );
    if (deployed === undefined) return "build-failed" as const;
    if (host.executorAppRedeployed !== undefined)
      yield* host.executorAppRedeployed(deployed, running.id, deployed.activeVersion);
    if (!sourceFilesEqual(workspace.files, next))
      yield* host.executor.apps
        .commit({
          ...target,
          expected: workspace.revision.commit,
          files: next,
          message: executorAppRedeployMessage(pin, executorAppRedeployTargetRelease),
        })
        .pipe(
          Effect.catchTag("SourceError", (error) =>
            error.reason === "conflict"
              ? Effect.logWarning("Executor app main changed during its redeploy", listed.id)
              : Effect.fail(error),
          ),
        );
    return behind === "exact"
      ? ("redeployed-behind" as const)
      : behind === "pinned"
        ? ("redeployed-behind-pinned" as const)
        : pinned
          ? ("redeployed-pinned" as const)
          : ("redeployed" as const);
  }).pipe(
    Effect.catchTag("AppNotFound", () => Effect.succeed("removed" as const)),
    Effect.tap((outcome) => Effect.annotateCurrentSpan("apps.executor_redeploy.outcome", outcome)),
    Effect.catch((error) =>
      Effect.logWarning("Executor app redeploy failed", listed.id, error).pipe(
        Effect.as("failed" as const),
      ),
    ),
    Effect.map((outcome): ExecutorAppRedeployOutcome => outcome),
    Effect.withSpan("apps.executor_redeploy.app", {
      attributes: { "app.id": listed.id, "apps.executor_redeploy.mode": mode },
    }),
  );

export const executorAppRedeployStep = (
  host: ExecutorAppRedeployHost,
  name: string,
): DataStep<SqlClient.SqlClient> => ({
  name,
  retry: ["conflict", "failed"],
  expected: ["conflict"],
  items: host.executor.apps.list({}).pipe(
    Effect.map((apps) =>
      apps.filter(executorShaped).map((app) => ({
        id: app.id,
        owner: app.owner,
        run: (mode: DataStepMode) => redeployApp(host, app, mode),
      })),
    ),
  ),
});
