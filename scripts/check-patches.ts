import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative as relative_ } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtures, type Fixture } from "./check-patches-fixtures.ts";

const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, ...inherited } = process.env;

const git = (cwd: string, args: ReadonlyArray<string>) =>
  new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve, reject) =>
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        env: {
          ...inherited,
          LC_ALL: "C",
          GIT_CEILING_DIRECTORIES: dirname(cwd),
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") reject(error);
        else resolve({ ok: error === null, stdout, stderr });
      },
    ),
  );

const errors = (stderr: string) =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith("error: ") && !line.startsWith("error: while searching"))
    .map((line) => line.slice("error: ".length))
    .join("; ") || stderr.trim();

const appliesExactly = async (directory: string, patch: string, reverse: boolean) => {
  const result = await git(directory, [
    "apply",
    "--check",
    "--verbose",
    "--whitespace=nowarn",
    ...(reverse ? ["--reverse"] : []),
    patch,
  ]);
  const offset = /^Hunk #\d+ succeeded at .*\(offset .*$/m.exec(result.stderr);
  const warning = /^warning: (.*)$/m.exec(result.stderr);
  if (!result.ok) return { ok: false, reason: errors(result.stderr) } as const;
  if (offset !== null) return { ok: false, reason: `${offset[0]} (must be exact)` } as const;
  if (warning !== null) return { ok: false, reason: warning[1]! } as const;
  return { ok: true } as const;
};

const headerPath = (line: string) => {
  const path = line.slice(4).replace(/\t.*$/, "");
  return path === "/dev/null" ? undefined : path.slice(path.indexOf("/") + 1);
};

const sections = (patch: string) => {
  const lines = patch.split("\n").map((line) => line.replace(/\r$/, ""));
  const found: Array<{ line: number; path: string | undefined; mode?: string }> = [];
  let index = 0;
  const hunks = () => {
    for (;;) {
      const range = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[index] ?? "");
      if (range === null) return;
      let old = Number(range[1] ?? 1);
      let added = Number(range[2] ?? 1);
      index += 1;
      while (index < lines.length && (old > 0 || added > 0)) {
        const kind = lines[index]![0];
        if (kind === " " || kind === undefined) [old, added] = [old - 1, added - 1];
        else if (kind === "-") old -= 1;
        else if (kind === "+") added -= 1;
        else if (kind !== "\\") break;
        index += 1;
      }
      while (lines[index]?.startsWith("\\")) index += 1;
    }
  };
  const pair = () => lines[index]!.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ");
  while (index < lines.length) {
    const line = index + 1;
    if (lines[index]!.startsWith("diff --git ")) {
      const same = /^diff --git a\/(.+) b\/\1$/.exec(lines[index]!)?.[1];
      let renamed: string | undefined;
      let named: string | undefined;
      let mode: string | undefined;
      index += 1;
      while (
        index < lines.length &&
        !lines[index]!.startsWith("diff --git ") &&
        !lines[index]!.startsWith("@@ ")
      ) {
        if (pair()) {
          named = headerPath(lines[index + 1]!) ?? headerPath(lines[index]!);
          index += 2;
          break;
        }
        renamed = /^(?:rename|copy) to (.*)$/.exec(lines[index]!)?.[1] ?? renamed;
        mode =
          /^(?:index [0-9a-f]+\.\.[0-9a-f]+|new file mode) (\d{6})$/.exec(lines[index]!)?.[1] ??
          mode;
        index += 1;
      }
      found.push({ line, path: renamed ?? named ?? same, mode });
      hunks();
    } else if (pair()) {
      found.push({ line, path: headerPath(lines[index + 1]!) ?? headerPath(lines[index]!) });
      index += 2;
      hunks();
    } else index += 1;
  }
  return found;
};

const refused = async (cwd: string, patch: string) => {
  const result = await git(cwd, ["apply", "--numstat", "--summary", "-z", patch]);
  if (!result.ok) return errors(result.stderr);
  const fields = result.stdout.split("\0");
  const unsupported = fields
    .at(-1)!
    .split("\n")
    .filter((line) => /mode change|^ copy /.test(line))
    .map((line) => line.trim());
  if (unsupported.length > 0) return `unsupported change: ${unsupported.join("; ")}`;
  const paths: Array<string> = [];
  for (const field of fields.slice(0, -1)) {
    const entry = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(field);
    if (entry === null) return `unexpected numstat entry: ${field}`;
    if (entry[1] === "-") return `binary change to ${entry[3]} is unsupported`;
    paths.push(entry[3]!);
  }
  if (paths.length === 0) return "changes no file";
  const found = sections(readFileSync(patch, "utf8"));
  for (const [index, section] of found.entries()) {
    if (section.path === undefined) return `cannot read the section header at line ${section.line}`;
    if (paths[index] !== section.path)
      return `the section for ${section.path} at line ${section.line} is not a change Git applies`;
  }
  if (paths.length > found.length)
    return `Git found ${paths.length} changes in ${found.length} sections`;
  return undefined;
};

