import { Effect, Option, Schema } from "effect";
import {
  JsonObject,
  sourceFilesEqual,
  sourceText,
  SourceFiles,
  type App,
  type Version,
  type Executor,
  type SourceSnapshot,
} from "@executor-js/sdk/core";
import {
  frameworkPinBehindMessage,
  frameworkPinCatchUpRelease,
  frameworkPinMessage,
  frameworkPinRelease,
  type FrameworkPinOutcome,
} from "../contracts/framework-pin.ts";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";

type Manifest =
  | { readonly kind: "declared" }
  | { readonly kind: "invalid" }
  | { readonly kind: "pin"; readonly content: string };

const Dependencies = Schema.Record(Schema.String, Schema.String);

const manifestOf = (files: SourceFiles) => sourceText(files, "package.json");

const pinManifest = (content: string | undefined, apps: string): Manifest => {
  if (content === undefined)
    return { kind: "pin", content: `${JSON.stringify({ dependencies: { apps } }, null, 2)}\n` };
  const document = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject))(content);
  if (Option.isNone(document)) return { kind: "invalid" };
  const dependencies =
    document.value.dependencies === undefined
      ? Option.some({})
      : Schema.decodeUnknownOption(Dependencies)(document.value.dependencies);
  if (Option.isNone(dependencies)) return { kind: "invalid" };
  if (Object.hasOwn(dependencies.value, "apps")) return { kind: "declared" };
  const indent = /^[ \t]+(?=")/m.exec(content)?.[0] ?? 2;
  const pinned = JSON.stringify(
    { ...document.value, dependencies: { ...dependencies.value, apps } },
    null,
    indent,
  );
  return { kind: "pin", content: content.endsWith("\n") ? `${pinned}\n` : pinned };
};

export interface FrameworkPinHost {
  readonly executor: Executor;
}

const workspacePosition = (
  host: FrameworkPinHost,
  app: App,
  workspace: SourceSnapshot,
  running: Version,
) =>
  Effect.gen(function* () {
    const target = { owner: app.owner, app: app.id };
    const replaced = (yield* host.executor.apps.versions(target)).filter(
      (version) => version.createdAt.getTime() < running.createdAt.getTime(),
    );
    for (const version of replaced) {
      const source = yield* host.executor.apps.source({ ...target, version: version.id });
      if (sourceFilesEqual(workspace.files, source.files)) return "behind" as const;
    }
    const history = yield* host.executor.apps.history(target);
    if (running.sourceCommit !== null)
      return history.some((entry) => entry.commit === running.sourceCommit)
        ? ("unpublished" as const)
        : ("diverged" as const);
    for (const entry of history) {
      const saved = yield* host.executor.apps.revision({ ...target, commit: entry.commit });
      if (sourceFilesEqual(saved, running.files)) return "unpublished" as const;
    }
    return "diverged" as const;
  });

const withManifest = (files: SourceFiles, content: string) =>
  Schema.decodeUnknownEffect(SourceFiles)([
    ...files.filter((file) => file.path !== "package.json"),
    { path: "package.json", content },
  ]);

export const pinnedOnly = (workspace: SourceFiles, running: SourceFiles): boolean => {
  if (sourceFilesEqual(workspace, running)) return true;
  const content = manifestOf(workspace);
  const rest = (files: SourceFiles) => files.filter((file) => file.path !== "package.json");
  const unchanged = sourceFilesEqual(rest(workspace), rest(running));
  return (
    unchanged &&
    [frameworkPinRelease, frameworkPinCatchUpRelease].some((release) => {
      const manifest = pinManifest(manifestOf(running), release);
      return manifest.kind === "pin" && manifest.content === content;
    })
  );
};

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;

