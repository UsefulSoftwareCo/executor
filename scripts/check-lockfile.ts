import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fix = "Run `bun install` and commit bun.lock.";

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
    const result = spawnSync("git", ["diff", "--no-index", "--no-color", lockfile, after], {
      encoding: "utf8",
    });
    return result.stdout.split("\n").slice(4).filter(Boolean);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const changed = (diff: ReadonlyArray<string>) =>
  diff.filter((line) => /^[-+]/.test(line) && !/^(---|\+\+\+) /.test(line));

const show = (lines: ReadonlyArray<string>) => {
  const shown = 40;
  console.error(lines.slice(0, shown).join("\n"));
  if (lines.length > shown) console.error(`… ${lines.length - shown} more lines`);
};

const installInputs = [
  "bun.lock",
  "package.json",
  ":(glob)**/package.json",
  "bunfig.toml",
  ".github/actions/setup/action.yml",
];

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
