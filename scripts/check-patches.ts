/**
 * Every patch in package.json's `patchedDependencies` must be in node_modules. Bun applies a patch
 * only while its selector names an installed version, and an install with a stale selector still
 * exits 0, even with --frozen-lockfile. The package then runs unpatched.
 *
 * For each selector this fails unless the package is installed at exactly that version, and every
 * installed copy at that version holds the whole patch. Git decides that, not a parser here: in the
 * copy, the patch must reverse at exactly the lines its hunks name (`git apply --reverse --check`,
 * which writes nothing: no fuzz, and an offset counts as a failure) and must not apply forward. A
 * copy missing any hunk, created or deleted file, or rename does not reverse; a patch that changes
 * nothing also applies forward. Patches may change, create, delete and rename text files; anything
 * else (mode changes, copies, binary files) is rejected, as is a copy whose file mode differs from
 * the patch's. So is a patch Git cannot read exactly, such as a missing `\ No newline at end of
 * file`, even where Bun is lenient, and a file section Git skips.
 *
 * Before checking this repository it runs the same check on the fixtures in
 * check-patches-fixtures.ts, broken setups it must reject and applied ones it must accept.
 * Run after `bun install`; it reads Bun's isolated store, `node_modules/.bun`.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtures, type Fixture } from "./check-patches-fixtures.ts";

const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, ...inherited } = process.env;

/**
 * Git in `cwd` as a plain patch tool, outside any repository (node_modules is inside this one), with
 * no user config and English output.
 */
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
        // A number is Git's exit status; anything else means Git did not run.
        if (error !== null && typeof error.code !== "number") reject(error);
        else resolve({ ok: error === null, stdout, stderr });
      },
    ),
  );

/** Git's errors, on one line. */
const errors = (stderr: string) =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith("error: ") && !line.startsWith("error: while searching"))
    .map((line) => line.slice("error: ".length))
    .join("; ") || stderr.trim();

/**
 * `git apply --check` at exactly the lines each hunk names. Git reports an offset under -v, and
 * warns but succeeds when a file's mode differs from the patch's.
 */
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

/** A `---`/`+++` path without its first component (Git's -p1), or undefined for /dev/null. */
const headerPath = (line: string) => {
  const path = line.slice(4).replace(/\t.*$/, "");
  return path === "/dev/null" ? undefined : path.slice(path.indexOf("/") + 1);
};

/**
 * Every file section of a patch, with its line and the path Git names its change by (the new path;
 * the old one for a deletion). A section starts at `diff --git` or at a `---` line followed by
 * `+++` outside a hunk, whether or not Git would read it: Git skips a `---`/`+++` pair with no
 * hunk as garbage, which is what this has to catch. Hunks are skipped by their line counts, as Git
 * does, so a hunk line that looks like a header is not one.
 */
const sections = (patch: string) => {
  const lines = patch.split("\n").map((line) => line.replace(/\r$/, ""));
  const found: Array<{ line: number; path: string | undefined }> = [];
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
        index += 1;
      }
      found.push({ line, path: renamed ?? named ?? same });
      hunks();
    } else if (pair()) {
      found.push({ line, path: headerPath(lines[index + 1]!) ?? headerPath(lines[index]!) });
      index += 2;
      hunks();
    } else index += 1;
  }
  return found;
};

/** Why Git or this check refuses a patch, if it does. Reads only the patch; `cwd` is any directory. */
const refused = async (cwd: string, patch: string) => {
  // With -z, the numstat entries are NUL-terminated and the summary follows as text.
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
  // Git lists its changes in patch order. Each section must be exactly the change at its place, or
  // Git skipped it, however its paths read.
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

/** Why one installed copy does not hold the patch, if it doesn't. */
const notApplied = async (copy: string, patch: string) => {
  const reverse = await appliesExactly(copy, patch, true);
  if (!reverse.ok) return `not applied: ${reverse.reason}`;
  if ((await appliesExactly(copy, patch, false)).ok)
    return "applies forward too: it changes nothing";
  return undefined;
};

/** Every installed copy of a package in Bun's isolated store, with its version. */
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

/** What is wrong with one selector's patch in the project at `root`. */
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
        : [`${selector}: ${problem} in ${copy.directory.slice(root.length)}`];
    }),
  );
  return problems.flat();
};

/** What is wrong with the patches of the project at `root`, and how many there are. */
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

/** A fixture project: its manifest, patch and store. */
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
