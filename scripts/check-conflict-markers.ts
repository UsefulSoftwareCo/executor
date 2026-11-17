/**
 * Fails when a tracked text file holds a line Git writes for a merge conflict: `<<<<<<<`, `|||||||`
 * or `>>>>>>>` alone or followed by a space, or `=======` alone. Run from the repository's root; it
 * names each as `file:line`. Binary files are skipped (`git grep -I`).
 *
 * No tracked file holds such a line on purpose today. A file that must (a fixture, notes on
 * merging) goes in `allowed` with its reason. The cases (e2e/tests/conflict-markers.spec.ts) build
 * their markers at run time, so they need no entry.
 */
import { spawnSync } from "node:child_process";

/** Tracked files allowed to hold conflict markers, each with why. None today. */
const allowed: ReadonlyMap<string, string> = new Map<string, string>([]);

const marker = /^(?:(?:<{7}|\|{7}|>{7})(?: .*)?|={7})\r?$/u;

// `-z` separates file, line number and text with NUL, so no file name is misread.
const grep = spawnSync("git", ["grep", "-I", "-n", "-z", "-E", "^(<{7}|[|]{7}|>{7}|={7})"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
// git grep exits 1 when nothing matches, and above 1 when it fails.
if (grep.error || grep.status === null || grep.status > 1) {
  console.error(`git grep failed: ${grep.error?.message ?? grep.stderr}`);
  process.exit(2);
}

const found = grep.stdout
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => {
    const [file = "", number = "", ...text] = line.split("\0");
    return { file, number, text: text.join("\0") };
  })
  .filter(({ file, text }) => marker.test(text) && !allowed.has(file));

if (found.length) {
  console.error("Leftover merge conflict markers. Resolve each conflict and remove its markers:");
  for (const { file, number, text } of found) console.error(`  ${file}:${number}: ${text}`);
  console.error(
    "A file that must hold such a line goes in `allowed` in scripts/check-conflict-markers.ts.",
  );
  process.exit(1);
}
console.log("No conflict markers in tracked files.");
