import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [committedPath, refreshedPath] = process.argv.slice(2);
if (committedPath === undefined || refreshedPath === undefined) {
  console.error("Usage: node scripts/releases/lock-repair-scope.ts <committed> <refreshed>");
  process.exit(1);
}
const committed = readFileSync(committedPath, "utf8");
const refreshed = readFileSync(refreshedPath, "utf8");

const outOfScope = (why: string, expected: string): never => {
  console.log(why);
  const directory = mkdtempSync(join(tmpdir(), "lock-repair-scope-"));
  try {
    const explained = join(directory, "explained.lock");
    writeFileSync(explained, expected);
    const diff = spawnSync(
      "git",
      ["diff", "--no-index", "--no-color", "-U1", explained, refreshedPath],
      { encoding: "utf8" },
    );
    const lines = diff.stdout.split("\n").slice(4).filter(Boolean);
    console.log(lines.slice(0, 60).join("\n"));
    if (lines.length > 60) console.log(`… ${lines.length - 60} more lines`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  process.exit(3);
};

type Workspace = { readonly name?: unknown; readonly version?: unknown };
const workspaces = (() => {
  try {
    const parsed: { readonly workspaces?: Record<string, Workspace> } = JSON.parse(
      committed.replace(/,(\s*[}\]])/g, "$1"),
    );
    return parsed.workspaces ?? {};
  } catch (error) {
    return outOfScope(`The committed bun.lock could not be read: ${String(error)}`, committed);
  }
})();

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let explained = committed;
const changes: Array<string> = [];
for (const [path, entry] of Object.entries(workspaces)) {
  if (typeof entry.name !== "string" || typeof entry.version !== "string") continue;
  const manifestPath = join(path === "" ? "." : path, "package.json");
  const manifest = ((): { readonly version?: unknown } => {
    try {
      return JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      return outOfScope(
        `${JSON.stringify(manifestPath)}, which bun.lock lists as a workspace, could not be read: ${JSON.stringify(String(error))}`,
        explained,
      );
    }
  })();
  if (typeof manifest.version !== "string" || manifest.version === entry.version) continue;
  const line = new RegExp(
    `(\\n\\s*${escape(JSON.stringify(path))}: \\{\\n\\s*"name": ${escape(JSON.stringify(entry.name))},\\n\\s*"version": )${escape(JSON.stringify(entry.version))}(,\\n)`,
    "g",
  );
  const matches = explained.match(line)?.length ?? 0;
  if (matches !== 1)
    outOfScope(
      `bun.lock has ${matches} version lines for the ${JSON.stringify(path)} workspace, so its change cannot be told apart.`,
      explained,
    );
  explained = explained.replace(line, `$1${JSON.stringify(manifest.version)}$2`);
  changes.push(
    `${JSON.stringify(path)}: ${JSON.stringify(entry.version)} -> ${JSON.stringify(manifest.version)}`,
  );
}

if (explained !== refreshed)
  outOfScope(
    changes.length === 0
      ? "The refresh changes bun.lock, but no workspace version: these lines are a dependency change."
      : `Besides ${changes.join(", ")}, the refresh changes these lines, a dependency change:`,
    explained,
  );
console.log(changes.join("\n"));
