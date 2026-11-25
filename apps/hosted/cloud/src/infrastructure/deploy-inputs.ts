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

export interface WorkspaceDirectory {
  readonly directory: string;
  readonly exact: boolean;
  readonly installs: boolean;
}

export const installScripts = [
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
] as const;

export const workspaceDirectories = (patterns: ReadonlyArray<string>) =>
  patterns.map((pattern) => {
    const glob = pattern.search(/[*?[{!]/);
    const literal = glob === -1 ? `${pattern.replace(/\/$/, "")}/` : pattern.slice(0, glob);
    return { directory: literal.replace(/^\.\//, ""), exact: glob === -1 };
  });

const workspaceInstallReads = (file: string, workspaces: ReadonlyArray<WorkspaceDirectory>) =>
  workspaces.some(
    (workspace) =>
      file.startsWith(workspace.directory) &&
      (!workspace.exact || workspace.installs || file === `${workspace.directory}binding.gyp`),
  );

export const isDeployInput = (file: string, workspaces: ReadonlyArray<WorkspaceDirectory>) =>
  /(^|\/)package\.json$/.test(file) ||
  !notDeployInputs.some((entry) => entry.path.test(file)) ||
  workspaceInstallReads(file, workspaces);

const isE2eScript = (name: string) => name.startsWith("e2e:");

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

export const rootManifestChangeIsE2eOnly = (before: string, after: string) => {
  const [was, is] = [
    withoutE2eScripts(readManifest(before)),
    withoutE2eScripts(readManifest(after)),
  ];
  return was !== undefined && is !== undefined && was === is;
};

export const scriptsNamingE2e = (manifest: string) => {
  const scripts = (readManifest(manifest) as { scripts?: unknown } | undefined)?.scripts;
  if (typeof scripts !== "object" || scripts === null) return [];
  return Object.entries(scripts as Record<string, unknown>)
    .filter(([name, command]) => !isE2eScript(name) && String(command).includes("e2e:"))
    .map(([name]) => name);
};
