// One-line-per-failure digest of the last e2e run: reads
// runs/<target>/<slug>/result.json and prints pass/fail counts plus each
// failure's scenario name. `bun run summary [target...]` (default: all).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runsDir = fileURLToPath(new URL("../runs/", import.meta.url));

const targets =
  process.argv.length > 2
    ? process.argv.slice(2)
    : readdirSync(runsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

for (const target of targets) {
  const targetDir = join(runsDir, target);
  let slugs: string[];
  try {
    slugs = readdirSync(targetDir);
  } catch {
    console.log(`${target}: no runs`);
    continue;
  }
  const failures: { scenario: string; endedAt: string }[] = [];
  let passed = 0;
  for (const slug of slugs) {
    try {
      const result = JSON.parse(readFileSync(join(targetDir, slug, "result.json"), "utf8"));
      if (result.ok) passed++;
      else failures.push({ scenario: result.scenario ?? slug, endedAt: result.endedAt ?? "?" });
    } catch {
      // No result.json (partial run dir) — not a verdict either way.
    }
  }
  console.log(`${target}: ${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.log(`  FAIL ${failure.scenario} (${failure.endedAt})`);
}
