import { spawnSync } from "node:child_process";

const allowed: ReadonlyMap<string, string> = new Map<string, string>([]);

const marker = /^(?:(?:<{7}|\|{7}|>{7})(?: .*)?|={7})\r?$/u;

const grep = spawnSync("git", ["grep", "-I", "-n", "-z", "-E", "^(<{7}|[|]{7}|>{7}|={7})"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
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
