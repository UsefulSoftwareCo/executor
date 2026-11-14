/**
 * Which changed files a production deploy may depend on, so the Deploy workflow can skip a commit
 * that changes nothing production runs (`scripts/deploy-decision.ts`).
 *
 * The rule fails closed: every file is a deploy input except those under `notDeployInputs`, paths
 * no step of a deploy reads. A path nobody thought about deploys, so a forgotten input costs a
 * spare deploy, never a stale production. Deploy steps read files well outside the packages they
 * build: the framework reference reads a playground example, the docs import the release scripts
 * by relative path, Tailwind scans directories and Alchemy uploads asset directories.
 *
 * Each entry was checked two ways (notes/ci.md, "Deploy decision"). A trace of every file the
 * deploy's build opens (`strace` over setup's install, the framework and apps builds, the site
 * build and every Worker bundle, as `scripts/worker-builds.ts` builds them) opens nothing under
 * them but what `bun install` opens in a workspace package (see `workspaceInstallReads`). And no
 * deploy step reads them by name: no import, script argument, glob, `@source` or path outside them
 * points in. Add an entry only with the same evidence.
 *
 * The root manifest counts unless its only change is to `scripts` entries named `e2e:*`
 * (`rootManifestChangeIsE2eOnly`): no deploy step runs one, and the decision fails, so deploys, if
 * any other script's command names one (`scriptsNamingE2e`).
 */

/** Paths no step of a deploy reads, each with what the path holds. */
export const notDeployInputs: ReadonlyArray<{ readonly path: RegExp; readonly holds: string }> = [
  { path: /^e2e\//, holds: "the E2E suite and its tooling, which CI runs" },
  { path: /^notes\//, holds: "engineering notes" },
  {
    path: /^\.github\/workflows\/(?!deploy\.yml$)[^/]+$/,
    holds: "workflows other than Deploy, which calls no other workflow",
  },
  { path: /^[^/]+\.md$/, holds: "the repository's own documents" },
  {
    path: /^apps\/hosted\/testing\//,
    holds:
      "the test accounts, test server and Cloud devtools, which only a development stage's `Command.Dev` runs",
  },
];

/** One directory a root workspace pattern names, and what `bun install` runs there. */
export interface WorkspaceDirectory {
  /** The literal part of the pattern before any glob, ending in `/`. */
  readonly directory: string;
  /** Whether the pattern names this one package, so its manifest and root are known. */
  readonly exact: boolean;
  /** Whether its manifest declares a script `bun install` runs, or could not be read. */
  readonly installs: boolean;
}

/** The scripts `bun install` runs in a workspace package. */
export const installScripts = [
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
] as const;

/** The directories that root workspace patterns name, before reading their manifests. */
export const workspaceDirectories = (patterns: ReadonlyArray<string>) =>
  patterns.map((pattern) => {
    const glob = pattern.search(/[*?[{!]/);
    const literal = glob === -1 ? `${pattern.replace(/\/$/, "")}/` : pattern.slice(0, glob);
    return { directory: literal.replace(/^\.\//, ""), exact: glob === -1 };
  });

/**
 * Whether `bun install` reads `file`, which lies under a `notDeployInputs` entry, from a workspace
 * package: the build's trace shows it opening only a workspace package's manifest and checking its
 * root for `binding.gyp`. A package that runs install scripts, or one a glob names (whose root is not
 * known here), counts in full.
 */
const workspaceInstallReads = (file: string, workspaces: ReadonlyArray<WorkspaceDirectory>) =>
  workspaces.some(
    (workspace) =>
      file.startsWith(workspace.directory) &&
      (!workspace.exact || workspace.installs || file === `${workspace.directory}binding.gyp`),
  );

/**
 * Whether a deploy may depend on `file`, a path from the repository root: anything but a path in
 * `notDeployInputs`, and always a package manifest or a file `bun install` reads.
 */
export const isDeployInput = (file: string, workspaces: ReadonlyArray<WorkspaceDirectory>) =>
  /(^|\/)package\.json$/.test(file) ||
  !notDeployInputs.some((entry) => entry.path.test(file)) ||
  workspaceInstallReads(file, workspaces);

/** A script no deploy step runs: the E2E suite's commands. */
const isE2eScript = (name: string) => name.startsWith("e2e:");

/** The manifest with its `e2e:*` scripts left out, in its own key order. */
const withoutE2eScripts = (manifest: unknown) => {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest))
    return undefined;
  const scripts = (manifest as Record<string, unknown>).scripts;
  if (scripts === undefined) return JSON.stringify(manifest);
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return undefined;
  return JSON.stringify({
    ...manifest,
    scripts: Object.fromEntries(Object.entries(scripts).filter(([name]) => !isE2eScript(name))),
  });
};

/**
 * A manifest's value, only when it is the one reading of its text: parsed and printed back, it
 * equals the text with the whitespace outside strings removed. A duplicated key (`JSON.parse`
 * keeps the last copy, Bun the first), an escape the parser rewrites, a non-canonical number or a
 * key `JSON.stringify` reorders makes them differ, and then nothing is concluded from the manifest.
 */
export const readManifest = (text: string): unknown => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return text.replace(/("(?:[^"\\]|\\.)*")|\s+/g, "$1") === JSON.stringify(value)
    ? value
    : undefined;
};

/**
 * Whether the root manifest changed only in `scripts` entries named `e2e:*`, added, removed or
 * changed. Everything else is compared as written, key order included, and a manifest that
 * `readManifest` cannot read faithfully, at the base or the head, counts as a change.
 */
export const rootManifestChangeIsE2eOnly = (before: string, after: string) => {
  const [was, is] = [
    withoutE2eScripts(readManifest(before)),
    withoutE2eScripts(readManifest(after)),
  ];
  return was !== undefined && is !== undefined && was === is;
};

/**
 * The root scripts other than `e2e:*` whose command names an `e2e:*` script: a deploy step running
 * one would run that `e2e:*` script too, so its change would be a deploy input. The decision fails
 * while there is one.
 */
export const scriptsNamingE2e = (manifest: string) => {
  const scripts = (readManifest(manifest) as { scripts?: unknown } | undefined)?.scripts;
  if (typeof scripts !== "object" || scripts === null) return [];
  return Object.entries(scripts as Record<string, unknown>)
    .filter(([name, command]) => !isE2eScript(name) && String(command).includes("e2e:"))
    .map(([name]) => name);
};
