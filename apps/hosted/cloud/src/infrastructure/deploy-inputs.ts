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
 * them except a workspace package's, which `workspacePackageUnder` excludes. And no deploy step
 * reads them by name: no import, script argument, glob, `@source` or path outside them points in.
 * Add an entry only with the same evidence.
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
];

/**
 * The directories that root workspace patterns name, as the literal part before any glob: `bun
 * install` reads each workspace package's manifest and checks its directory for native build files,
 * so a workspace package is a deploy input wherever it lives. `e2e/viewer` is one.
 */
export const workspaceDirectories = (patterns: ReadonlyArray<string>) =>
  patterns.map((pattern) => {
    const glob = pattern.search(/[*?[{!]/);
    const literal = glob === -1 ? `${pattern.replace(/\/$/, "")}/` : pattern.slice(0, glob);
    return literal.replace(/^\.\//, "");
  });

/** Whether `file` lies in a directory a root workspace pattern names. */
const workspacePackageUnder = (file: string, workspaces: ReadonlyArray<string>) =>
  workspaces.some((directory) => file.startsWith(directory));

/**
 * Whether a deploy may depend on `file`, a path from the repository root: anything but a path in
 * `notDeployInputs`, and always a package manifest or a file of a workspace package.
 */
export const isDeployInput = (file: string, workspaces: ReadonlyArray<string>) =>
  /(^|\/)package\.json$/.test(file) ||
  workspacePackageUnder(file, workspaces) ||
  !notDeployInputs.some((entry) => entry.path.test(file));