const gitMode = (file: string) => {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink()) return "120000";
  return (stat.mode & 0o100) === 0 ? "100644" : "100755";
};

const notApplied = async (copy: string, patch: string) => {
  const reverse = await appliesExactly(copy, patch, true);
  if (!reverse.ok) return `not applied: ${reverse.reason}`;
  for (const section of sections(readFileSync(patch, "utf8"))) {
    if (section.path === undefined || section.mode === undefined) continue;
    const mode = gitMode(join(copy, section.path));
    if (mode !== undefined && mode !== section.mode)
      return `not applied: ${section.path} has type ${mode}, expected ${section.mode}`;
  }
  if ((await appliesExactly(copy, patch, false)).ok)
    return "applies forward too: it changes nothing";
  return undefined;
};

const reachableStoreFolders = async (root: string, store: string) => {
  const real = realpathSync(store);
  const listed = await git(root, ["ls-files", "-z", "--", "package.json", "**/package.json"]);
  const packages = listed.ok ? listed.stdout.split("\0").filter(Boolean).map(dirname) : ["."];
  const pending = packages.map((directory) => join(root, directory, "node_modules"));
  const reached = new Set<string>();
  while (pending.length > 0) {
    const directory = pending.pop()!;
    if (!existsSync(directory)) continue;
    const links = readdirSync(directory).flatMap((child) =>
      child.startsWith("@")
        ? readdirSync(join(directory, child)).map((scoped) => join(directory, child, scoped))
        : [join(directory, child)],
    );
    for (const link of links) {
      if (!lstatSync(link).isSymbolicLink()) continue;
      let resolved: string;
      try {
        resolved = realpathSync(link);
      } catch {
        continue;
      }
      if (!resolved.startsWith(real + "/")) continue;
      const folder = resolved.slice(real.length + 1).split("/")[0]!;
      if (reached.has(folder)) continue;
      reached.add(folder);
      pending.push(join(store, folder, "node_modules"));
    }
  }
  return reached;
};

const reachable = new Map<string, Promise<Set<string>>>();

const notAppliedHint = async (
  root: string,
  store: string,
  copy: string,
  others: ReadonlyArray<string>,
  name: string,
  version: string,
  patch: string,
) => {
  const folder = dirname(dirname(name.includes("/") ? dirname(copy) : copy));
  const relative = relative_(root, folder);
  const relink = `rm -rf '${relative}' && bun install`;
  if (others.length > 0) {
    let reached = reachable.get(root);
    if (reached === undefined) reachable.set(root, (reached = reachableStoreFolders(root, store)));
    if (!(await reached).has(relative_(store, folder)))
      return `. This workspace has ${others.length + 1} store folders for ${name}@${version}, and following links from its node_modules never reaches this one: it is left over from an earlier install, and nothing uses it. Repair: rm -rf '${relative}'`;
  }
  const manifest = lstatSync(join(copy, "package.json"));
  if (manifest.nlink < 2) return "";
  const cache = process.env.BUN_INSTALL_CACHE_DIR ?? join(homedir(), ".bun", "install", "cache");
  const parent = join(cache, dirname(name));
  const prefix = `${name.slice(name.lastIndexOf("/") + 1)}@${version}@@@`;
  const entry = (existsSync(parent) ? readdirSync(parent) : [])
    .filter((candidate) => candidate.startsWith(prefix))
    .map((candidate) => join(parent, candidate))
    .find(
      (candidate) =>
        lstatSync(join(candidate, "package.json"), { throwIfNoEntry: false })?.ino === manifest.ino,
    );
  if (entry === undefined)
    return `. Its files are hard links (${manifest.nlink} to package.json), but no entry in ${cache} holds them: the entry was removed or rebuilt after this copy was linked. Repair: ${relink}`;
  if ((await notApplied(entry, patch)) === undefined)
    return `. It is hard-linked to Bun's cache entry ${entry}, which holds the patch, so some of this copy's files were replaced after Bun linked it. Repair: ${relink}`;
  return `. It is hard-linked to Bun's cache entry ${entry}, which does not hold the patch either, and \`bun install --force\` links that entry again. Either the entry was changed through its hard links after Bun built it (an edit in some workspace's node_modules made without \`bun patch\` first; every workspace linking it fails the same way), or Bun applies ${relative_(root, patch)} in a way Git does not reverse exactly (the patch file is at fault; a rebuilt entry fails the same way). To tell them apart, move the entry aside and run \`bun install\` and this check in a new workspace: if that passes, the entry had been changed, so delete it and run ${relink} here and in each workspace linking it; if it fails the same way, fix the patch, for example with \`bun patch ${name}@${version}\` and \`bun patch --commit\``;
};

