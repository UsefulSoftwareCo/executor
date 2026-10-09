/**
 * Pin existing apps to an explicit `apps` framework through ordinary source commits.
 * Nothing is redeployed: running deployments keep serving, and the next deploy of the working
 * source resolves the declared framework instead of whichever one the host then provides.
 */
import { Effect, Option, Schema } from "effect";
import {
  JsonObject,
  sourceFilesEqual,
  SourceFiles,
  type App,
  type Deployment,
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

const manifestOf = (files: SourceFiles) =>
  files.find((file) => file.path === "package.json")?.content;

/** Add `dependencies.apps`, keeping every other field, its order and the file's indentation. */
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

/** The host services the pin reads and writes through. */
export interface FrameworkPinHost {
  readonly executor: Executor;
}

/**
 * Where a working branch whose files differ from the running deployment stands.
 * - `behind`: main holds exactly the source of an earlier deployment that the running one replaced.
 *   Direct file deploys never write Git, so this is how they leave main.
 * - `unpublished`: the running source is in main's recent history and main has moved on from it.
 * - `diverged`: neither; main has work the running source lacks and the reverse may also hold.
 */
const workspacePosition = (
  host: FrameworkPinHost,
  app: App,
  workspace: SourceSnapshot,
  running: Deployment,
) =>
  Effect.gen(function* () {
    const target = { owner: app.owner, app: app.id };
    const replaced = (yield* host.executor.apps.deployments(target)).filter(
      (deployment) => deployment.createdAt.getTime() < running.createdAt.getTime(),
    );
    for (const deployment of replaced) {
      const source = yield* host.executor.apps.source({ ...target, deployment: deployment.id });
      if (sourceFilesEqual(workspace.files, source.files)) return "behind" as const;
    }
    const history = yield* host.executor.apps.history(target);
    if (running.sourceCommit !== null)
      return history.some((entry) => entry.commit === running.sourceCommit)
        ? ("unpublished" as const)
        : ("diverged" as const);
    // A direct file deploy has no commit; main may still have saved the same files earlier.
    for (const entry of history) {
      const saved = yield* host.executor.apps.revision({ ...target, commit: entry.commit });
      if (sourceFilesEqual(saved, running.files)) return "unpublished" as const;
    }
    return "diverged" as const;
  });

/** Replace or add `package.json`, keeping every other file. */
const withManifest = (files: SourceFiles, content: string) =>
  Schema.decodeUnknownEffect(SourceFiles)([
    ...files.filter((file) => file.path !== "package.json"),
    { path: "package.json", content },
  ]);

/**
 * Whether `workspace` is `running` with only a framework pin committed on top. Pinning is a
 * system edit, so callers that leave user edits alone can still treat such a workspace as untouched.
 */
export const pinnedOnly = (workspace: SourceFiles, running: SourceFiles): boolean => {
  if (sourceFilesEqual(workspace, running)) return true;
  const content = manifestOf(workspace);
  const rest = (files: SourceFiles) => files.filter((file) => file.path !== "package.json");
  const saved = new Map(rest(running).map((file) => [file.path, file.content]));
  const unchanged =
    rest(workspace).length === saved.size &&
    rest(workspace).every((file) => saved.get(file.path) === file.content);
  return (
    unchanged &&
    [frameworkPinRelease, frameworkPinCatchUpRelease].some((release) => {
      const manifest = pinManifest(manifestOf(running), release);
      return manifest.kind === "pin" && manifest.content === content;
    })
  );
};

/** A JSON value with object keys sorted, so equal documents compare equal whatever their key order. */
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

/**
 * Whether `workspace` is a framework pin commit on `deployed`, a deployment's source, and nothing
 * else. Member setup upgrades an untouched Executor app by deploying the host's template, which
 * never writes Git, so `main` keeps the pin these steps committed on the source it replaced: the
 * running source's own files, or, when `main` was behind, an earlier deployment's. Every file but
 * `package.json` must match `deployed` byte for byte. The manifests must be equal JSON once
 * `dependencies.apps` is removed from both, where `main` declares exactly a release these steps
 * write, and once `name` is removed from `deployed` where `main` has none, as the template only
 * named its package later. A source with no `package.json` matches only when `main` holds exactly
 * the manifest these steps write from nothing. Any other difference is someone's work.
 */
export const pinnedBeforeDeploy = (workspace: SourceFiles, deployed: SourceFiles): boolean => {
  const rest = (files: SourceFiles) => files.filter((file) => file.path !== "package.json");
  const kept = new Map(rest(deployed).map((file) => [file.path, file.content]));
  if (
    rest(workspace).length !== kept.size ||
    !rest(workspace).every((file) => kept.get(file.path) === file.content)
  )
    return false;
  // A source without a manifest gets the one the pin writes from nothing, byte for byte.
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

/**
 * Classify one app and, when applying, commit its pin on top of the revision that was read.
 * A working branch behind the running deployment receives the running source with the pin, so
 * the next deploy from main keeps what runs today. Every other position pins main's own files:
 * all existing source is written for the protocol-1 framework, and a manifest rolls nothing back.
 */
const pinApp = (host: FrameworkPinHost, release: string, listed: App, mode: DataStepMode) =>
  Effect.gen(function* () {
    const target = { owner: listed.owner, app: listed.id };
    const app = yield* host.executor.apps.get(target);
    const workspace = yield* host.executor.apps.workspace(target);
    const working = pinManifest(manifestOf(workspace.files), release);
    // Declared first: an applied pin is not deployed yet, so a repeat run still reads it as declared.
    if (working.kind === "declared") return "declared" as const;
    const running =
      app.activeDeployment === null ? undefined : yield* host.executor.apps.source(target);
    const position =
      running === undefined
        ? ("undeployed" as const)
        : sourceFilesEqual(workspace.files, running.files)
          ? ("current" as const)
          : yield* workspacePosition(host, app, workspace, running);
    const behind = position === "behind" && running !== undefined ? running : undefined;
    const manifest =
      behind === undefined ? working : pinManifest(manifestOf(behind.files), release);
    // The running source declares apps itself; main only needs that source, not a pin.
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
    // One unavailable repository must not stop the rest; the step retries it on a later pass.
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

/**
 * The data step that pins every app on this host, host-managed Executor apps included, to
 * `release`. Each app is safe to handle again: pinned apps read as declared,
 * and every commit names the revision it was based on, so a concurrent edit is a retried
 * conflict rather than an overwrite.
 */
export const frameworkPinStep = (
  host: FrameworkPinHost,
  name: string,
  release: string,
): DataStep<never> => ({
  name,
  retry: ["conflict", "failed"],
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
