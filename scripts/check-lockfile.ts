/**
 * Whether bun.lock is what `bun install` writes for the tracked package.json files.
 *
 * `bun install --frozen-lockfile`, which the setup action runs, accepts a lock that records an old
 * version of a workspace package: it fails only when a dependency would resolve differently. So a
 * pull request that bumps a workspace package's own version (the `apps` bump that
 * `scripts/releases/apps-bumped.ts` requires, for one) without running `bun install` merges a
 * stale lock, and the next `bun install` in every fresh checkout rewrites it.
 *
 * Each checkout is checked by running `bun install --lockfile-only` in it and comparing the lock
 * it writes with the committed one. That resolves from the lock and the installed packages,
 * without the registry, when every dependency is already locked. The committed lock is put back
 * afterwards, so the check never edits a checkout.
 *
 * - `node scripts/check-lockfile.ts` fails when this checkout's lock is stale.
 * - `node scripts/check-lockfile.ts --base <checkout>` is the pull request check. The
 *   `apps-version` job runs it against a checkout of where the pull request meets main: the merge
 *   commit's first parent for a pull request into main, and the merge base with main for an upper
 *   stack layer, so a lower layer's drift counts and main's older drift does not. The base needs no
 *   node_modules. It fails only on drift the pull request adds: when the pull request changes a
 *   package.json or bun.lock, and the lines an install would change here are not all lines it
 *   would change in the base too. A lock that went
 *   stale on main, through a pull request that passed before this check existed or before main
 *   moved, therefore fails no other pull request; the beta workflow refreshes it on main
 *   (`scripts/releases/lock-repair.sh`).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fix = "Run `bun install` and commit bun.lock.";

/** The diff from the committed lock in `checkout` to the one `bun install` writes there. */
const drift = (checkout: string) => {
  const lockfile = join(checkout, "bun.lock");
  const committed = readFileSync(lockfile, "utf8");
  const install = spawnSync("bun", ["install", "--lockfile-only"], {
    cwd: checkout,
    encoding: "utf8",
  });
  const written = readFileSync(lockfile, "utf8");
  if (written !== committed) writeFileSync(lockfile, committed);
  if (install.status !== 0) {
    process.stderr.write(install.stdout + install.stderr);
    console.error(
      `::error::\`bun install --lockfile-only\` failed in ${checkout}, so bun.lock could not be checked.`,
    );
    process.exit(1);
  }
  if (written === committed) return [];
  const directory = mkdtempSync(join(tmpdir(), "check-lockfile-"));
  try {
    const after = join(directory, "bun.lock");
    writeFileSync(after, written);
    // `git diff --no-index` exits 1 when the files differ.
    const result = spawnSync("git", ["diff", "--no-index", "--no-color", lockfile, after], {
      encoding: "utf8",
    });
    return result.stdout.split("\n").slice(4).filter(Boolean);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/** Changed lines of a diff, each with its `-` or `+`. */
const changed = (diff: ReadonlyArray<string>) =>
  diff.filter((line) => /^[-+]/.test(line) && !/^(---|\+\+\+) /.test(line));

const show = (lines: ReadonlyArray<string>) => {
  const shown = 40;
  console.error(lines.slice(0, shown).join("\n"));
  if (lines.length > shown) console.error(`… ${lines.length - shown} more lines`);
};

/**
 * What decides the lock `bun install` writes: the manifests, the lock, Bun's settings and the Bun
 * version the setup action pins. A pull request that changes none of them cannot add drift.
 */
const installInputs = [
  "bun.lock",
  "package.json",
  ":(glob)**/package.json",
  "bunfig.toml",
  ".github/actions/setup/action.yml",
];

/** The tracked install inputs in `checkout`, by path, with their contents. */
const packageFiles = (checkout: string) => {
  const paths = execFileSync("git", ["ls-files", "-z", "--", ...installInputs], {
    cwd: checkout,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  return new Map(
    paths
      .filter((file) => existsSync(join(checkout, file)))
      .map((file) => [file, readFileSync(join(checkout, file), "utf8")]),
  );
};

const baseIndex = process.argv.indexOf("--base");
if (baseIndex === -1) {
  const diff = drift(".");
  if (diff.length === 0) {
    console.log("bun.lock is what `bun install` writes.");
    process.exit(0);
  }
  show(diff);
  console.error(
    `::error file=bun.lock::bun.lock is not what \`bun install\` writes (the diff above). A package.json changed without the lock, often a workspace package's version. ${fix}`,
  );
  process.exit(1);
}

const base = process.argv[baseIndex + 1];
if (base === undefined) {
  console.error("Usage: node scripts/check-lockfile.ts [--base <base checkout>]");
  process.exit(1);
}
const ours = packageFiles(".");
const theirs = packageFiles(base);
const touched = [...new Set([...ours.keys(), ...theirs.keys()])].filter(
  (file) => ours.get(file) !== theirs.get(file),
);
if (touched.length === 0) {
  console.log(
    "This pull request changes no package.json, bun.lock, bunfig.toml or the Bun version in the setup action.",
  );
  process.exit(0);
}

// Lines the base's own drift accounts for, counted, so a line this checkout changes twice needs
// the base to change it twice.
const inherited = new Map<string, number>();
for (const line of changed(drift(base))) inherited.set(line, (inherited.get(line) ?? 0) + 1);
const diff = drift(".");
const added = changed(diff).filter((line) => {
  const count = inherited.get(line) ?? 0;
  if (count > 0) inherited.set(line, count - 1);
  return count === 0;
});
if (added.length === 0) {
  console.log(
    diff.length === 0
      ? "bun.lock is what `bun install` writes."
      : "bun.lock is stale only where the base's is; the beta workflow refreshes it on main.",
  );
  process.exit(0);
}
show(diff);
console.error(
  `::error file=bun.lock::This pull request changes ${touched.join(", ")} but leaves bun.lock different from what \`bun install\` writes (the diff above). ${fix}`,
);
process.exit(1);