export const pinnedBeforeDeploy = (workspace: SourceFiles, deployed: SourceFiles): boolean => {
  const rest = (files: SourceFiles) => files.filter((file) => file.path !== "package.json");
  if (!sourceFilesEqual(rest(workspace), rest(deployed))) return false;
  if (manifestOf(deployed) === undefined)
    return [frameworkPinRelease, frameworkPinCatchUpRelease].some((release) => {
      const created = pinManifest(undefined, release);
      return created.kind === "pin" && manifestOf(workspace) === created.content;
    });
  const decode = (files: SourceFiles) =>
    Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject))(manifestOf(files));
  const saved = decode(workspace);
  const current = decode(deployed);
  if (Option.isNone(saved) || Option.isNone(current)) return false;
  const savedDependencies = Schema.decodeUnknownOption(Dependencies)(saved.value.dependencies);
  const currentDependencies = Schema.decodeUnknownOption(Dependencies)(current.value.dependencies);
  if (Option.isNone(savedDependencies) || Option.isNone(currentDependencies)) return false;
  const pin = savedDependencies.value.apps;
  if (pin !== frameworkPinRelease && pin !== frameworkPinCatchUpRelease) return false;
  const unpinned = (
    manifest: typeof saved.value,
    dependencies: Readonly<Record<string, string>>,
    dropName: boolean,
  ) => {
    const { apps: _apps, ...others } = dependencies;
    const { name: _name, ...fields } = manifest;
    return canonical({ ...(dropName ? fields : manifest), dependencies: others });
  };
  const named = Object.hasOwn(saved.value, "name");
  return (
    JSON.stringify(unpinned(saved.value, savedDependencies.value, false)) ===
    JSON.stringify(unpinned(current.value, currentDependencies.value, !named))
  );
};

const pinApp = (host: FrameworkPinHost, release: string, listed: App, mode: DataStepMode) =>
  Effect.gen(function* () {
    const target = { owner: listed.owner, app: listed.id };
    const app = yield* host.executor.apps.get(target);
    const workspace = yield* host.executor.apps.workspace(target);
    const working = pinManifest(manifestOf(workspace.files), release);
    if (working.kind === "declared") return "declared" as const;
    const running =
      app.activeVersion === null ? undefined : yield* host.executor.apps.source(target);
    const position =
      running === undefined
        ? ("undeployed" as const)
        : sourceFilesEqual(workspace.files, running.files)
          ? ("current" as const)
          : yield* workspacePosition(host, app, workspace, running);
    const behind = position === "behind" && running !== undefined ? running : undefined;
    const manifest =
      behind === undefined ? working : pinManifest(manifestOf(behind.files), release);
    if (manifest.kind === "declared") return "declared" as const;
    if (manifest.kind === "invalid") return "invalid-manifest" as const;
    if (mode === "report") return reported[position];
    const files = yield* withManifest((behind ?? workspace).files, manifest.content);
    return yield* host.executor.apps
      .commit({
        ...target,
        expected: workspace.revision.commit,
        files,
        message:
          behind === undefined ? frameworkPinMessage(release) : frameworkPinBehindMessage(release),
      })
      .pipe(
        Effect.as(applied[position]),
        Effect.catchTag("SourceError", (error) =>
          error.reason === "conflict" ? Effect.succeed("conflict" as const) : Effect.fail(error),
        ),
      );
  }).pipe(
    Effect.catchTag("AppNotFound", () => Effect.succeed("removed" as const)),
    Effect.tap((outcome) => Effect.annotateCurrentSpan("apps.framework_pin.outcome", outcome)),
    Effect.catch((error) =>
      Effect.logWarning("App framework pin failed", listed.id, error).pipe(
        Effect.as("failed" as const),
      ),
    ),
    Effect.map((outcome): FrameworkPinOutcome => outcome),
    Effect.withSpan("apps.framework_pin.app", {
      attributes: { "app.id": listed.id, "apps.framework_pin.mode": mode },
    }),
  );

const reported = {
  current: "pin",
  behind: "pin-behind",
  unpublished: "pin-unpublished",
  diverged: "pin-diverged",
  undeployed: "pin-undeployed",
} as const;
const applied = {
  current: "pinned",
  behind: "pinned-behind",
  unpublished: "pinned-unpublished",
  diverged: "pinned-diverged",
  undeployed: "pinned-undeployed",
} as const;

export const frameworkPinStep = (
  host: FrameworkPinHost,
  name: string,
  release: string,
): DataStep<never> => ({
  name,
  retry: ["conflict", "failed"],
  expected: ["conflict"],
  items: host.executor.apps.list({}).pipe(
    Effect.map((apps) =>
      apps.map((app) => ({
        id: app.id,
        owner: app.owner,
        run: (mode: DataStepMode) => pinApp(host, release, app, mode),
      })),
    ),
  ),
});