const copies = (store: string, name: string) => {
  const prefix = `${name.replace("/", "+")}@`;
  return readdirSync(store)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(store, entry, "node_modules", name))
    .filter((directory) => existsSync(join(directory, "package.json")))
    .map((directory) => {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      return { directory, name: manifest.name, version: manifest.version };
    })
    .filter((copy) => copy.name === name);
};

const checkPatch = async (
  root: string,
  store: string,
  selector: string,
  patch: string,
): Promise<ReadonlyArray<string>> => {
  const at = selector.lastIndexOf("@");
  const name = selector.slice(0, at);
  const version = selector.slice(at + 1);
  if (at <= 0 || version === "") return [`${selector}: not a name@version selector`];
  const file = join(root, patch);
  if (!existsSync(file)) return [`${selector}: ${patch} does not exist`];
  const refusal = await refused(store, file);
  if (refusal !== undefined) return [`${selector}: ${patch}: ${refusal}`];
  const installed = copies(store, name);
  const matching = installed.filter((copy) => copy.version === version);
  if (matching.length === 0) {
    const versions = [...new Set(installed.map((copy) => copy.version))].sort();
    return [
      `${selector}: no installed copy has this version (installed: ${versions.join(", ") || "none"}). Bun skipped ${patch}; move the selector and the patch to the installed version, or remove both.`,
    ];
  }
  const problems = await Promise.all(
    matching.map(async (copy) => {
      const problem = await notApplied(copy.directory, file);
      return problem === undefined
        ? []
        : [
            `${selector}: ${problem} in ${copy.directory.slice(root.length)}${
              problem.startsWith("not applied")
                ? await notAppliedHint(
                    root,
                    store,
                    copy.directory,
                    matching.filter((other) => other !== copy).map((other) => other.directory),
                    name,
                    version,
                    file,
                  )
                : ""
            }`,
          ];
    }),
  );
  return problems.flat();
};

const check = async (root: string) => {
  const store = join(root, "node_modules", ".bun");
  if (!existsSync(store))
    return { checked: 0, problems: [`No Bun isolated store at ${store}. Run \`bun install\`.`] };
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    patchedDependencies?: Record<string, string>;
  };
  const selectors = Object.entries(manifest.patchedDependencies ?? {});
  const problems = await Promise.all(
    selectors.map(([selector, patch]) => checkPatch(root, store, selector, patch)),
  );
  return { checked: selectors.length, problems: problems.flat() };
};

const build = (fixture: Fixture) => {
  const root = mkdtempSync(join(tmpdir(), "patch-fixture-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ patchedDependencies: { [fixture.selector ?? "fixture@1.0.0"]: "fix.patch" } }),
  );
  writeFileSync(join(root, "fix.patch"), fixture.patch);
  mkdirSync(join(root, "node_modules", ".bun"), { recursive: true });
  for (const [entry, files] of Object.entries(fixture.installed)) {
    const directory = join(root, "node_modules", ".bun", entry, "node_modules", "fixture");
    const version = entry.slice("fixture@".length).split("_")[0];
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fixture", version }));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), content);
    }
  }
  return root;
};

const wrong = await Promise.all(
  fixtures.map(async (fixture) => {
    const root = build(fixture);
    try {
      const { problems } = await check(root);
      return fixture.applied === (problems.length === 0)
        ? []
        : [
            `${fixture.name}: expected ${fixture.applied ? "accepted" : "rejected"}, got ${problems.length === 0 ? "accepted" : problems.join("; ")}`,
          ];
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }),
);
if (wrong.flat().length > 0) {
  console.error(
    "The patch check is wrong about these fixtures (scripts/check-patches-fixtures.ts):",
  );
  for (const problem of wrong.flat()) console.error(`  ${problem}`);
  process.exit(1);
}

const { checked, problems } = await check(fileURLToPath(new URL("..", import.meta.url)));
if (problems.length > 0) {
  console.error("Dependency patches that are not in node_modules:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
const rejected = fixtures.filter((fixture) => !fixture.applied).length;
console.log(
  `All ${checked} dependency patches are applied (the check rejects ${rejected} broken fixtures and accepts ${fixtures.length - rejected}).`,
);
